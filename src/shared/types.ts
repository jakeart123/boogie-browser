// Shared domain types used by the core (main process) and the renderer.
// Owned by the orchestrator. Agents may ADD optional fields; never rename or remove.

// ───────────────────────── Eagle on-disk records (raw) ─────────────────────────
// These mirror research/format-spec.md §4-§5. Unknown keys must survive a round trip,
// so records are always handled as the parsed object (key order preserved), never rebuilt.

export interface Palette {
  color: [number, number, number];
  ratio: number;
  [key: string]: unknown; // tolerate "$$hashKey"
}

export interface EagleItemRecord {
  id: string;
  name: string;
  size: number;
  btime: number;
  mtime: number;
  ext: string;
  tags: string[];
  folders: string[];
  isDeleted: boolean;
  url: string;
  annotation: string;
  modificationTime: number | string; // "date added"; 2 real items hold a string
  lastModified?: number;
  star?: number;
  width?: number;
  height?: number;
  noThumbnail?: true;
  noPreview?: true;
  palettes?: Palette[];
  deletedTime?: number;
  order?: Record<string, string>; // folderId -> decimal string, compare as STRINGS
  processingPalette?: true;
  customThumbnail?: true;
  duration?: number;
  comments?: EagleComment[];
  [key: string]: unknown;
}

export interface EagleComment {
  id: string;
  annotation: string;
  lastModified: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  duration?: number;
  [key: string]: unknown;
}

export interface EagleFolderRecord {
  id: string;
  name: string;
  description: string;
  children: EagleFolderRecord[];
  modificationTime: number;
  tags: string[]; // auto-tags
  icon?: string;
  iconColor?: FolderColor;
  password: string;
  passwordTips: string;
  coverId?: string;
  orderBy?: OrderBy;
  sortIncrease?: boolean;
  [key: string]: unknown;
}

export interface EagleSmartFolderRecord {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  iconColor?: FolderColor;
  modificationTime: number;
  conditions: SmartCondition[];
  children?: EagleSmartFolderRecord[];
  orderBy?: OrderBy;
  sortIncrease?: boolean;
  [key: string]: unknown;
}

export interface SmartCondition {
  rules: SmartRule[];
  match: 'AND' | 'OR';
  boolean?: 'TRUE' | 'FALSE';
  [key: string]: unknown;
}

export interface SmartRule {
  property: string;
  method: string;
  value: unknown;
  unit?: string;
  [key: string]: unknown;
}

export interface EagleTagGroupRecord {
  id: string;
  name: string;
  tags: string[];
  color?: string;
  description?: string;
  [key: string]: unknown;
}

export interface QuickAccessEntry {
  type: 'folder' | 'smartFolder';
  id: string;
  [key: string]: unknown;
}

export interface EagleRootRecord {
  folders: EagleFolderRecord[];
  smartFolders: EagleSmartFolderRecord[];
  quickAccess: QuickAccessEntry[];
  tagsGroups: EagleTagGroupRecord[];
  modificationTime: number;
  applicationVersion: string;
  [key: string]: unknown;
}

export type FolderColor =
  'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'pink';

export const FOLDER_COLORS: Record<FolderColor, string> = {
  red: '#ff5f57',
  orange: '#ff9f40',
  yellow: '#f5c518',
  green: '#3fbf6a',
  aqua: '#2bc0d6',
  blue: '#2f80f7',
  purple: '#a472f7',
  pink: '#f25fa8',
};

export type OrderBy =
  | 'IMPORT'
  | 'NAME'
  | 'EXT'
  | 'RESOLUTION'
  | 'FILESIZE'
  | 'RATING'
  | 'DURATION'
  | 'BTIME'
  | 'MTIME'
  | 'TAGS'
  | 'MANUAL'
  | 'RANDOM';

// ───────────────────────── Libraries ─────────────────────────

export interface LibraryRef {
  /** Stable id for OUR caches: first 16 hex of sha256(realpath). Not an Eagle concept. */
  id: string;
  path: string; // absolute path to the `.library` folder
  name: string; // folder name without `.library`
}

export interface KnownLibrary extends LibraryRef {
  lastOpenedAt: number | null;
  exists: boolean;
  /** Where we found it: added by the user, created in Boogie, or read from Eagle's Settings. */
  source: 'user' | 'created' | 'eagle-settings';
  shared: boolean; // lives inside ~/Dropbox (or user marked it shared)
  partnerName: string | null; // e.g. "Sam": who external changes are attributed to
}

