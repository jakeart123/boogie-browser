// The SQLite index for one library: the root and folder caches, item row writes, change tracking,
// reads, counts and hashes. A disposable cache: the library's JSON files are the only truth, so
// anything odd here is fixed by deleting the .sqlite file. Opening it is in open.ts, filling it
// from the files in load.ts, its SQL in statements.ts and the sidebar numbers in counts.ts.
import type Database from 'better-sqlite3';
import type { Counts, EagleItemRecord, EagleRootRecord, TagInfo } from '../../shared/types';
import type { EagleLibrary, IndexDelta, LibraryIndex, ScanProgress } from '../contracts';
import { computeCounts, hasLocked, numberFolders, tagInfos, type FolderNumbers } from './counts';
import { flattenFolders } from './folders';
import {
  emptyDelta,
  IndexLoader,
  realFs,
  type IndexFs,
  type Outcome,
  type SyncDelta,
  type VerifyOptions,
} from './load';
import { projectRecord, type FolderText, type ProjectedRecord } from './project';
import { prepare, registerFunctions, type Statements } from './statements';

export type { IndexFs, SyncDelta, VerifyOptions } from './load';

export interface IndexOpenOptions {
  /** Where the .sqlite files live. Default `<appPaths().cache>/index`. */
  dir?: string;
  /** Parallel item reads during a scan. Default 32 (fine for an SSD). */
  concurrency?: number;
  /** Records read before they are written to SQLite while scanning. Default 250. */
  batchSize?: number;
  fs?: Partial<IndexFs>;
}

export interface HashRow {
  id: string;
  size: number;
  md5: string | null;
  dhash: string | null;
  /** mtime of the original when hashed. A hash is only valid while size and fileMtime still match the file. */
  fileMtime: number;
  computedAt: number;
}

type FileFacts = { ext: string; width: number | null; height: number | null; size: number };

/** Item rowids kept for changedRowidsSince (the query engine's incremental smart folder counts). */
const CHANGE_LOG_MAX = 10_000;

export class SqliteLibraryIndex implements LibraryIndex {
  readonly db: Database.Database;
  readonly libraryId: string;
  private readonly st: Statements;
  private readonly loader: IndexLoader;
  private closed = false;
  /** Folders in the current tree: id -> name and description, and id -> [itself and every ancestor]. */
  private folderText = new Map<string, FolderText>();
  private ancestors = new Map<string, string[]>();
  private numbered: FolderNumbers | null = null;
  private countsCache: { key: string; value: Counts } | null = null;
  /**
   * What changed since this index was opened, for the query engine's caches: `palette` moves when
   * any item's palette rows do, `root` when the root record does, and `changeLog` holds the rowid
   * of every item row written or removed (the last CHANGE_LOG_MAX, from sequence `logBase` on).
   */
  private paletteVersion = 0;
  private rootVersion = 0;
  private changeLog: number[] = [];
  private logBase = 0;

  constructor(db: Database.Database, libraryId: string, opts: IndexOpenOptions = {}) {
    this.db = db;
    this.libraryId = libraryId;
    registerFunctions(db);
    this.st = prepare(db);
    const fs: IndexFs = { ...realFs, ...opts.fs };
    this.loader = new IndexLoader(
      db,
      this.st,
      fs,
      {
        closed: () => this.closed,
        meta: (key) => this.getMeta(key),
        tx: (fn) => this.tx(fn),
        applyRoot: (root, text) => this.applyRoot(root, text),
        applyOne: (rec, text, mt) => this.applyOne(rec, text, mt),
        remove: (ids, trackText, delta) => this.removeWithDelta(ids, trackText, delta),
      },
      Math.max(1, opts.concurrency ?? 32),
      Math.max(1, opts.batchSize ?? 250),
    );
    this.loadFolderCaches();
  }

  // ───────────────────────── Root ─────────────────────────

  setRoot(root: EagleRootRecord): void {
    this.assertOpen();
    this.applyRoot(root, JSON.stringify(root));
  }

  getRoot(): EagleRootRecord | null {
    const text = this.getMeta('root_text');
    if (!text) return null;
    try {
      return JSON.parse(text) as EagleRootRecord;
    } catch {
      return null;
    }
  }

