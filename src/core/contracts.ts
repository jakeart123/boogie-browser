// Internal contracts between core modules. Each module's owner implements its interface;
// the service layer composes them. Owned by the orchestrator: if you need a change, add it
// ADDITIVELY (new optional member) and mention it in your report.
//
// Rule of thumb for every module: plain Node (no `electron` import), async I/O, no global state
// except what the factory returns, and never touch a library folder except through EagleLibrary.

import type Database from 'better-sqlite3';
import type {
  Actor,
  Counts,
  EagleItemRecord,
  EagleRootRecord,
  FilterSpec,
  HistoryEntry,
  Item,
  ItemBrief,
  LibraryRef,
  Palette,
  QueryRequest,
  QueryResult,
  Scope,
  SortSpec,
  TagInfo,
  ConflictFile,
} from '../shared/types';

// ───────────────────────── Change context ─────────────────────────

/** Passed to every write. The journal groups file changes by `group`. */
export interface ChangeContext {
  actor: Actor;
  group: JournalGroup;
}

// ───────────────────────── Eagle adapter (src/core/eagle) ─────────────────────────

/** A parsed JSON document plus the exact text it came from. */
export interface Doc<T> {
  value: T; // JSON.parse result; key order preserved; unknown keys kept
  text: string; // exact bytes read (utf8)
}

export interface ItemWrite {
  id: string;
  relPath: string; // e.g. images/<ID>.info/metadata.json
  before: string | null;
  after: string | null;
  lastModified: number;
}

export interface EagleLibrary {
  readonly root: string; // absolute path to <name>.library
  readonly readOnly: boolean;

  // ── Reads (tolerant, never repair; see format-spec §19.7) ──
  readRoot(): Promise<Doc<EagleRootRecord>>;
  /** Item ids from `images/` (only `<id>.info` dirs with a 13- or 36-char id). */
  listItemIds(): Promise<string[]>;
  /** null if missing, or unparseable after retries (maybe mid-sync). */
  readItem(id: string): Promise<Doc<EagleItemRecord> | null>;
  readMtimeIndex(): Promise<Record<string, number>>;
  /** Absolute path of the original file, with the NFC/NFD/leading-space fallback search. */
  locateOriginal(id: string, rec: EagleItemRecord): Promise<string | null>;
  /** Absolute path of Eagle's `<name>_thumbnail.png` (content may be WebP/JPEG/PNG), or null. */
  locateThumbnail(id: string, rec: EagleItemRecord): Promise<string | null>;
  itemDir(id: string): string;

  // ── Item writes. Each: fresh read → mutate → lastModified bump → atomic write → journal →
  //    queue mtime.json raise. `mutate` edits the record in place; return false to skip. ──
  updateItem(
    id: string,
    mutate: (rec: EagleItemRecord) => boolean | void,
    ctx: ChangeContext,
  ): Promise<ItemWrite | null>;
  updateItems(
    ids: string[],
    mutate: (rec: EagleItemRecord) => boolean | void,
    ctx: ChangeContext,
    onSkip?: (id: string, reason: string) => void,
  ): Promise<ItemWrite[]>;
  /** Rename the original + thumbnail files and the record's `name` (sanitized). */
  renameItem(id: string, newName: string, ctx: ChangeContext): Promise<ItemWrite | null>;
  /**
   * Create a new item folder: copies `sourcePath` in as <name>.<ext>, writes `thumbnailBytes`
   * (if given) as <name>_thumbnail.png, then metadata.json LAST, then queues mtime.json.
   * The record fields come from `init` (id/lastModified/modificationTime are filled in if absent).
   */
  createItem(
    init: NewItemInit,
    ctx: ChangeContext,
  ): Promise<{ id: string; record: EagleItemRecord }>;
  /** Replace the thumbnail file of an existing item (after regenerate / custom thumbnail).
   *  `keepOld`: journal the old picture so undo can put it back (a custom thumbnail). */
  writeThumbnail(
    id: string,
    rec: EagleItemRecord,
    bytes: Uint8Array,
    ctx: ChangeContext,
    opts?: { keepOld?: boolean },
  ): Promise<void>;
  /** Move the whole `<id>.info` folder OUT of the library into `destDir` (journal store). */
  moveItemOut(id: string, destDir: string, ctx: ChangeContext): Promise<void>;
  /** Move a previously moved-out folder back in (undo of a permanent delete). */
  moveItemIn(id: string, fromDir: string, ctx: ChangeContext): Promise<void>;