export interface LibraryState {
  ref: LibraryRef;
  readOnly: boolean;
  readOnlyReason: string | null; // plain-English banner text
  /** Why it is read-only, for code (the UI picks its banner button from this, not from the text). */
  readOnlyKind?: 'user' | 'guard' | 'protected' | 'eagle' | 'version' | null;
  applicationVersion: string;
  modificationTime: number;
  folders: FolderNode[];
  smartFolders: SmartFolderNode[];
  quickAccess: QuickAccessEntry[];
  tagGroups: TagGroup[];
  indexing: { done: number; total: number } | null; // null when the index is ready
  /** From the library's tags.json (travels over Dropbox). */
  starredTags?: string[];
  recentTags?: string[]; // historyTags, newest first
  /** From saved-filters.json, in file order. */
  savedFilters?: SavedFilterInfo[];
}

export interface SavedFilterInfo {
  index: number; // position in saved-filters.json (entries have no ids)
  name: string;
  filter: FilterSpec;
  /** Parts of Eagle's rule Boogie can't apply (kept untouched in the file), plain English. */
  unsupported: string[];
  /** Fingerprint of the entry as it is in the file: pass it back as `expectKey` so an edit finds
   *  this entry even after Eagle reordered the list, and never lands on a look-alike. */
  key?: string;
}

export interface FolderNode {
  id: string;
  name: string;
  description: string;
  children: FolderNode[];
  tags: string[]; // own auto-tags
  icon: string | null;
  iconColor: FolderColor | null;
  coverId: string | null;
  orderBy: OrderBy | null;
  sortIncrease: boolean | null;
  hasPassword: boolean;
  modificationTime: number;
}

export interface SmartFolderNode {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  iconColor: FolderColor | null;
  conditions: SmartCondition[];
  children: SmartFolderNode[];
  orderBy: OrderBy | null;
  sortIncrease: boolean | null;
  modificationTime?: number;
}

export interface TagGroup {
  id: string;
  name: string;
  tags: string[];
  color: string | null;
  description: string;
}

export interface TagInfo {
  name: string;
  count: number; // live (non-trashed) items carrying the tag
  groupIds: string[];
}

export interface Counts {
  all: number;
  uncategorized: number;
  untagged: number;
  trash: number;
  /** own = items directly in the folder; deep = folder plus all descendants (distinct items). */
  folders: Record<string, { own: number; deep: number }>;
  smartFolders: Record<string, number>;
  /** Total bytes of live (non-trashed) items. */
  totalSize?: number;
}

// ───────────────────────── Items as the UI sees them ─────────────────────────

export interface ItemBrief {
  id: string;
  name: string;
  ext: string;
  width: number | null;
  height: number | null;
  star: number; // 0 = unrated
  size: number;
  duration: number | null;
  isDeleted: boolean;
  noPreview: boolean;
  tagCount: number;
  thumbUrl: string; // boogie://thumb/... (or /__dev/files/... in web dev)
  version: number; // lastModified, for cache busting
  /** No thumbnail in the library (Eagle can't draw this type), but thumbUrl serves Boogie's own cached preview. */
  localThumb?: boolean;
  animated?: boolean; // GIF/WebP/APNG with more than one frame, when known
}

export interface Item {
  id: string;
  name: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  star: number;
  tags: string[];
  folders: string[];
  url: string;
  annotation: string;
  isDeleted: boolean;
  deletedTime: number | null;
  importedAt: number; // modificationTime coerced to number
  modifiedAt: number; // lastModified (0 if absent)
  btime: number;
  mtime: number;
  duration: number | null;
  palettes: { color: [number, number, number]; ratio: number }[];
  noThumbnail: boolean;
  noPreview: boolean;
  comments: EagleComment[];
  order: Record<string, string>;
  thumbUrl: string;
  fileUrl: string; // the original file
  previewUrl: string; // large browser-viewable rendition (== fileUrl for web formats)
  filePath: string; // absolute path of the original on disk
  version: number;
}

// ───────────────────────── Query ─────────────────────────