  /** Returns false when this exact root text is already indexed. */
  private applyRoot(root: EagleRootRecord, text: string): boolean {
    const prev = this.getMeta('root_text');
    if (prev === text) return false;
    if (prev !== null && sameRecord(prev, text)) {
      this.st.setMeta.run('root_text', text); // only re-formatted
      return false;
    }
    const { folders, closure } = flattenFolders(root.folders);
    const old = this.folderText;
    this.tx(() => {
      this.st.clearClosure.run();
      this.st.clearFolders.run();
      for (const f of folders) this.st.insertFolderRow.run(f);
      for (const c of closure) this.st.insertClosure.run(c);

      // Items are only touched if one of their folders was added, removed, renamed or re-described.
      const changed = new Set<string>();
      for (const f of folders) {
        const was = old.get(f.id);
        if (was?.name !== f.name || was.description !== f.description) changed.add(f.id);
      }
      const now = new Set(folders.map((f) => f.id));
      for (const id of old.keys()) if (!now.has(id)) changed.add(id);
      if (changed.size) {
        const ids = JSON.stringify([...changed]);
        this.st.recountFolders.run(ids);
        this.st.dropFtsFor.run(ids);
        this.st.rebuildFtsFor.run(ids);
        this.st.rebuildSearchFor.run(ids);
      }
      this.st.setMeta.run('root_text', text);
      this.st.setMeta.run('root_modification_time', String(root.modificationTime ?? 0));
    });
    this.rootVersion++;
    this.loadFolderCaches();
    return true;
  }

  private loadFolderCaches(): void {
    this.numbered = null;
    this.folderText = new Map(
      (this.st.folderText.all() as [string, string, string][]).map(([id, name, description]) => [
        id,
        { name, description },
      ]),
    );
    this.ancestors = new Map();
    for (const [descendant, ancestor] of this.st.closurePairs.all() as [string, string][]) {
      const list = this.ancestors.get(descendant);
      if (list) list.push(ancestor);
      else this.ancestors.set(descendant, [ancestor]);
    }
  }

  // ───────────────────────── Loading from the library (load.ts) ─────────────────────────

