// Filling the index from the library's files: the first scan, the sync after every open, targeted
// refreshes from watcher hints, and the slow stat pass (verify). Reads run in parallel; one writer
// puts them into SQLite in short transactions so the main thread never stalls for long.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EagleItemRecord, EagleRootRecord } from '../../shared/types';
import type { EagleLibrary, IndexDelta, ScanProgress } from '../contracts';
import type { Statements } from './statements';

/** The file-system questions the index asks; injectable so a synthetic in-memory library needs no disk. */
export interface IndexFs {
  /** stat mtimeMs (truncated) of `<itemDir>/metadata.json`, or 0 when it can't be stat'ed. */
  metaMtime(itemDir: string): Promise<number>;
  dirExists(itemDir: string): Promise<boolean>;
  /** A folder's mtime and size (changes when an entry is added, removed or renamed), or null. */
  dirStamp(dir: string): Promise<{ key: string; mtimeMs: number } | null>;
}

/**
 * What this index returns: the contract's IndexDelta with `firstScan` always set. It is true while
 * the first full scan is unfinished (new db, or an earlier scan was interrupted): every item then
 * shows up as `added`, which is not "someone changed the library", so don't log it as history.
 */
export type SyncDelta = IndexDelta & { firstScan: boolean };

export interface VerifyOptions {
  signal?: AbortSignal;
  /** Called with each batch of corrections as they are found (the returned delta is the sum). */
  onDelta?: (delta: IndexDelta) => void;
  /** Stats per round. Default 200. */
  chunk?: number;
  /** Pause between rounds so an HDD library stays usable. Default 50 ms. */
  pauseMs?: number;
}