export type Scope =
  | { kind: 'all' }
  | { kind: 'uncategorized' }
  | { kind: 'untagged' }
  | { kind: 'trash' }
  | { kind: 'random'; seed: number }
  | { kind: 'folder'; id: string; includeSubfolders: boolean }
  | { kind: 'smartFolder'; id: string }
  | { kind: 'tag'; name: string }
  | { kind: 'ids'; ids: string[] }; // explicit set (e.g. "show the 12 items the partner added")

export type Shape =
  'square' | 'portrait' | 'panoramic-portrait' | 'landscape' | 'panoramic-landscape';

export interface RangeFilter {
  min?: number;
  max?: number;
}

export interface FilterSpec {
  /** Eagle keyword grammar: space = AND, -word excludes, OR / ||, "quoted phrases", ( ). */
  keywords?: string;
  tags?: { mode: 'any' | 'all' | 'exact'; include: string[]; exclude: string[] };
  folders?: { include: string[]; exclude: string[] }; // include = in any of these
  color?: { rgb: [number, number, number]; tolerance: 'similar' | 'close'; minRatio?: number };
  shapes?: Shape[];
  aspect?: { w: number; h: number; tolerance?: number };
  rating?: number[]; // allowed star values, 0 = unrated
  types?: { include: string[]; exclude: string[] }; // extensions, or groups: image video audio font doc 3d
  importedAt?: RangeFilter; // ms
  /** Eagle's "Date modified": the original file's mtime, falling back to import time. NOT Item.modifiedAt (lastModified). */
  modifiedAt?: RangeFilter;
  /** Rolling windows ("last 7 days") so a saved filter stays current. */
  importedWithinDays?: number;
  modifiedWithinDays?: number;
  width?: RangeFilter;
  height?: RangeFilter;
  fileSize?: RangeFilter; // bytes
  duration?: RangeFilter; // seconds
  hasUrl?: boolean;
  hasNote?: boolean;
  urlContains?: string;
  noteContains?: string;
  noTags?: boolean; // items with no tags (Eagle "tag.no")
  unfiled?: boolean; // items in no folder (Eagle pseudo-folder NoFolders)
  grayscale?: boolean; // Eagle color filter "gray"
  hasComments?: boolean; // Eagle region comments (its rule key is "annotation")
  commentContains?: string;
}

export interface SortSpec {
  by: OrderBy;
  ascending: boolean;
  /** Seed for RANDOM order; a new seed reshuffles. */
  seed?: number;
}

export interface QueryRequest {
  scope: Scope;
  filter: FilterSpec;
  sort: SortSpec | null; // null = the scope's own sort (folder orderBy, else IMPORT desc)
}

export interface QueryResult {
  total: number;
  ids: string[]; // in display order
  /** width / height per id, same order; 1 when unknown. Enough to lay out the whole grid. */
  aspects: number[];
  sort: SortSpec; // the sort actually applied
  elapsedMs: number;
}

// ───────────────────────── Mutations ─────────────────────────

export interface Actor {
  kind: 'user' | 'agent' | 'external' | 'system';
  name: string; // "You", "Claude (mcp)", "Sam", "Boogie"
}

export interface ItemPatch {
  name?: string; // single item only
  addTags?: string[];
  removeTags?: string[];
  setTags?: string[];
  star?: number; // 0 removes the rating
  annotation?: string;
  url?: string;
  addFolders?: string[]; // also applies the folders' auto-tags (own + ancestors)
  removeFolders?: string[];
  setFolders?: string[];
}

export interface FolderPatch {
  name?: string;
  description?: string;
  iconColor?: FolderColor | null;
  icon?: string | null;
  tags?: string[]; // auto-tags
  coverId?: string | null;
  orderBy?: OrderBy | null;
  sortIncrease?: boolean;
}

export interface MutationResult {
  groupId: string | null; // history group (null if nothing changed)
  changed: number; // items/records actually written
  /** `kind: 'unchanged'` = nothing to change (not worth warning about). */
  skipped: { id: string; reason: string; kind?: 'unchanged' | 'missing' | 'other' }[];
  /** Plain-English caveat for the UI to show (e.g. tag groups won't reach a running Eagle). */
  warning?: string;
}

// ───────────────────────── History / undo ─────────────────────────