  sync(
    lib: EagleLibrary,
    onProgress?: (p: ScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<SyncDelta> {
    this.assertOpen();
    return this.loader.sync(lib, onProgress, signal);
  }

  refresh(
    lib: EagleLibrary,
    hint: { ids?: string[]; root?: boolean; listDir?: boolean },
  ): Promise<SyncDelta> {
    this.assertOpen();
    return this.loader.refresh(lib, hint);
  }

  /**
   * Slow background pass: stat every metadata.json and re-read the ones whose mtime differs from what we
   * indexed. Catches edits that never raised mtime.json. Throttled, and stops quietly when aborted or closed.
   */
  verify(lib: EagleLibrary, opts: VerifyOptions = {}): Promise<SyncDelta> {
    this.assertOpen();
    return this.loader.verify(lib, opts);
  }

  /** Ids in the library folder that could not be read at the last sync (zero-filled or half-synced files). */
  unreadableIds(): string[] {
    return this.loader.unreadableIds();
  }

  // ───────────────────────── Writing item rows ─────────────────────────

  upsertRecords(records: EagleItemRecord[]): void {
    this.assertOpen();
    this.tx(() => {
      // meta_file_mtime 0: we didn't read the file, so the verify pass looks at it once and fixes the number.
      for (const rec of records)
        if (rec && typeof rec.id === 'string') this.applyOne(rec, JSON.stringify(rec), 0);
    });
  }

  removeItems(ids: string[]): void {
    this.assertOpen();
    this.removeWithDelta(ids, false, emptyDelta(false));
  }

  /** Delete items (and everything hanging off them); optionally add their old text to `delta`. */
  private removeWithDelta(ids: string[], trackText: boolean, delta: IndexDelta): void {
    const json = JSON.stringify(ids);
    this.tx(() => {
      const rows = this.st.idsWithText.all(json) as {
        id: string;
        rowid: number;
        record_json: string;
      }[];
      for (const row of rows) {
        this.st.deleteFts.run(row.rowid);
        this.st.deleteItem.run(row.rowid); // tags, folders, palette and search rows go by cascade
        this.logChange(row.rowid);
        delta.removed.push(row.id);
        if (trackText) delta.changedText.push({ id: row.id, before: row.record_json, after: null });
      }
      if (rows.length) this.paletteVersion++;
      this.st.deleteHashes.run(json);
    });
  }

  /** Insert or update one item. Must run inside a transaction. */
  private applyOne(rec: EagleItemRecord, text: string, metaMtime: number): Outcome {
    const row = this.st.byId.get(rec.id) as
      { rowid: number; record_json: string; meta_file_mtime: number } | undefined;
    if (row && (row.record_json === text || sameRecord(row.record_json, text))) {
      // Same content (or same after a re-format): keep the row, just remember the file's new mtime.
      if (row.meta_file_mtime !== metaMtime || row.record_json !== text)
        this.st.touchItem.run(text, metaMtime, row.rowid);
      return { kind: 'same', before: row.record_json };
    }
    const p = projectRecord(rec, text, this.folderText);
    p.item.meta_file_mtime = metaMtime;
    if (row) {
      if (!samePalette(this.st.paletteOf.all(row.rowid) as number[][], p)) this.paletteVersion++;
      this.st.deleteFts.run(row.rowid); // FTS rows aren't reached by the foreign-key cascades
      this.st.deleteTags.run(row.rowid);
      this.st.deleteFolders.run(row.rowid);
      this.st.deletePalette.run(row.rowid);
      this.st.updateItem.run({ ...p.item, rowid: row.rowid });
      this.insertDerived(row.rowid, p);
      return { kind: 'changed', before: row.record_json };
    }
    const rowid = Number(this.st.insertItem.run(p.item).lastInsertRowid);
    if (p.palette.length) this.paletteVersion++;
    this.insertDerived(rowid, p);
    return { kind: 'added', before: null };
  }

  private insertDerived(rowid: number, p: ProjectedRecord): void {
    for (const tag of p.tags) this.st.insertTag.run(rowid, tag);
    for (const f of p.folders) this.st.insertFolder.run(rowid, f.folderId, f.ord);
    for (const c of p.palette)
      this.st.insertPalette.run(rowid, c.idx, c.r, c.g, c.b, c.l, c.a, c.bb, c.ratio);
    this.st.insertFts.run({ rowid, ...p.fts });
    this.st.upsertSearch.run(rowid, p.search);
    this.logChange(rowid);
  }

  private logChange(rowid: number): void {
    this.changeLog.push(rowid);
    if (this.changeLog.length > 2 * CHANGE_LOG_MAX) {
      const drop = this.changeLog.length - CHANGE_LOG_MAX;
      this.changeLog = this.changeLog.slice(drop);
      this.logBase += drop;
    }
  }

  // ───────────────────────── Change tracking (query engine caches) ─────────────────────────

  /**
   * Counters that only move forward while this index is open. `items` counts item row writes and
   * removals; `palette` and `root` move when palette rows or the root record change.
   */
  versions(): { items: number; palette: number; root: number } {
    return {
      items: this.logBase + this.changeLog.length,
      palette: this.paletteVersion,
      root: this.rootVersion,
    };
  }

  /**
   * Rowids of the items written or removed since `versions().items` was `since` (repeats
   * possible), or null when that is too long ago to say: then recompute everything.
   */
  changedRowidsSince(since: number): number[] | null {
    if (since < this.logBase || since > this.logBase + this.changeLog.length) return null;
    return this.changeLog.slice(since - this.logBase);
  }

  // ───────────────────────── Reading ─────────────────────────

  getRecord(id: string): EagleItemRecord | null {
    const text = this.st.record.get(id) as string | undefined;
    if (text === undefined) return null;
    try {
      return JSON.parse(text) as EagleItemRecord;
    } catch {
      return null;
    }
  }

  /** What serving an item's files needs to know (service/files isHugeImage), without parsing the record. */
  fileFacts(id: string): FileFacts | null {
    return (this.st.fileFacts.get(id) as FileFacts | undefined) ?? null;
  }

  /** Bookkeeping that lives and dies with this index (service/storage keeps when the stat pass last ran). */
  getMeta(key: string): string | null {
    return (this.st.getMeta.get(key) as string | undefined) ?? null;
  }

  /** null deletes. */
  setMeta(key: string, value: string | null): void {
    if (value === null) this.st.delMeta.run(key);
    else this.st.setMeta.run(key, value);
  }

  /** Same answer until an item row or the root changes (counts() is asked after every event). */
  counts(): Counts {
    const v = this.versions();
    const key = `${v.items}:${v.root}`;
    if (this.countsCache?.key !== key) {
      this.numbered ??= numberFolders(this.folderText, this.ancestors);
      this.countsCache = { key, value: computeCounts(this.st, this.numbered) };
    }
    return { ...this.countsCache.value };
  }

  /** Some folder has a password, so its items are hidden (see LOCKED_ROWIDS). */
  hasLocked(): boolean {
    return hasLocked(this.st);
  }

  tags(): TagInfo[] {
    return tagInfos(this.st, this.getRoot());
  }

  // ───────────────────────── Hashes ─────────────────────────

  getHashes(ids?: string[]): HashRow[] {
    return (ids ? this.st.hashesFor.all(JSON.stringify(ids)) : this.st.hashes.all()) as HashRow[];
  }

  setHash(id: string, h: { size: number; fileMtime: number; md5?: string; dhash?: string }): void {
    this.st.setHash.run({
      id,
      size: h.size,
      fileMtime: h.fileMtime,
      md5: h.md5 ?? null,
      dhash: h.dhash ?? null,
      now: Date.now(),
    });
  }

  // ───────────────────────── Plumbing ─────────────────────────

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.loader.beforeClose();
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort: the -wal file is just left for the next open */
    }
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The index is closed');
  }
}

/** An item's stored palette rows ([l, a, bb, ratio] by idx) hold what `p` would write. */
function samePalette(rows: number[][], p: ProjectedRecord): boolean {
  return (
    rows.length === p.palette.length &&
    rows.every(([l, a, bb, ratio], i) => {
      const c = p.palette[i];
      return c.l === l && c.a === a && c.bb === bb && c.ratio === ratio;
    })
  );
}

/** Same JSON value, different bytes (whitespace): not an edit. Only called when the texts already differ. */
function sameRecord(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}
