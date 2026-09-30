// mtime.json batcher (format-spec 8, live-behavior 2.1 and 4.1).
//
// This file is what makes a change show up in the partner's running Eagle (and survive its next save):
// Eagle notices item edits ONLY through `mtime.json[id]` going up. So every item write, create,
// rename and move-in queues a raise here, and a flush writes the whole file ~1 s after the last one.
//
// mtime.json is not journaled: undo re-raises it anyway, and it can be megabytes.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic';
import { LibraryUnreadableError } from './errors';
import { isItemId } from './ids';
import { serialize } from './json';
import { MTIME_FILE, imagesDir } from './paths';
import { readMtimeDoc } from './read';

/** Up to this many item folders we recount `all` for real (stat each metadata.json); bigger libraries trust the file's own `all` plus our changes. */
const REAL_COUNT_MAX_DIRS = 30_000;
const REAL_COUNT_EVERY_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 5_000;
/** A background flush that keeps failing this long is reported. Shorter failures are usually a sync in progress. */
const REPORT_AFTER_MS = 60_000;
/** How long written raises are remembered for `recent()` (a partner Eagle's rewrite lands within seconds). */
const REMEMBER_WRITTEN_MS = 60_000;

export interface MtimeOptions {
  root: string;
  /** Quiet time after the last raise before writing (default 1000). */
  delayMs?: number;
  /** Never wait longer than this after the first queued raise, even during a long import (default 10000). */
  maxWaitMs?: number;
  /** Called with the path of every file this batcher writes (for the watcher's echo suppression). */
  onWrite?: (relPath: string) => void;
  onError?: (err: unknown) => void;
  /** A background flush failing this long is reported (default 60000). */
  reportAfterMs?: number;
}

interface Snapshot {
  raises: Map<string, number>;
  created: Set<string>;
  delta: number;
}

/** One raise that reached mtime.json (kept a minute). */
export interface RaiseInfo {
  /** The value we wrote. */
  value: number;
  /** When we wrote it (our clock). */
  at: number;
  /** A new item of ours (its folder was created, not edited). */
  created: boolean;
  /** mtime.json had no entry for this id before the raise. */
  newEntry: boolean;
}

export class MtimeBatcher {
  private raises = new Map<string, number>();
  private created = new Set<string>();
  private delta = 0; // items added (+) or moved out (-) since the last flush
  private timer: NodeJS.Timeout | null = null;
  private firstQueuedAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private lastRealCountAt = 0;
  private failingSince = 0;
  private reported: unknown = null; // the error we reported, until a write works again
  private closed = false;
  /** id -> what we wrote for it (kept a minute; oldest first). */
  private written = new Map<string, RaiseInfo>();
  /** The file's entries as last read or written, keyed by its stat, so `entryFor` rarely parses. */
  private cache: { sig: string; map: Record<string, number> } | null = null;
  private cacheLoad: Promise<{ sig: string; map: Record<string, number> }> | null = null;
  private readonly delayMs: number;
  private readonly maxWaitMs: number;
  private readonly reportAfterMs: number;

  constructor(private readonly opts: MtimeOptions) {
    this.delayMs = opts.delayMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
    this.reportAfterMs = opts.reportAfterMs ?? REPORT_AFTER_MS;
  }

  /** Queue `mtime.json[id] = lastModified` (only ever raised). `created` also counts the item in `all`. */
  raise(id: string, lastModified: number, opts: { created?: boolean } = {}): void {
    const lm = Math.trunc(lastModified);
    this.raises.set(id, Math.max(this.raises.get(id) ?? 0, lm));
    if (opts.created) {
      this.delta += 1;
      this.created.add(id);
    }
    this.queued();
  }

  /** The number of items changed without an entry to raise (an item folder moved out or back). */
  adjustCount(delta: number): void {
    this.delta += delta;
    this.queued();
  }

  /**
   * What mtime.json holds for `id` right now (0 if nothing). A new lastModified must go above it,
   * or the raise is a no-op and the partner's Eagle, which only reacts to a value going up, never looks.
   */
  async entryFor(id: string): Promise<number> {
    let sig: string;
    try {
      sig = statSig(await stat(join(this.opts.root, MTIME_FILE)));
    } catch {
      return 0;
    }
    if (this.cache?.sig !== sig) {
      this.cacheLoad ??= readMtimeDoc(this.opts.root)
        .then((r) => ({ sig, map: r.status === 'ok' ? r.map : {} }))
        .finally(() => (this.cacheLoad = null));
      this.cache = await this.cacheLoad;
    }
    return this.cache.map[id] ?? 0;
  }

  private queued(): void {
    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now();
    this.arm(this.delayMs);
  }