export interface HistoryEntry {
  groupId: string;
  libraryId: string;
  actor: Actor;
  label: string; // plain English: "Tagged 48 items Atelier Gerome"
  at: number; // ms
  itemIds: string[]; // items touched (may be truncated to 500)
  itemCount: number;
  kind:
    'items' | 'folders' | 'import' | 'trash' | 'delete' | 'merge' | 'external' | 'undo' | 'other';
  undoable: boolean;
  undoneBy: string | null; // groupId of the undo, if undone
  /** For an undo group: the groupId it reversed (so the UI never parses the label). */
  undoOf?: string | null;
  /** External group where the partner's Eagle wrote an old copy over your change; undo = "Put my change back". */
  staleOverwrite?: boolean;
  /** A stale-overwrite entry resolved by keeping the partner's version (keepTheirs). */
  keptTheirs?: boolean;
}

export interface UndoResult {
  groupId: string | null; // the new "undo" group
  reverted: number;
  conflicts: { id: string; field: string; reason: string }[]; // left alone because they changed since
}

// ───────────────────────── Jobs (import, scan, dupes) ─────────────────────────

export interface JobProgress {
  jobId: string;
  kind: 'index' | 'import' | 'hash' | 'dupes' | 'thumbnails' | 'export' | 'merge';
  label: string;
  done: number;
  total: number;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  result?: unknown; // kind-specific, e.g. ImportResult or DuplicateGroup[]
  /** Import jobs: the options they started with, so a retry can reuse them. */
  options?: ImportOptions;
}

export interface ImportOptions {
  folderId?: string | null;
  tags?: string[];
  star?: number;
  annotation?: string;
  url?: string;
  /** What to do when the same file content already exists in the library. */
  onDuplicate?: 'ask' | 'skip' | 'keep-both' | 'use-existing';
  /** For folder paths: recreate the folder hierarchy as Eagle folders. */
  keepFolderStructure?: boolean;
  /** Extra folders to file the new items in (besides folderId), in one history entry. */
  folderIds?: string[];
  /** Item name override; only used when exactly one file is imported. */
  name?: string;
  /** "Date added" override in ms (Eagle API's modificationTime); default now. */
  modificationTime?: number;
}

export interface ImportResult {
  added: string[];
  duplicates: { source: string; existingId: string }[]; // when onDuplicate is 'ask' or 'skip'
  failed: { source: string; reason: string }[];
  /** Added, but with a caveat (a file named like a picture that can't be read: an icon-only item). */
  warnings?: { source: string; reason: string }[];
  /** Sources never reached because the job was cancelled. */
  skipped?: string[];
  /** History group of the import, when anything was added. */
  groupId?: string | null;
  /** Batch imports (CoreApi.importBatch): the item each entry became, in entry order (null = none). */
  entryIds?: (string | null)[];
}

/** One source of a batch import (CoreApi.importBatch): exactly one of path, url, bytes or bookmark. */
export interface ImportEntry {
  path?: string; // a file on this computer (not a folder)
  url?: string; // http(s) or data: URL
  referer?: string; // for url
  headers?: Record<string, string>; // for url
  bytes?: Uint8Array; // raw file bytes, named by fileName
  fileName?: string;
  bookmark?: string; // a web page saved as a bookmark item
  title?: string; // the bookmark's name
  thumbnailPng?: Uint8Array; // the bookmark's screenshot
  /** This entry's own options (name, tags, folders, ...). */
  opts?: ImportOptions;
}

export interface DuplicateMember {
  libraryId: string;
  libraryName: string;
  id: string;
  name: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  folders: string[];
  tags: string[];
  star: number;
  importedAt: number;
  thumbUrl: string;
  distance: number; // 0 = identical bytes; perceptual Hamming distance otherwise
}

export interface DuplicateGroup {
  key: string; // content hash, or a cluster id for near-duplicates
  kind: 'exact' | 'similar';
  members: DuplicateMember[];
  suggestedKeeperId: string;
}

export interface DupeScanOptions {
  mode: 'exact' | 'similar';
  /** Hamming distance threshold for 'similar' (0-64 on a 64-bit hash). Default 6. */
  threshold?: number;
  /** Other library paths to compare against (cross-library). Opened read-only. */
  otherLibraries?: string[];
  scope?: Scope; // limit to part of the current library
}

export interface DupeScanStats {
  candidates: number; // files considered for hashing (same-size files, or images)
  hashed: number; // hashes computed by this scan
  cached: number; // hashes reused from the index
  failed: number; // files that couldn't be read (missing original, unreadable, size changed)
  skippedClusters: number; // similar mode: clusters over MAX_CLUSTER members, left out
}

