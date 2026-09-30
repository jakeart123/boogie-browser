// Long-running work (imports, duplicate scans) with progress events and cancel.
import { randomUUID } from 'node:crypto';
import type { ImportOptions, JobProgress } from '../../shared/types';
import { errorMessage, throttle, type Throttled } from './util';

export interface JobHandle {
  readonly signal: AbortSignal;
  progress(done: number, total: number): void;
  label(text: string): void;
}

interface JobRecord {
  progress: JobProgress;
  abort: AbortController;
  scope: string | null;
  done: Promise<void>;
  send: Throttled<[]>;
}

const KEEP_FINISHED = 30;

export class JobManager {
  private jobs = new Map<string, JobRecord>();

  constructor(private emit: (p: JobProgress) => void) {}

  /**
   * Start `run` in the background and return the job id. `scope` (a library id) lets the
   * service cancel everything that belongs to a library when it closes.
   */
  start(
    kind: JobProgress['kind'],
    label: string,
    run: (h: JobHandle) => Promise<unknown>,
    opts: { scope?: string; options?: ImportOptions } = {},
  ): string {
    const { jobId, result } = this.launch(kind, label, run, opts);
    result.catch(() => undefined); // the failure is in the job's progress
    return jobId;
  }

  /** Like start, for callers that also want the result (a paste or a bookmark returns it directly). */
  launch<T>(
    kind: JobProgress['kind'],
    label: string,
    run: (h: JobHandle) => Promise<T>,
    opts: { scope?: string; options?: ImportOptions } = {},
  ): { jobId: string; result: Promise<T> } {
    const jobId = randomUUID();
    const abort = new AbortController();
    const progress: JobProgress = {
      jobId,
      kind,
      label,
      done: 0,
      total: 0,
      state: 'running',
      error: null,
      ...(opts.options ? { options: opts.options } : {}),
    };
    const send = throttle(() => this.emit({ ...progress }), 250);
    const handle: JobHandle = {
      signal: abort.signal,
      progress(done, total) {
        progress.done = done;
        progress.total = total;
        send();
      },
      label(text) {
        progress.label = text;
        send();
      },
    };
    const record: JobRecord = {
      progress,
      abort,
      scope: opts.scope ?? null,
      send,
      done: Promise.resolve(),
    };
    this.jobs.set(jobId, record);
    this.emit({ ...progress });

    const result = (async () => {
      try {
        const value = await run(handle);
        progress.result = value;
        progress.state = abort.signal.aborted ? 'cancelled' : 'done';
        return value;
      } catch (e) {
        progress.state = abort.signal.aborted ? 'cancelled' : 'failed';
        progress.error = abort.signal.aborted ? null : errorMessage(e);
        throw e;
      } finally {
        send.cancel();
        this.emit({ ...progress });
        this.prune();
      }
    })();
    record.done = result.then(
      () => undefined,
      () => undefined,
    );
    return { jobId, result };
  }

  list(): JobProgress[] {
    return [...this.jobs.values()].map((j) => ({ ...j.progress }));
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.abort.abort();
  }

  /** Abort every job of a scope (or only those of some kinds) and wait for them to stop. */
  async cancelScope(scope: string, kinds?: JobProgress['kind'][]): Promise<void> {
    const mine = [...this.jobs.values()].filter(
      (j) =>
        j.scope === scope &&
        j.progress.state === 'running' &&
        (!kinds || kinds.includes(j.progress.kind)),
    );
    for (const j of mine) j.abort.abort();
    await Promise.all(mine.map((j) => j.done));
  }

  /** Wait for every running job (used by tests and by close). */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  abortAll(): void {
    for (const j of this.jobs.values()) j.abort.abort();
  }

  private prune(): void {
    const finished = [...this.jobs.entries()].filter(([, j]) => j.progress.state !== 'running');
    for (const [id] of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)))
      this.jobs.delete(id);
  }
}
