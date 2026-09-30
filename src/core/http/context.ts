// What every route handler shares: the host, who is calling, waiting for import jobs, and the
// little bit of "recent folders/tags" memory that Eagle's pickers expect.
import type { CoreHost } from '../contracts';
import type { CoreApi } from '../../shared/api';
import type { Actor, JobProgress, LibraryState } from '../../shared/types';
import type { Args } from './util';
import { HttpError } from './util';
import type { CompatPrefs } from './prefs';
import { eagleTags, indexFolders } from './shapes';

export const EXTENSION_ACTOR: Actor = { kind: 'user', name: 'Browser extension' };
export const CLIENT_ACTOR: Actor = { kind: 'agent', name: 'Eagle API client' };

export interface OpenTarget {
  kind: 'item' | 'folder' | 'smart-folder';
  id: string;
}

export interface Req {
  method: 'GET' | 'POST';
  path: string;
  args: Args;
  origin: string | null;
  actor: Actor;
  /** Sent by the browser extension (its port, or an extension Origin): a web page's data. */
  fromExtension: boolean;
}

/** Returns the `data` of the success envelope, or a Reply (util.ts) for anything else. */
export type Handler = (r: Req) => Promise<unknown> | unknown;
export type RouteTable = Record<string, Partial<Record<'GET' | 'POST', Handler>>>;

export interface Ctx {
  host: CoreHost;
  jobs: JobTracker;
  log(msg: string): void;
  onOpen?(t: OpenTarget): void;
  /** How long routes that must return item ids wait for the import job. */
  jobWaitMs: number;
  recentFolders: string[];
  recentTags: string[];
  prefs: CompatPrefs;
}

/** The CoreApi for reads (no attribution needed). */
export const reader = (ctx: Ctx): CoreApi => ctx.host.api;
/** The CoreApi that attributes writes to whoever is calling. */
export const writer = (ctx: Ctx, r: Req): CoreApi => ctx.host.as(r.actor);

export async function needLibrary(ctx: Ctx): Promise<LibraryState> {
  const st = await ctx.host.api.getLibraryState();
  if (!st) throw new HttpError(503, 'No library has been opened yet.');
  return st;
}

/**
 * Eagle's tag objects, and the recent (this session's API use first, then tags.json's history)
 * and starred lists as objects. A listed tag no item carries any more still shows, with 0 items.
 */
export async function tagObjects(ctx: Ctx) {
  const [tags, st] = await Promise.all([ctx.host.api.listTags(), needLibrary(ctx)]);
  const objects = eagleTags(tags, st.tagGroups);
  const byName = new Map(objects.map((o) => [o.name as string, o]));
  const resolve = (names: string[]) =>
    [...new Set(names)].map((n) => byName.get(n) ?? { name: n, imageCount: 0, groups: [] });
  return {
    st,
    objects,
    byName,
    recent: () => resolve([...ctx.recentTags, ...(st.recentTags ?? [])]),
    starred: () => resolve(st.starredTags ?? []),
  };
}

/** Move `ids` to the front of a recent list (newest first), capped. */
export function remember(list: string[], ids: string[], max = 16): void {
  for (const id of [...ids].reverse()) {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    list.unshift(id);
  }
  list.length = Math.min(list.length, max);
}

export async function requireFolder(ctx: Ctx, id: string): Promise<LibraryState> {
  const st = await needLibrary(ctx);
  if (!indexFolders(st.folders).has(id)) throw new HttpError(404, 'Folder does not exist.');
  return st;
}

// ───────────────────────── import jobs ─────────────────────────

const TERMINAL = new Set<JobProgress['state']>(['done', 'failed', 'cancelled']);
const isTerminal = (j: JobProgress) => TERMINAL.has(j.state);

/** Imports run as jobs. A few routes (v2 item/add, addFromPath) must answer with the new item
 * id, so they wait here for the job to finish, with a cap. */
export class JobTracker {
  private seen = new Map<string, JobProgress>();
  private wakers = new Set<() => void>();
  private off: () => void;
  private closed = false;

  constructor(private host: CoreHost) {
    // Subscribed for the whole server life so a job that finishes before we look is not missed.
    this.off = host.on('job', (p) => {
      this.seen.set(p.jobId, p);
      if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value as string);
      for (const w of [...this.wakers]) w();
    });
  }

  /** The finished job, 'running' when it is still going at the deadline, or null when the app
   * no longer knows it. */
  async wait(jobId: string, ms: number): Promise<JobProgress | 'running' | null> {
    const start = Date.now();
    const deadline = start + ms;
    while (!this.closed) {
      const s = this.seen.get(jobId);
      if (s && isTerminal(s)) return s;
      // Job events are throttled, so ask the host directly too.
      const listed = (await this.host.api.listJobs()).find((j) => j.jobId === jobId);
      if (!listed) return null;
      if (isTerminal(listed)) return listed;
      const left = deadline - Date.now();
      if (left <= 0) return 'running';
      // Poll gently: quickly at first, slower for long imports.
      await this.pause(Math.min(left, 100 + Math.min(900, (Date.now() - start) / 10)));
    }
    return null;
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  close(): void {
    this.closed = true;
    this.off();
    for (const w of [...this.wakers]) w();
  }
}