  private arm(delay: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstQueuedAt + this.maxWaitMs - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => {
        // The raises were put back, so keep trying. Say so once it has gone on for a while.
        this.failingSince ||= Date.now();
        if (!this.reported && Date.now() - this.failingSince >= this.reportAfterMs) {
          this.reported = err ?? new Error('unknown error');
          this.opts.onError?.(err);
        }
        this.arm(RETRY_AFTER_ERROR_MS);
      });
    }, wait);
  }

  /** Write everything queued so far. Resolves when it is on disk; rejects (and keeps the raises) if the write failed. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.doFlush());
    this.chain = run.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.flush();
    } finally {
      this.closed = true;
    }
  }

  /** Ids whose raise reached mtime.json in the last `withinMs` (at most a minute back). */
  recent(withinMs: number): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [id, w] of this.written) if (now - w.at <= withinMs) out.push(id);
    return out;
  }

  /** The value we wrote for `id` in the last minute, so a watcher can tell our raise from someone else's. */
  valueFor(id: string): number | undefined {
    return this.written.get(id)?.value;
  }

  /** What we wrote for `id` in the last minute (service/partner uses it to judge a foreign rewrite). */
  infoFor(id: string): RaiseInfo | undefined {
    const w = this.written.get(id);
    return w ? { ...w } : undefined;
  }

  /** The error behind a flush that has kept failing (reported through onError), until one works again. */
  problem(): unknown {
    return this.reported;
  }

  private take(): Snapshot | null {
    if (this.raises.size === 0 && this.delta === 0) return null;
    const snap = { raises: this.raises, created: this.created, delta: this.delta };
    this.raises = new Map();
    this.created = new Set();
    this.delta = 0;
    this.firstQueuedAt = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return snap;
  }

  private putBack(snap: Snapshot): void {
    for (const [id, v] of snap.raises) this.raises.set(id, Math.max(this.raises.get(id) ?? 0, v));
    for (const id of snap.created) this.created.add(id);
    this.delta += snap.delta;
    this.firstQueuedAt ||= Date.now();
  }

  private async doFlush(): Promise<void> {
    const snap = this.take();
    if (!snap) return;
    try {
      await this.write(snap);
      this.failingSince = 0;
      this.reported = null;
    } catch (err) {
      this.putBack(snap);
      throw err;
    }
  }

  private async write(snap: Snapshot): Promise<void> {
    const path = join(this.opts.root, MTIME_FILE);
    const cur = await readMtimeDoc(this.opts.root, 3);
    // Content we can't parse holds other people's entries (maybe mid-download): never write over it.
    if (cur.status === 'corrupt') throw new LibraryUnreadableError(path, cur.reason);
    const existing = cur.status === 'ok' ? cur.value : {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    // Existing keys keep their place, new ones go in before `all`, and `all` stays last.
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existing)) if (k !== 'all') next[k] = v;
    for (const [id, v] of snap.raises) next[id] = Math.max(num(existing[id]), v);
    next.all = await this.countAll(
      typeof existing.all === 'number' ? existing.all : null,
      snap.delta,
    );

    const afterText = serialize(next);
    if (cur.status === 'ok' && afterText === cur.text) return;
    // Remembered before the write, so a watcher that looks mid-write already knows these values are
    // ours (a flush can come 10 s after the item writes, too late for their own write marks).
    const now = Date.now();
    for (const [id, value] of snap.raises) {
      this.written.delete(id); // re-inserted, so the map stays oldest first and prunes from the front
      // Ours, not a higher value someone else put there.
      this.written.set(id, {
        at: now,
        value,
        created: snap.created.has(id),
        newEntry: typeof existing[id] !== 'number',
      });
    }
    for (const [id, w] of this.written) {
      if (now - w.at <= REMEMBER_WRITTEN_MS) break;
      this.written.delete(id);
    }
    this.opts.onWrite?.(MTIME_FILE); // before, so a watcher firing mid-write already sees it
    await writeFileAtomic(path, afterText, { syncDir: true });
    this.opts.onWrite?.(MTIME_FILE); // after, so the time is not older than the file's
    try {
      const map: Record<string, number> = {};
      for (const [k, v] of Object.entries(next)) if (typeof v === 'number') map[k] = v;
      this.cache = { sig: statSig(await stat(path)), map };
    } catch {
      this.cache = null; // entryFor reads it again
    }
  }

  /**
   * `all` = item folders that have a metadata.json (trashed ones included). Small libraries get a
   * real recount at most once a minute. Big ones (85k items, a slow disk) would need 85k stats, so
   * they trust the `all` already in the file (Eagle keeps it right) plus what we added or removed.
   */
  private async countAll(fileAll: number | null, delta: number): Promise<number> {
    const stale = Date.now() - this.lastRealCountAt > REAL_COUNT_EVERY_MS;
    if (fileAll !== null && (!stale || fileAll > REAL_COUNT_MAX_DIRS))
      return Math.max(0, fileAll + delta);
    let names: string[];
    try {
      names = await readdir(imagesDir(this.opts.root));
    } catch {
      return Math.max(0, (fileAll ?? 0) + delta);
    }
    const dirs = names.filter((n) => n.endsWith('.info') && isItemId(n.slice(0, -5)));
    this.lastRealCountAt = Date.now();
    if (dirs.length > REAL_COUNT_MAX_DIRS)
      return Math.max(0, fileAll !== null ? fileAll + delta : dirs.length);
    let count = 0;
    let i = 0;
    const worker = async () => {
      while (i < dirs.length) {
        const d = dirs[i++];
        try {
          await stat(join(imagesDir(this.opts.root), d, 'metadata.json'));
          count++;
        } catch {
          /* no metadata.json: not an item (yet) */
        }
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
    return count;
  }
}

/** Changes whenever the file is replaced or rewritten (Eagle and we both replace it by rename). */
const statSig = (st: { ino: number; size: number; mtimeMs: number }) =>
  `${st.ino}:${st.size}:${st.mtimeMs}`;