  // ── Root metadata.json. Fresh read → version guard → mutate → modificationTime bump →
  //    atomic write → journal → Eagle-style backup copy. ──
  updateRoot(
    mutate: (root: EagleRootRecord) => boolean | void,
    ctx: ChangeContext,
  ): Promise<{ before: string; after: string } | null>;

  // ── tags.json (starred + recent tags) and saved-filters.json. Same rules as the root file:
  //    fresh read → mutate → atomic write → journal. A missing or empty file starts from Eagle's
  //    default; one that won't parse is never written over (LibraryUnreadableError). ──
  /** null when the library has no tags.json. Throws LibraryUnreadableError if it won't parse. */
  readTagsFile?(): Promise<Doc<EagleTagsFile> | null>;
  updateTagsFile?(
    mutate: (file: EagleTagsFile) => boolean | void,
    ctx: ChangeContext,
  ): Promise<{ before: string | null; after: string } | null>;
  /** null when the library has no saved-filters.json. Throws LibraryUnreadableError if it won't parse. */
  readSavedFilters?(): Promise<Doc<EagleSavedFilter[]> | null>;
  updateSavedFilters?(
    mutate: (list: EagleSavedFilter[]) => boolean | void,
    ctx: ChangeContext,
  ): Promise<{ before: string | null; after: string } | null>;

  /** Rewrite an item with no field change so a partner's Eagle re-reads it: lastModified and the
   *  mtime.json value go above the file's current value (Eagle ignores values < 500 ms behind).
   *  `ifText`: only if the file is still exactly that text (else null, nothing written). */
  touchItem?(id: string, opts?: { ifText?: string }): Promise<ItemWrite | null>;
  /** Ids raised in mtime.json in the last `withinMs` (for re-touching after a foreign rewrite). */
  recentRaises?(withinMs: number): string[];
  /** The mtime.json value we wrote for `id` in the last minute, so the watcher tells our raise from another's. */
  raisedValue?(id: string): number | undefined;
  /** What we wrote to mtime.json for `id` in the last minute: the value, when, whether the item was
   *  new, and whether mtime.json had no entry for it before (to judge a partner's rewrite). */
  raiseInfo?(
    id: string,
  ): { value: number; at: number; created: boolean; newEntry: boolean } | undefined;
  /** Raise mtime.json[id] to the item's current lastModified again, without rewriting the item
   *  (a partner's rewrite put our value back or dropped the id). The value, or null if unreadable. */
  reannounce?(id: string): Promise<number | null>;
  /** Plain English while the batched mtime.json write keeps failing (a partner's Eagle can't see edits); null when fine. */
  writeProblem?(): string | null;

  /** Write queued mtime.json raises now (normally batched ~1 s after the last item write). */
  flushMtime(): Promise<void>;
  /** Paths (relative) we wrote in the last few seconds, for watcher echo suppression. */
  recentSelfWrites(): Map<string, number>;
  close(): Promise<void>;
}

/**
 * `<library>/tags.json`. `historyTags` = recently used, newest first, at most 120 (Eagle adds a
 * tag whenever it is put on an item); `starredTags` = the starred list. Unknown keys are kept.
 * A running Eagle never re-reads this file and rewrites it from memory (live-behavior §2.5).
 */
export interface EagleTagsFile {
  historyTags: string[];
  starredTags: string[];
  [key: string]: unknown;
}

