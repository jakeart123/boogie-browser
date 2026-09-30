// Running and finished background jobs (import, index, duplicate scan...), fed by on('job').
// Shared by the status strip and the import / duplicates dialogs. Nothing here polls.
import { api, on } from '../../lib/api';
import { plural, quoted } from '../../lib/format';
import { ui } from '../../lib/stores/ui.svelte';
import type { ImportResult, JobProgress } from '../../../shared/types';

const KEEP = 30;

async function showFolder(dir: string): Promise<void> {
  try {
    await api.showFolder(dir);
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), { kind: 'error' });
  }
}

/** "Importing 12 of 40", "Indexing 1,200 of 85,000", "Finding duplicates…". */
export function jobText(j: JobProgress): string {
  const known = j.total > 0;
  const of = `${j.done.toLocaleString()} of ${j.total.toLocaleString()}`;
  switch (j.kind) {
    case 'import':
      return known ? `Importing ${of}` : 'Importing…';
    case 'index':
      return known ? `Indexing ${of}` : 'Reading the library folder…';
    case 'dupes': {
      // The core relabels the job while it waits for an index or reads another library.
      const stage = j.label && !/^Finding duplicates/i.test(j.label) ? j.label : null;
      if (stage) return known ? `${stage}, ${of}` : `${stage}…`;
      return known ? `Finding duplicates, ${of}` : 'Finding duplicates…';
    }
    case 'hash':
      return known ? `Reading files ${of}` : 'Reading files…';
    case 'thumbnails':
      return known ? `Making thumbnails ${of}` : 'Making thumbnails…';
    case 'export':
      return known ? `Exporting ${of}` : 'Exporting…';
    case 'merge':
      return known ? `Merging ${of}` : 'Merging…';
    default:
      return j.label || 'Working…';
  }
}

export function importResult(j: JobProgress | undefined): ImportResult | null {
  const r = j?.result as Partial<ImportResult> | undefined;
  if (!r || typeof r !== 'object') return null;
  return {
    added: r.added ?? [],
    duplicates: r.duplicates ?? [],
    failed: r.failed ?? [],
    warnings: r.warnings ?? [],
  };
}

class JobsStore {
  /** Newest first. Replace, never mutate. */
  list = $state.raw<JobProgress[]>([]);
  private started = false;
  private handled = new Set<string>();

  running = $derived(this.list.filter((j) => j.state === 'running'));

  byId(id: string | null | undefined): JobProgress | undefined {
    return id ? this.list.find((j) => j.jobId === id) : undefined;
  }

  /** The newest import job, running or finished. */
  latestImport = $derived(this.list.find((j) => j.kind === 'import'));

  /** Idempotent. Call from any component that needs jobs. */
  init(): void {
    if (this.started) return;
    this.started = true;
    on('job', (j) => this.update(j));
    void api
      .listJobs()
      .then((jobs) => {
        for (const j of jobs) if (j.state !== 'running') this.handled.add(j.jobId);
        // Events that arrived while we waited are newer than this snapshot.
        const have = new Set(this.list.map((j) => j.jobId));
        this.list = [...this.list, ...jobs.filter((j) => !have.has(j.jobId)).reverse()].slice(
          0,
          KEEP,
        );
      })
      .catch(() => undefined);
  }

  private update(j: JobProgress): void {
    const known = this.list.some((x) => x.jobId === j.jobId);
    this.list = known
      ? this.list.map((x) => (x.jobId === j.jobId ? j : x))
      : [j, ...this.list].slice(0, KEEP);
    if (j.state !== 'running' && !this.handled.has(j.jobId)) {
      this.handled.add(j.jobId);
      this.finished(j);
    }
  }

  /** What the user should hear when a job ends, unless a dialog already shows it. */
  private finished(j: JobProgress): void {
    if (j.state === 'failed') {
      ui.toast(j.error ? `${jobName(j)} failed. ${j.error}` : `${jobName(j)} failed`, {
        kind: 'error',
        key: j.kind === 'import' ? 'import' : undefined,
      });
      return;
    }
    if (j.state !== 'done') return;
    const watching = ui.dialog?.kind === 'import' || ui.dialog?.kind === 'duplicates';
    if (j.kind === 'import') {
      const r = importResult(j);
      if (!r || watching) return;
      // Same words as the import dialog behind Review: "couldn't be imported", not "failed".
      const bits = [
        r.added.length || !r.failed.length
          ? `Imported ${plural(r.added.length, 'item')}`
          : `Couldn’t import ${plural(r.failed.length, 'file')}`,
      ];
      if (r.duplicates.length)
        bits.push(`${r.duplicates.length.toLocaleString()} already in the library`);
      const warned = r.warnings?.length ?? 0;
      if (warned)
        bits.push(`${warned.toLocaleString()} only as ${warned === 1 ? 'an icon' : 'icons'}`);
      if (r.failed.length && r.added.length)
        bits.push(`${r.failed.length.toLocaleString()} couldn’t be imported`);
      const problem = r.duplicates.length || r.failed.length || warned;
      // A toast, not a dialog: agents import too (through MCP), and that shouldn't cover your screen.
      // "Show the latest import" in the command bar gets back here after the toast is gone.
      ui.toast(bits.join(', '), {
        key: 'import',
        kind: problem ? 'warn' : 'ok',
        ms: problem ? 15_000 : undefined,
        action: problem
          ? { label: 'Review', run: () => ui.openDialog('import', { jobId: j.jobId }) }
          : undefined,
      });
    } else if (j.kind === 'export') {
      // "Add to other library" runs as an export job too; its result names the target library.
      const r = j.result as
        | { dir?: string; copied?: number; skipped?: unknown[]; target?: { name: string } }
        | undefined;
      const skipped = r?.skipped?.length ?? 0;
      const more = skipped ? `, ${skipped.toLocaleString()} skipped` : '';
      if (r?.target) {
        ui.toast(`Added ${plural(r.copied ?? j.done, 'item')} to ${quoted(r.target.name)}${more}`, {
          kind: skipped ? 'warn' : 'ok',
        });
        return;
      }
      const dir = typeof r?.dir === 'string' ? r.dir : null;
      ui.toast(`Exported ${plural(r?.copied ?? j.done, 'item')}${more}`, {
        kind: skipped ? 'warn' : 'ok',
        ms: 10_000,
        action: dir ? { label: 'Show folder', run: () => void showFolder(dir) } : undefined,
      });
    } else if (j.kind === 'dupes' && !watching) {
      const groups = Array.isArray(j.result) ? j.result.length : 0;
      ui.toast(groups ? `Found ${plural(groups, 'group')} of duplicates` : 'No duplicates found', {
        kind: groups ? 'info' : 'ok',
        action: groups
          ? { label: 'Review', run: () => ui.openDialog('duplicates', { jobId: j.jobId }) }
          : undefined,
      });
    }
  }
}

function jobName(j: JobProgress): string {
  return {
    import: 'Import',
    index: 'Indexing',
    dupes: 'The duplicate search',
    hash: 'Reading files',
    thumbnails: 'Thumbnails',
    export: 'Export',
    merge: 'Merge',
  }[j.kind];
}

export const jobs = new JobsStore();