export interface MergeOptions {
  keeperId: string;
  otherIds: string[]; // same library only; cross-library members are reported, not merged
  keepName?: 'keeper' | string; // or an explicit name
  unionTags?: boolean; // default true
  unionFolders?: boolean; // default true
  mergeNotes?: boolean; // default true (append distinct notes)
  keepUrl?: 'keeper' | 'first-nonempty'; // default first-nonempty
  keepStar?: 'keeper' | 'max'; // default max
}

// ───────────────────────── App status ─────────────────────────

export interface AppStatus {
  sync: {
    state: 'idle' | 'syncing' | 'offline' | 'unknown';
    detail: string; // plain English
    conflicts: ConflictFile[];
  };
  eagle: {
    running: boolean; // Wine Eagle on this machine
    openLibraryPath: string | null;
  };
  ports: {
    eagleApi: number | null; // 41595 when we own it
    extension: number | null; // 41593
    mcp: number | null;
    reason: string | null; // e.g. "Eagle is using 41595"
  };
  agents: AgentActivity[];
  lastExternal: HistoryEntry | null;
  /** Items in the open library whose metadata.json couldn't be read (half-synced or damaged). */
  unreadableItems?: number;
  /** Plain English while Boogie's background writes to the open library keep failing (mtime.json),
   *  so the partner's Eagle can't see your edits. Show it as a warning banner; absent when fine. */
  writeProblem?: string;
  /** The partner's Eagle (on another computer) as seen through the shared files. */
  partner?: {
    active: boolean; // wrote to the library recently
    lastSeen: number | null; // ms
    pending: number; // your changes it may not have shown yet
    /** Outside writes of the last 7 days that may have put an old copy over a change of yours,
     *  not resolved yet (each is a History entry: "Put my change back" or "Keep theirs"). */
    oldCopies?: number;
  };
}

export interface RootConflictPlan {
  relPath: string; // the conflicted copy, relative to the library root
  changes: {
    id: string;
    kind: 'folder' | 'smartFolder';
    change: 'onlyInCopy' | 'renamed' | 'moved' | 'recolored' | 'deletedInCopy' | 'other';
    label: string; // plain English, e.g. "Folder “Hands” exists only in Sam's copy"
  }[];
}

export interface ConflictFile {
  path: string; // relative to the library root
  kind: 'root' | 'item' | 'mtime' | 'tags' | 'thumbnail' | 'other';
  itemId: string | null;
  detectedAt: number;
  /** What differs from the library and couldn't be merged with certainty (docs/specs/merge.md).
   *  The library keeps its own value until resolveConflict says otherwise. Absent: not compared
   *  (a read-only library, or a kind Boogie doesn't merge). */
  questions?: ConflictQuestion[];
}

/** One difference between a conflicted copy and the library that needs a person. */
export interface ConflictQuestion {
  id: string; // unique within the copy, e.g. "name", "tag:Blue", a folder id
  label: string; // plain English, e.g. "Name", "Tag “Blue”", "Folder “Hands”"
  live: string; // what the library has now, as short text ("(none)" when absent)
  copy: string; // what the conflicted copy has
}

export interface AgentActivity {
  name: string;
  label: string; // "Tagging Atelier Gerome from notes"
  done: number;
  total: number;
  paused: boolean;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  layout: 'justified' | 'masonry' | 'grid' | 'list';
  thumbSize: number; // row height / column width in px
  showNames: boolean;
  showMeta: boolean;
  showSubfolderContents: boolean;
  doubleClickAction: 'detail' | 'reference' | 'open';
  eagleCompatApi: boolean; // serve 41595/41593 for the browser extension
  mcpEnabled: boolean;
  mcpPort: number;
  /** Absolute roots Boogie may write inside. Everything else opens read-only. */
  writableRoots: string[];
  /**
   * Libraries in Dropbox or on external drives may be edited too (still only inside
   * writableRoots). Default false. Only the user changes it, in Settings; agents can't.
   */
  allowProtectedWrites: boolean;
  bulkConfirmThreshold: number; // default 500
  windowsNameMaxChars: number; // cap for imported/renamed names (path length on the partner's Windows)
}