export const realFs: IndexFs = {
  async metaMtime(itemDir) {
    try {
      return Math.trunc((await stat(join(itemDir, 'metadata.json'))).mtimeMs);
    } catch {
      return 0;
    }
  },
  async dirExists(itemDir) {
    try {
      await stat(itemDir);
      return true;
    } catch {
      return false;
    }
  },
  async dirStamp(dir) {
    try {
      const st = await stat(dir);
      return { key: `${Math.trunc(st.mtimeMs)}:${st.size}`, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
};

/**
 * A folder modified this recently may still change within the same clock tick (exFAT keeps 10 ms,
 * FAT 2 s), so its stamp can't prove "unchanged" later.
 */
const RACY_MS = 3000;
/** Even with an unchanged images/ stamp, list it again at least this often. */
const LIST_AT_LEAST_EVERY_MS = 24 * 3600_000;

const MAX_UNREADABLE = 2000;

/**
 * While scanning, one SQLite transaction (commit included) should take about this long before the
 * event loop gets to run again: the index lives on Electron's main thread, and longer blocks stall
 * IPC and thumbnails. Most of the cost is the commit, where FTS5 writes its trigram segment, so
 * the number of records per transaction is learned from the last ones, not timed inside.
 */
const SLICE_MS = 25;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
/** A sync that reads more records than this runs with SQLite's syncs off (see relaxSyncs). */
const BIG_LOAD = 1000;

/** fsync a file on the thread pool, so the main thread never waits on the disk. */
async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, 'r+').catch(() => null); // no -wal file is fine
  if (!fh) return;
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

interface Loaded {
  rec: EagleItemRecord;
  text: string;
  mt: number;
}

interface LoadOptions {
  concurrency: number;
  batchSize: number;
  /** Keep before/after text for the delta. Off during a first scan (85k texts is pointless memory). */
  trackText: boolean;
  /** Ids that failed to read at this metadata.json mtime: not worth another try until the file changes. */
  guard?: Record<string, number>;
  /** Stat the item folder when a read fails, to tell "deleted" from "unreadable right now". */
  checkGone?: boolean;
  /** mtime.json: a record read with a lastModified below its entry here is an older copy (see `behind`). */
  mtimeIndex?: Record<string, number>;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
}

interface LoadResult {
  added: string[];
  changed: string[];
  texts: IndexDelta['changedText'];
  /** id -> metadata.json mtime at the failed read. */
  failed: Map<string, number>;
  gone: string[];
  /** Read fine, but older than mtime.json says: the newer file hasn't arrived yet (Dropbox order). */
  behind: string[];
  aborted: boolean;
}

export type Outcome =
  | { kind: 'added' | 'same'; before: null }
  | { kind: 'changed'; before: string }
  | { kind: 'same'; before: string };

/** What the loader needs from the index it fills (SqliteLibraryIndex's own row writes). */
export interface LoadHost {
  closed(): boolean;
  meta(key: string): string | null;
  tx<T>(fn: () => T): T;
  /** Returns false when this exact root text is already indexed. */
  applyRoot(root: EagleRootRecord, text: string): boolean;
  /** Insert or update one item. Runs inside tx. */
  applyOne(rec: EagleItemRecord, text: string, metaMtime: number): Outcome;
  /** Delete items; optionally add their old text to `delta`. */
  remove(ids: string[], trackText: boolean, delta: IndexDelta): void;
}

export class IndexLoader {
  /** How long writing one scanned record takes on this machine (commit included), learned as it goes. */
  private msPerRecord = 0.2;
  /** SQLite syncs are off for a big load (see relaxSyncs). */
  private relaxed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly st: Statements,
    private readonly fs: IndexFs,
    private readonly host: LoadHost,
    private readonly concurrency: number,
    private readonly batchSize: number,
  ) {}

  async sync(
    lib: EagleLibrary,
    onProgress?: (p: ScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<SyncDelta> {
    signal?.throwIfAborted();
    const firstScan = this.firstScanPending();
    const delta = emptyDelta(firstScan);

    const rootDoc = await lib.readRoot();
    delta.rootChanged = this.host.applyRoot(rootDoc.value, rootDoc.text);

    // Like Eagle: trust the db, re-read only new ids and ids whose mtime.json entry got newer. If mtime.json is
    // byte-for-byte what we saw last time, its entries were already acted on, so skip the comparison.
    const mtimeIndex = await lib.readMtimeIndex().catch(() => ({}) as Record<string, number>);
    const mtimeHash = createHash('sha1').update(JSON.stringify(mtimeIndex)).digest('hex');
    const hintsAreNew = mtimeHash !== this.host.meta('mtime_json_text_hash');

    // Listing images/ costs seconds on a slow drive (6 s for 85k folders on USB exFAT). When neither
    // images/ (an item folder added, removed or renamed) nor mtime.json changed since the last
    // listing, the folders are the ones we know: indexed, or known to be unreadable.
    const known = new Map(this.st.knownLastModified.all() as [string, number][]);
    const stamp = await this.fs.dirStamp(join(lib.root, 'images'));
    const listedAt = Date.now();
    let dirIds: string[];
    if (!firstScan && !hintsAreNew && this.imagesUnchanged(stamp, listedAt)) {
      dirIds = [...known.keys(), ...Object.keys(this.unreadable()).filter((id) => !known.has(id))];
    } else {
      this.st.delMeta.run('images_dir_stamp');
      dirIds = await lib.listItemIds();
    }
    guardEmptyListing(dirIds, known.size);
    const inDir = new Set(dirIds);

    const gone = [...known.keys()].filter((id) => !inDir.has(id));
    if (gone.length) this.host.remove(gone, !firstScan, delta);

    const rereads = new Set<string>();
    const toRead: string[] = [];
    for (const id of dirIds) {
      const lastModified = known.get(id);
      if (lastModified === undefined) toRead.push(id);
      else if (hintsAreNew && typeof mtimeIndex[id] === 'number' && mtimeIndex[id] > lastModified) {
        toRead.push(id);
        rereads.add(id);
      }
    }
    // Eagle ids start with the creation time in base 36, so on a first scan reading them in
    // descending order fills the default newest-first view from the top.
    if (firstScan) toRead.sort().reverse();

    if (toRead.length) onProgress?.({ done: 0, total: toRead.length });
    const relaxed = toRead.length > BIG_LOAD && this.relaxSyncs();
    let res: LoadResult;
    try {
      res = await this.loadAndApply(lib, toRead, {
        concurrency: this.concurrency,
        batchSize: this.batchSize,
        trackText: !firstScan,
        guard: this.unreadable(),
        mtimeIndex,
        onProgress,
        signal,
      });
    } finally {
      if (relaxed) await this.restoreSyncs();
    }
    mergeLoad(delta, res);
    if (res.aborted) throw signal?.reason ?? new DOMException('Aborted', 'AbortError');

    const stillBad: Record<string, number> = {};
    for (const [id, mt] of res.failed) if (!known.has(id)) stillBad[id] = mt;
    this.saveUnreadable(stillBad);
    // mtime.json may arrive before the item files it points at (Dropbox has no order). While a
    // re-read failed or found an older copy, this mtime.json is not handled yet: the next sync
    // (a restart) must look at those ids again.
    const pending = res.behind.length > 0 || [...res.failed.keys()].some((id) => rereads.has(id));
    if (!pending) this.st.setMeta.run('mtime_json_text_hash', mtimeHash);
    // Stamped before the listing, so a change during or after it shows as a different stamp.
    if (stamp && listedAt - stamp.mtimeMs > RACY_MS && this.host.meta('images_dir_stamp') === null)
      this.st.setMeta.run('images_dir_stamp', JSON.stringify({ key: stamp.key, at: listedAt }));
    if (firstScan) {
      this.st.setMeta.run('last_full_scan', String(Date.now()));
      // Give the query planner real statistics once, after the big insert.
      if (res.added.length > 500) this.db.exec('ANALYZE');
    }
    return delta;
  }

  async refresh(
    lib: EagleLibrary,
    hint: { ids?: string[]; root?: boolean; listDir?: boolean },
  ): Promise<SyncDelta> {
    const delta = emptyDelta(this.firstScanPending());
    if (hint.root) {
      const doc = await lib.readRoot();
      delta.rootChanged = this.host.applyRoot(doc.value, doc.text);
    }

    const want = new Set(hint.ids ?? []);
    if (hint.listDir) {
      const dirIds = await lib.listItemIds();
      const known = new Set(
        (this.st.knownLastModified.all() as [string, number][]).map(([id]) => id),
      );
      guardEmptyListing(dirIds, known.size);
      const inDir = new Set(dirIds);
      for (const id of dirIds) if (!known.has(id)) want.add(id);
      const gone = [...known].filter((id) => !inDir.has(id));
      if (gone.length) this.host.remove(gone, true, delta);
      for (const id of gone) want.delete(id);
    }

    const ids = [...want];
    const res = await this.loadAndApply(lib, ids, {
      concurrency: this.concurrency,
      batchSize: this.batchSize,
      trackText: true,
      checkGone: true,
    });
    mergeLoad(delta, res);
    const gone = new Set(res.gone);
    const indexedGone = [...gone].filter((id) => this.st.byId.get(id));
    if (indexedGone.length) {
      // Hinted folders that vanished may be the whole library gone (drive unplugged, folder
      // renamed away): that is not a deletion, so check the listing like the listDir path does.
      guardEmptyListing(await lib.listItemIds(), this.st.itemCount.get() as number);
      this.host.remove(indexedGone, true, delta);
    }

    // Keep the "couldn't read" list honest for the ids we just tried (and only rewrite it if it changed).
    const before = this.unreadable();
    const bad = { ...before };
    for (const id of ids) delete bad[id];
    for (const [id, mt] of res.failed) if (!this.st.byId.get(id) && !gone.has(id)) bad[id] = mt;
    const keys = Object.keys(bad);
    if (keys.length !== Object.keys(before).length || keys.some((k) => before[k] !== bad[k]))
      this.saveUnreadable(bad);
    return delta;
  }

  /**
   * Slow background pass: stat every metadata.json and re-read the ones whose mtime differs from what we
   * indexed. Catches edits that never raised mtime.json. Throttled, and stops quietly when aborted or closed.
   */
  async verify(lib: EagleLibrary, opts: VerifyOptions = {}): Promise<SyncDelta> {
    const { signal, onDelta, chunk = 200, pauseMs = 50 } = opts;
    const firstScan = this.firstScanPending();
    const total = emptyDelta(firstScan);
    const rows = this.st.knownMetaMtime.all() as [string, number][];
    for (let i = 0; i < rows.length; i += chunk) {
      if (this.host.closed() || signal?.aborted) break;
      const part = rows.slice(i, i + chunk);
      const mtimes = await Promise.all(part.map(([id]) => this.fs.metaMtime(lib.itemDir(id))));
      const stale = part
        .filter(([, indexed], j) => mtimes[j] !== 0 && mtimes[j] !== indexed)
        .map(([id]) => id);
      if (stale.length && !this.host.closed()) {
        const res = await this.loadAndApply(lib, stale, {
          concurrency: 4,
          batchSize: this.batchSize,
          trackText: true,
          signal,
        });
        const found = mergeLoad(emptyDelta(firstScan), res);
        mergeLoad(total, res);
        if (!isEmpty(found)) onDelta?.(found);
      }
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    return total;
  }

  /** images/ has the stamp it had at the last full listing, and that listing is under a day old. */
  private imagesUnchanged(stamp: { key: string; mtimeMs: number } | null, now: number): boolean {
    if (!stamp) return false;
    try {
      const last = JSON.parse(this.host.meta('images_dir_stamp') ?? 'null') as {
        key: string;
        at: number;
      } | null;
      return !!last && last.key === stamp.key && now - last.at < LIST_AT_LEAST_EVERY_MS;
    } catch {
      return false;
    }
  }

  /** Ids in the library folder that could not be read at the last sync (zero-filled or half-synced files). */
  unreadableIds(): string[] {
    return Object.keys(this.unreadable());
  }

  private unreadable(): Record<string, number> {
    try {
      return JSON.parse(this.host.meta('unreadable') ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  }

  private saveUnreadable(list: Record<string, number>): void {
    const entries = Object.entries(list).slice(0, MAX_UNREADABLE);
    if (entries.length)
      this.st.setMeta.run('unreadable', JSON.stringify(Object.fromEntries(entries)));
    else this.st.delMeta.run('unreadable');
  }

  /**
   * Read items with bounded concurrency while one writer puts them into SQLite, `batchSize` or
   * more at a time, in transactions of at most SLICE_MS each with the event loop running in
   * between. Readers wait for the writer only when it falls far behind.
   */
  private async loadAndApply(
    lib: EagleLibrary,
    ids: string[],
    o: LoadOptions,
  ): Promise<LoadResult> {
    const res: LoadResult = {
      added: [],
      changed: [],
      texts: [],
      failed: new Map(),
      gone: [],
      behind: [],
      aborted: false,
    };
    const total = ids.length;
    let next = 0;
    let done = 0;
    let lastEmit = 0;
    let fatal: unknown;
    let queue: Loaded[] = [];

    const apply = ({ rec, text, mt }: Loaded) => {
      const out = this.host.applyOne(rec, text, mt);
      if (out.kind === 'added') {
        res.added.push(rec.id);
        if (o.trackText) res.texts.push({ id: rec.id, before: null, after: text });
      } else if (out.kind === 'changed') {
        res.changed.push(rec.id);
        if (o.trackText) res.texts.push({ id: rec.id, before: out.before, after: text });
      }
      const expected = o.mtimeIndex?.[rec.id];
      if (typeof expected === 'number' && numberOr0(rec.lastModified) < expected)
        res.behind.push(rec.id);
    };
    /** Write while at least `min` records wait. */
    const drain = async (min: number) => {
      while (queue.length && queue.length >= min && !this.host.closed()) {
        const n = Math.min(queue.length, Math.max(10, Math.floor(SLICE_MS / this.msPerRecord)));
        const start = performance.now();
        this.host.tx(() => {
          for (let i = 0; i < n; i++) apply(queue[i]);
        });
        const ms = performance.now() - start;
        this.msPerRecord = Math.max(0.01, 0.7 * this.msPerRecord + (0.3 * ms) / n);
        queue = queue.slice(n);
        await yieldToLoop();
      }
    };
    let writing: Promise<void> | null = null;
    // Never rejects: a write error stops the readers and is thrown at the end.
    const flush = (min: number) =>
      (writing ??= drain(min)
        .catch((e) => {
          fatal ??= e;
          next = total;
        })
        .finally(() => (writing = null)));

    const worker = async () => {
      try {
        for (;;) {
          if (this.host.closed() || o.signal?.aborted) {
            res.aborted = true;
            return;
          }
          const i = next++;
          if (i >= total) return;
          const id = ids[i];
          const dir = lib.itemDir(id);
          const mt = await this.fs.metaMtime(dir);
          if (o.guard?.[id] && o.guard[id] === mt) {
            res.failed.set(id, mt);
          } else {
            let doc: Awaited<ReturnType<EagleLibrary['readItem']>> = null;
            try {
              doc = await lib.readItem(id);
            } catch {
              /* treated like an unreadable file */
            }
            if (doc?.value && doc.value.id === id) {
              queue.push({ rec: doc.value, text: doc.text, mt });
              if (queue.length >= o.batchSize) {
                const w = flush(o.batchSize);
                if (queue.length >= o.batchSize * 4) await w; // don't hold the whole library in memory
              }
            } else {
              res.failed.set(id, mt);
              if (o.checkGone && !(await this.fs.dirExists(dir))) res.gone.push(id);
            }
          }
          done++;
          const now = Date.now();
          if (o.onProgress && (done === total || now - lastEmit >= 100)) {
            lastEmit = now;
            o.onProgress({ done, total });
          }
        }
      } catch (e) {
        fatal ??= e;
        next = total;
      }
    };

    await Promise.all(Array.from({ length: Math.min(o.concurrency, total) }, worker));
    if (writing) await writing;
    if (!this.host.closed()) await flush(1);
    if (fatal) throw fatal;
    return res;
  }

  /** Quitting mid-scan: syncs back on, so the checkpoint that follows syncs everything, flag included. */
  beforeClose(): void {
    if (!this.relaxed) return;
    this.db.pragma('synchronous = NORMAL');
    this.st.delMeta.run('unsynced');
  }

  /**
   * For a big load (the first scan): SQLite's syncs off. In WAL mode every automatic checkpoint
   * otherwise fsyncs on the main thread, which is most of a scan's time and blocks it for 50-150 ms
   * at a stretch. An app crash loses nothing either way; a power cut mid-scan could tear the file,
   * so a flag marks the window and an index opened with the flag still set is rebuilt.
   */
  private relaxSyncs(): boolean {
    // FULL for this one commit: in WAL mode NORMAL doesn't fsync a commit, so after a power cut
    // the flag could be missing while the file is torn.
    this.db.pragma('synchronous = FULL');
    this.st.setMeta.run('unsynced', '1');
    this.db.pragma('synchronous = OFF');
    this.relaxed = true;
    return true;
  }

  /** Syncs back on; the files are fsynced off the main thread before the flag goes. */
  private async restoreSyncs(): Promise<void> {
    if (this.host.closed() || !this.relaxed) return;
    this.db.pragma('synchronous = NORMAL');
    this.relaxed = false;
    await fsyncFile(this.db.name);
    await fsyncFile(`${this.db.name}-wal`);
    if (!this.host.closed()) this.st.delMeta.run('unsynced');
  }

  /** True until the first full scan has finished (a new db, or one whose scan was interrupted). */
  private firstScanPending(): boolean {
    return this.host.meta('last_full_scan') === null;
  }
}

export function emptyDelta(firstScan: boolean): SyncDelta {
  return { added: [], changed: [], removed: [], rootChanged: false, changedText: [], firstScan };
}

const numberOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function isEmpty(d: IndexDelta): boolean {
  return !d.added.length && !d.changed.length && !d.removed.length && !d.rootChanged;
}

function mergeLoad(into: IndexDelta, res: LoadResult): IndexDelta {
  into.added.push(...res.added);
  into.changed.push(...res.changed);
  into.changedText.push(...res.texts);
  return into;
}

/** An empty listing over a non-empty index means the drive or folder is unavailable, not that everything was deleted. */
function guardEmptyListing(dirIds: string[], indexed: number): void {
  if (dirIds.length === 0 && indexed > 0)
    throw new Error("The library's images folder looks empty, so the index was left alone.");
}