/**
 * One entry of `<library>/saved-filters.json`: a name and a snapshot of Eagle's filter bar
 * (format-notes/smartfolders-filters.md "saved-filters.json"). Eagle polls this file every 4 s.
 */
export interface EagleSavedFilter {
  name: string;
  rule: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NewItemInit {
  sourcePath: string; // file to copy in (never moved unless moveSource)
  moveSource?: boolean; // true for our own temp files (downloads, clipboard)
  name: string; // desired base name; the adapter sanitizes + caps it
  ext: string; // sniffed, lowercase, no dot
  size: number;
  btime: number; // ms, whole seconds
  mtime: number; // ms, whole seconds; the copy's file mtime is set to this
  width?: number;
  height?: number;
  duration?: number;
  tags?: string[];
  folders?: string[];
  url?: string;
  annotation?: string;
  star?: number;
  palettes?: Palette[];
  noThumbnail?: boolean;
  noPreview?: boolean;
  thumbnailBytes?: Uint8Array; // WebP bytes (Eagle rules) when !noThumbnail
  modificationTime?: number; // date added; default now (unique within a batch)
  extra?: Record<string, unknown>; // type-specific keys (resolutionWidth, animated, ...), appended in order
}

export interface EagleLibraryFactory {
  open(
    root: string,
    opts: { readOnly: boolean; journal: JournalSink; nameMaxChars: number },
  ): Promise<EagleLibrary>;
  /** Write a new empty library exactly like Eagle's createLibrary. Fails if it exists. */
  create(parentDir: string, name: string): Promise<string>;
  /** Inspect without opening: parse root, report version/compat. */
  probe(root: string): Promise<{
    ok: boolean;
    applicationVersion: string | null;
    reason: string | null;
  }>;
}

// ───────────────────────── Journal (src/core/journal) ─────────────────────────

export interface JournalGroup {
  readonly id: string;
  readonly libraryId: string;
  readonly actor: Actor;
  label: string;
  kind: HistoryEntry['kind'];
}

/** The narrow interface the Eagle adapter writes to. */
export interface JournalSink {
  /** Called BEFORE the file is replaced. `before` null = new file; `after` null = removed. */
  recordFile(
    group: JournalGroup,
    change: { relPath: string; before: string | null; after: string | null; itemId: string | null },
  ): void;
  /** A folder moved out of the library into the journal store (permanent delete). */
  recordMoveOut(group: JournalGroup, change: { itemId: string; storedAt: string }): void;
  /** Where moved-out item folders go for this library. */
  storeDirFor(libraryId: string): string;
}

export interface Journal extends JournalSink {
  begin(libraryId: string, actor: Actor, label: string, kind: HistoryEntry['kind']): JournalGroup;
  /** Finalize: persists the group if it recorded anything; returns the entry (or null if empty). */
  commit(group: JournalGroup, summary: { itemIds: string[] }): HistoryEntry | null;
  /** Record an external change we detected (the partner via Dropbox): before/after per item.
   *  `staleBases` (item id -> the copy the partner's Eagle held) marks a stale overwrite: its undo
   *  puts back only what that old copy reverted and keeps the partner's other edits. */
  recordExternal(
    libraryId: string,
    actor: Actor,
    changes: {
      itemId: string | null;
      relPath: string;
      before: string | null;
      after: string | null;
    }[],
    label: string,
    opts?: { staleBases?: Record<string, string> },
  ): HistoryEntry | null;
  list(libraryId: string, opts?: { limit?: number; before?: number }): HistoryEntry[];
  /**
   * Work out how to undo a group against the CURRENT state. Pure planning; the service applies it.
   * Items: field-level inverse (tags/folders set-wise), skipping fields changed since.
   * Root: id-level inverse for folders/smart folders/tag groups/quick access.
   */
  planUndo(
    groupId: string,
    current: {
      readItem(id: string): Promise<Doc<EagleItemRecord> | null>;
      readRoot(): Promise<Doc<EagleRootRecord>>;
    },
  ): Promise<UndoPlan>;
  markUndone(groupId: string, undoGroupId: string): void;
  // Shared libraries: items Boogie changed that the partner's Eagle may not have shown yet.
  /** After a group commits: its existing items become pending (keeping the text from before the first pending change). */
  markPartnerPending?(groupId: string): void;
  clearPartnerPending?(libraryId: string, ids: string[]): void;
  partnerPendingIds?(libraryId: string, opts?: { unseenOnly?: boolean }): string[];
  /** The copy the partner's Eagle most likely holds: text, null if unknown, undefined if not pending. */
  partnerPendingBase?(libraryId: string, id: string): string | null | undefined;
  /** Pending state: the base (as above) and whether their running Eagle most likely re-read our version. */
  partnerPendingState?(
    libraryId: string,
    id: string,
  ): { base: string | null; seen: boolean } | undefined;
  /** How many pending items the partner's Eagle hasn't been seen to pick up. */
  partnerPendingCount?(libraryId: string): number;
  markPartnerSeen?(libraryId: string, ids: string[]): void;
  /** The library stopped being shared: nothing is pending any more. */
  clearAllPartnerPending?(libraryId: string): void;
  getEntry(groupId: string): HistoryEntry | null;
  /** Every distinct text this file is known to have had (before and after, ours and outside),
   *  recorded at or before `until` (ms), newest first, at most `limit` (default 50). The bases a
   *  conflicted copy is merged against (docs/specs/merge.md). */
  versionsOf?(
    libraryId: string,
    relPath: string,
    opts: { until: number; limit?: number },
  ): { at: number; text: string }[];
  /** Stale-overwrite entries since `since` (ms) not resolved yet (put back, or kept as theirs). */
  countStale?(libraryId: string, since: number): number;
  /** Resolve a stale-overwrite entry by keeping the partner's version (no file changes). */
  markKeptTheirs?(groupId: string): HistoryEntry | null;
  close(): void;
}

export interface UndoPlan {
  groupId: string;
  /** apply edits the fresh record; renameTo (if set) is done by the service via renameItem. */
  items: { id: string; apply: (rec: EagleItemRecord) => boolean; renameTo?: string }[];
  root: ((root: EagleRootRecord) => boolean) | null;
  moveBackIn: { itemId: string; storedAt: string }[]; // undo of permanent delete
  /** tags.json / saved-filters.json: edits for the fresh file. They add their own conflicts. */
  tagsFile?: ((file: EagleTagsFile) => boolean) | null;
  savedFilters?: ((list: EagleSavedFilter[]) => boolean) | null;
  /** Thumbnails to put back (a custom thumbnail): the picture before and after the group. */
  thumbnails?: { id: string; before: Uint8Array | null; after: Uint8Array | null }[];
  conflicts: { id: string; field: string; reason: string }[];
  label: string; // "Undo: Tagged 48 items Atelier Gerome"
}

// ───────────────────────── Index (src/core/index) ─────────────────────────

export interface ScanProgress {
  done: number;
  total: number;
}

export interface LibraryIndex {
  readonly db: Database.Database; // schema: src/core/index/schema.sql
  readonly libraryId: string;
  /** Full scan if the db is new or stale, else incremental. Emits progress. */
  sync(
    lib: EagleLibrary,
    onProgress?: (p: ScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<IndexDelta>;
  /** Re-read specific items (from watcher/mtime hints) and the root if asked. */
  refresh(
    lib: EagleLibrary,
    hint: { ids?: string[]; root?: boolean; listDir?: boolean },
  ): Promise<IndexDelta>;
  /** Apply records we just wrote ourselves (no disk read needed). */
  upsertRecords(records: EagleItemRecord[]): void;
  removeItems(ids: string[]): void;
  setRoot(root: EagleRootRecord): void;
  getRoot(): EagleRootRecord | null;
  getRecord(id: string): EagleItemRecord | null; // last indexed record (parsed)
  counts(): Counts;
  tags(): TagInfo[];
  // content hashes for duplicates
  /** A hash row is valid only while the original's size AND fileMtime (Math.trunc(stat.mtimeMs)) match. */
  getHashes(
    ids?: string[],
  ): { id: string; size: number; fileMtime: number; md5: string | null; dhash: string | null }[];
  /** Replaces the whole row (pass both hashes when both are still valid). */
  setHash(id: string, h: { size: number; fileMtime: number; md5?: string; dhash?: string }): void;
  /** Background pass that re-reads every item file whose mtime changed (catches edits that never raised mtime.json). */
  verify?(
    lib: EagleLibrary,
    opts?: {
      signal?: AbortSignal;
      onDelta?: (d: IndexDelta) => void;
      chunk?: number;
      pauseMs?: number;
    },
  ): Promise<IndexDelta>;
  /** Items whose metadata.json couldn't be read, so the UI can say so. */
  unreadableIds?(): string[];
  /**
   * Counters that only move forward while the index is open, for the query engine's caches:
   * `items` counts item row writes and removals, `palette` and `root` move when palette rows or
   * the root record change. An index without them gets no caching in the engine.
   */
  versions?(): { items: number; palette: number; root: number };
  /** Rowids of the items written or removed since versions().items was `since` (repeats possible), or null when that is too long ago to say. */
  changedRowidsSince?(since: number): number[] | null;
  /** Bookkeeping that lives and dies with the index (e.g. when the stat pass last ran). */
  getMeta?(key: string): string | null;
  /** null deletes. */
  setMeta?(key: string, value: string | null): void;
  /** What serving an item's files needs to know, from the index row (no record parsed); null when unknown. */
  fileFacts?(
    id: string,
  ): { ext: string; width: number | null; height: number | null; size: number } | null;
  close(): void;
}

export interface IndexDelta {
  added: string[];
  changed: string[];
  removed: string[];
  rootChanged: boolean;
  /** Before/after record text for changed items, so the journal can log external edits. */
  changedText: { id: string; before: string | null; after: string | null }[];
  /** True while the first full scan is unfinished (including a resumed one): not outside changes. */
  firstScan?: boolean;
}

export interface IndexFactory {
  /** Opens (creating/migrating) ~/.cache/boogie-browser/index/<libraryId>.sqlite */
  open(ref: LibraryRef, opts?: { dir?: string }): LibraryIndex;
}

// ───────────────────────── Query (src/core/index/query) ─────────────────────────

export interface QueryEngine {
  query(req: QueryRequest): QueryResult;
  briefs(ids: string[]): ItemBrief[];
  item(id: string): Item | null;
  items(ids: string[]): Item[];
  smartFolderCounts(): Record<string, number>;
  suggest(
    text: string,
    kinds: ('tag' | 'folder' | 'smartFolder')[],
    limit: number,
  ): {
    kind: 'tag' | 'folder' | 'smartFolder';
    id: string;
    label: string;
    path: string;
    count: number;
  }[];
  /** Default sort for a scope (folder orderBy/sortIncrease, else IMPORT desc). */
  defaultSort(scope: Scope): SortSpec;
}

export interface QueryEngineFactory {
  create(index: LibraryIndex, urls: UrlBuilder, filePathOf: (id: string) => string): QueryEngine;
}

export interface UrlBuilder {
  thumb(id: string, version: number): string;
  file(id: string, version: number): string;
  preview(id: string, ext: string, version: number): string;
}

/** Pure helpers exported by query for reuse (MCP, http, smart folders). */
export type FilterFn = (rec: EagleItemRecord) => boolean;
export type { FilterSpec };

// ───────────────────────── Media (src/core/media) ─────────────────────────

export interface ProbeResult {
  ext: string; // sniffed from content, lowercase, Eagle's names (jpg not jpeg)
  width: number | null; // upright (EXIF applied)
  height: number | null;
  duration: number | null; // seconds (video/audio)
  animated: boolean;
  kind: 'image' | 'video' | 'audio' | 'font' | 'doc' | '3d' | 'other';
}

export interface EagleThumbResult {
  noThumbnail: boolean; // Eagle's thresholds say "show the original"
  bytes: Uint8Array | null; // WebP bytes for <name>_thumbnail.png
  width: number | null;
  height: number | null;
  /** Eagle's svg flags: under 100 KB -> noThumbnail + removeThumbnail; larger -> forceThumbnail. */
  removeThumbnail?: true;
  forceThumbnail?: true;
}

export interface MediaService {
  probe(path: string): Promise<ProbeResult>;
  /** Eagle-rule thumbnail (format-spec §6): WebP q75, short edge 320 (480 some types). */
  eagleThumbnail(
    srcPath: string,
    probe: ProbeResult,
    size?: number,
    opts?: { force?: boolean }, // force: skip the "show the original" rules (bookmark screenshots)
  ): Promise<EagleThumbResult>;
  /** One video frame as WebP bytes at native size (custom thumbnails). */
  videoFrame?(srcPath: string, atSec: number): Promise<Uint8Array>;
  /** Eagle palette (format-spec §7) from the thumbnail (or the original when noThumbnail). */
  /** `dims`: the image's upright size when the caller already knows it (saves a header read). */
  palette(imagePath: string, dims?: { width: number; height: number }): Promise<Palette[] | null>;
  /** Browser-viewable large rendition for formats Chromium can't show (HEIC, PSD, TIFF, RAW...). Cached. */
  preview(srcPath: string, cacheKey: string, maxEdge?: number): Promise<string>;
  /** 64-bit perceptual hash (dHash) as 16 hex chars. */
  dhash(imagePath: string): Promise<string>;
  /** Streamed md5 of the file. Aborting stops the read and rejects with the abort reason. */
  md5(path: string, signal?: AbortSignal): Promise<string>;
  /** Formats Chromium can display directly in <img>/<video>. */
  isBrowserViewable(ext: string): boolean;
  close(): Promise<void>;
}

// ───────────────────────── Sync / watching (src/core/sync) ─────────────────────────

export interface WatchEvents {
  /** Item folders appeared/disappeared, or mtime.json raised these ids. */
  items(hint: { ids: string[]; listDir: boolean }): void;
  root(): void; // root metadata.json changed (modificationTime went up)
  conflicts(files: ConflictFile[]): void;
  /** tags.json or saved-filters.json changed on disk. */
  rootFiles?(which: 'tags' | 'savedFilters'): void;
  /** Someone else rewrote mtime.json (a partner's Eagle saving); `raisedByUs` = ids we raised in the last ~20 s.
   *  `values`: the rewrite's entries as read (what that Eagle's memory held). */
  foreignMtime?(info: {
    at: number;
    raisedByUs: string[];
    values?: Record<string, number>;
    /** The ids someone else raised in it, with their value before (null: a new id). */
    previous?: Record<string, number | null>;
    /** Another Boogie's write that put back or dropped some of ours: re-send, but it isn't Eagle. */
    byBoogie?: boolean;
  }): void;
}

export interface LibraryWatcher {
  start(lib: EagleLibrary, events: WatchEvents): void;
  /** Force a check now (window focus). */
  poke(): void;
  stop(): void;
}

export interface EagleMonitor {
  /** Is Wine/Windows Eagle running on this machine, and which library does it have open? */
  check(): Promise<{ running: boolean; openLibraryPath: string | null }>;
}

export interface DropboxStatus {
  check(): Promise<{ state: 'idle' | 'syncing' | 'offline' | 'unknown'; detail: string }>;
  /**
   * `dropbox filestatus`: has Dropbox finished syncing each file (absolute paths)? 'unknown' (no
   * client, a timeout, odd output) must never block anything. Optional: a test double may omit it.
   */
  fileStatus?(paths: string[]): Promise<Record<string, 'upToDate' | 'syncing' | 'unknown'>>;
}

// ───────────────────────── Import (src/core/import) ─────────────────────────

export interface ImportDeps {
  lib: EagleLibrary;
  index: LibraryIndex;
  media: MediaService;
  tmpDir: string; // for downloads/clipboard; our own dir, never inside a library
  nameMaxChars: number;
}

export interface Importer {
  importPaths(
    paths: string[],
    opts: import('../shared/types').ImportOptions,
    ctx: ChangeContext,
    onProgress?: (p: ScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<import('../shared/types').ImportResult>;
  importUrl(
    url: string,
    opts: import('../shared/types').ImportOptions & {
      referer?: string;
      name?: string;
      headers?: Record<string, string>;
    },
    ctx: ChangeContext,
    /** Stops the download (a cancelled job, a paused agent). */
    signal?: AbortSignal,
  ): Promise<import('../shared/types').ImportResult>;
  importBytes(
    bytes: Uint8Array,
    fileName: string,
    opts: import('../shared/types').ImportOptions,
    ctx: ChangeContext,
  ): Promise<import('../shared/types').ImportResult>;
  importBookmark(
    url: string,
    title: string,
    opts: import('../shared/types').ImportOptions & { thumbnailPng?: Uint8Array },
    ctx: ChangeContext,
  ): Promise<import('../shared/types').ImportResult>;
}

export interface ImporterFactory {
  create(deps: ImportDeps): Importer;
}

// ───────────────────────── Duplicates (src/core/dupes) ─────────────────────────

export interface DupeSource {
  ref: LibraryRef;
  lib: EagleLibrary; // read-only for other libraries
  index: LibraryIndex;
  urls: UrlBuilder;
}

export interface DupeFinder {
  /** Hash what's missing (size-grouped first, so only same-size files get md5'd), then group. */
  scan(
    opts: import('../shared/types').DupeScanOptions,
    current: DupeSource,
    others: DupeSource[],
    media: MediaService,
    onProgress?: (p: ScanProgress) => void,
    signal?: AbortSignal,
    stats?: import('../shared/types').DupeScanStats,
  ): Promise<import('../shared/types').DuplicateGroup[]>;
  /** Pure: how to merge. Keeper gets the union; others get trashed. */
  planMerge(
    keeper: EagleItemRecord,
    others: EagleItemRecord[],
    opts: import('../shared/types').MergeOptions,
    folderAutoTags: (folderId: string) => string[],
  ): { keeper: (rec: EagleItemRecord) => boolean; trashIds: string[] };
}

// ───────────────────────── Service host (src/core/service) ─────────────────────────

export interface AppPaths {
  config: string; // ~/.config/boogie-browser
  cache: string; // ~/.cache/boogie-browser
  data: string; // ~/.local/share/boogie-browser (journal lives here)
  tmp: string; // <cache>/tmp
}

export interface CoreHost {
  /** Actor = the user ("You"). */
  api: import('../shared/api').CoreApi;
  /** Same API; every write attributed to `actor` (agents, the browser extension). */
  as(actor: Actor): import('../shared/api').CoreApi;
  on<K extends import('../shared/api').BoogieEventName>(
    event: K,
    fn: (payload: import('../shared/api').BoogieEvents[K]) => void,
  ): () => void;
  /** For the boogie:// protocol: resolve a file for the CURRENT library (or any open source). */
  resolveFile(
    kind: 'thumb' | 'file' | 'preview',
    libraryId: string,
    itemId: string,
  ): Promise<{ path: string; mime: string } | null>;
  /** Absolute path of an item's original (drag-out, reveal, open-with). */
  originalPath(itemId: string): Promise<string | null>;
  /** The app layer reports which servers it started (shown in AppStatus.ports). */
  setPorts(ports: Partial<import('../shared/types').AppStatus['ports']>): void;
  /** MCP reports long-running agent work (shown in the status strip, pausable). */
  setAgentActivity(list: import('../shared/types').AgentActivity[]): void;
  /** Agents (MCP) check this between chunks; the UI's Pause sets it via CoreApi.setAgentPaused. */
  isAgentPaused?(name: string): boolean;
  paths: AppPaths;
  close(): Promise<void>;
}
