// The one contract between the UI and the app. The renderer calls these through
// `api` (src/renderer/lib/api.ts); the main process dispatches them to CoreApi
// (src/core/service) or AppApi (src/app). HTTP compat and MCP call CoreApi directly.
// Owned by the orchestrator. Agents may propose additions in their report.

import type {
  AppSettings,
  AppStatus,
  Counts,
  DupeScanOptions,
  DuplicateGroup,
  FilterSpec,
  FolderNode,
  FolderPatch,
  HistoryEntry,
  ImportEntry,
  ImportOptions,
  ImportResult,
  Item,
  ItemBrief,
  ItemPatch,
  JobProgress,
  KnownLibrary,
  LibraryState,
  MergeOptions,
  MutationResult,
  OrderBy,
  QueryRequest,
  QueryResult,
  RootConflictPlan,
  SmartCondition,
  TagInfo,
  UndoResult,
  FolderColor,
} from './types';

/** Library, query, mutation, import, dupes, history. Pure Node; no Electron. */
export interface CoreApi {
  // ── Libraries ──
  listLibraries(): Promise<KnownLibrary[]>;
  /** Open (and make current) a library. Read-only is forced when unsafe; see LibraryState.readOnly. */
  openLibrary(path: string, opts?: { readOnly?: boolean }): Promise<LibraryState>;
  /** Create a new empty Eagle library at <parentDir>/<name>.library and open it. */
  createLibrary(parentDir: string, name: string): Promise<LibraryState>;
  /** Add an existing library folder to the known list without opening it. */
  addLibrary(path: string): Promise<KnownLibrary>;
  forgetLibrary(path: string): Promise<void>;
  setLibraryOptions(
    path: string,
    opts: { partnerName?: string | null; shared?: boolean },
  ): Promise<void>;
  getLibraryState(): Promise<LibraryState | null>;
  closeLibrary(): Promise<void>;

  // ── Query (current library) ──
  query(req: QueryRequest): Promise<QueryResult>;
  getBriefs(ids: string[]): Promise<ItemBrief[]>;
  getItem(id: string): Promise<Item | null>;
  getItems(ids: string[]): Promise<Item[]>;
  getCounts(): Promise<Counts>;
  listTags(): Promise<TagInfo[]>;
  /** Fuzzy suggestions for the command bar / tag input / folder picker. */
  suggest(
    text: string,
    kinds: ('tag' | 'folder' | 'smartFolder')[],
    limit?: number,
  ): Promise<
    {
      kind: 'tag' | 'folder' | 'smartFolder';
      id: string;
      label: string;
      path: string;
      count: number;
    }[]
  >;

  // ── Item mutations ──
  updateItems(ids: string[], patch: ItemPatch): Promise<MutationResult>;
  trashItems(ids: string[]): Promise<MutationResult>;
  restoreItems(ids: string[]): Promise<MutationResult>;
  /** Moves item folders out of the library into Boogie's recoverable store. Never rm. */
  deletePermanently(ids: string[]): Promise<MutationResult>;
  emptyTrash(): Promise<MutationResult>;
  /** Manual order: place `ids` in folder `folderId` right before `beforeId` (null = at the end). */
  reorderItems(folderId: string, ids: string[], beforeId: string | null): Promise<MutationResult>;
  /** Batch rename with Eagle tokens: %N number, %D date, %T tags, * original name. */
  renameItems(
    ids: string[],
    template: string,
    opts?: { start?: number; find?: string; replace?: string; regex?: boolean },
  ): Promise<MutationResult>;
  refreshThumbnails(ids: string[]): Promise<MutationResult>;
  setCustomThumbnail(id: string, imagePath: string): Promise<MutationResult>;

  // ── Folders / smart folders / tags / quick access ──
  createFolder(
    name: string,
    parentId: string | null,
    opts?: { iconColor?: FolderColor },
  ): Promise<{ id: string; groupId: string }>;
  updateFolder(id: string, patch: FolderPatch): Promise<MutationResult>;
  /** Move under `parentId` (null = top level) at `index` among its siblings. */
  moveFolder(id: string, parentId: string | null, index: number): Promise<MutationResult>;
  /** Removes the folder from every item first, then from the tree. deleteContents trashes items only in it. */
  deleteFolder(id: string, opts?: { deleteContents?: boolean }): Promise<MutationResult>;
  createSmartFolder(
    name: string,
    conditions: SmartCondition[],
    parentId?: string | null,
    opts?: { iconColor?: FolderColor },
  ): Promise<{ id: string; groupId: string }>;
  updateSmartFolder(
    id: string,
    patch: {
      name?: string;
      conditions?: SmartCondition[];
      iconColor?: FolderColor | null;
      orderBy?: OrderBy | null;
    },
  ): Promise<MutationResult>;
  deleteSmartFolder(id: string): Promise<MutationResult>;
  setQuickAccess(
    entries: { type: 'folder' | 'smartFolder'; id: string }[],
  ): Promise<MutationResult>;
  renameTag(from: string, to: string): Promise<MutationResult>; // also merges when `to` exists
  deleteTag(name: string): Promise<MutationResult>; // removes it from every item
  upsertTagGroup(group: {
    id?: string;
    name: string;
    tags: string[];
    color?: string | null;
    description?: string;
  }): Promise<MutationResult>;
  deleteTagGroup(id: string): Promise<MutationResult>;

  // ── Import ──
  importPaths(paths: string[], opts?: ImportOptions): Promise<{ jobId: string }>;
  importUrl(
    url: string,
    opts?: ImportOptions & { referer?: string; headers?: Record<string, string> },
  ): Promise<{ jobId: string }>;
  /** Raw bytes (clipboard image, data URL, browser drop). */
  importBytes(bytes: Uint8Array, fileName: string, opts?: ImportOptions): Promise<ImportResult>;
  importBookmark(
    url: string,
    title: string,
    opts?: ImportOptions & { thumbnailPng?: Uint8Array },
  ): Promise<ImportResult>;
  /** Several sources, each with its own options, as ONE job and ONE history entry (Eagle API batch
   *  adds). The job's result is an ImportResult whose `entryIds` line up with `entries`. */
  importBatch?(entries: ImportEntry[]): Promise<{ jobId: string }>;

  // ── Duplicates ──
  findDuplicates(opts: DupeScanOptions): Promise<{ jobId: string }>; // result: DuplicateGroup[] in JobProgress.result
  /** An array merges many groups as ONE history entry ("Merge all exact groups"). */
  mergeDuplicates(opts: MergeOptions | MergeOptions[]): Promise<MutationResult>;

  // ── History ──
  /** `before` is inclusive (at <= before) so groups sharing a millisecond aren't skipped; callers dedupe by groupId. */
  listHistory(opts?: { limit?: number; before?: number }): Promise<HistoryEntry[]>;
  undo(groupId?: string): Promise<UndoResult>; // default: your most recent undoable action
  redo(): Promise<UndoResult>;

  // ── Jobs / status / settings ──
  listJobs(): Promise<JobProgress[]>;
  cancelJob(jobId: string): Promise<void>;
  getStatus(): Promise<AppStatus>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Check the library for outside changes now. Cheap by default (polls mtime.json, used on window focus);
   *  `full` re-reads everything (like Eagle's "reload"). */
  refresh(opts?: { full?: boolean }): Promise<void>;

  // ── Round 4 ──
  /** Star or unstar tags in tags.json (shared library: returns a warning, a running partner Eagle overwrites it). */
  setTagStarred(names: string[], starred: boolean): Promise<MutationResult>;
  /** Saved filters live in saved-filters.json; entries have no ids, so they're addressed by index + name check. */
  saveFilter(name: string, filter: FilterSpec): Promise<MutationResult>;
  /** `expectKey` (SavedFilterInfo.key) finds the entry even after Eagle reordered the list. */
  updateSavedFilter(
    index: number,
    expectName: string,
    patch: { name?: string; filter?: FilterSpec },
    expectKey?: string,
  ): Promise<MutationResult>;
  deleteSavedFilter(index: number, expectName: string, expectKey?: string): Promise<MutationResult>;
  moveSavedFilter(
    from: number,
    to: number,
    expectName?: string,
    expectKey?: string,
  ): Promise<MutationResult>;
  /** Sort a folder's subfolders (or the top level) A to Z: one root write, one undoable history entry. */
  sortFolders(parentId: string | null): Promise<MutationResult>;
  /** Dropbox conflicted copy of the root metadata.json: what differs, and apply picked changes (never edits the copy). */
  planRootConflict(relPath: string): Promise<RootConflictPlan>;
  applyRootConflict(relPath: string, pickedIds: string[]): Promise<MutationResult>;
  /** Settle a conflicted copy's questions (ConflictFile.questions): take the copy's value for
   *  `takeCopy` (question ids), keep the library's for the rest, then move the copy out of the
   *  library into Boogie's store. One undoable history entry. */
  resolveConflict(relPath: string, takeCopy: string[]): Promise<MutationResult>;
  /** "Add to other library": copy items (files + metadata, new ids) into another library. */
  copyToLibrary(
    ids: string[],
    targetLibraryPath: string,
    opts?: { folderId?: string | null },
  ): Promise<{ jobId: string }>;
  /** The folder tree of another (not open) library, read-only, for copyToLibrary's folder picker. */
  listLibraryFolders?(libraryPath: string): Promise<FolderNode[]>;
  /** A "may have written an old copy" entry: keep the partner's version as it is (no file change);
   *  the entry stops counting in status.partner.oldCopies. The counterpart of undo(groupId). */
  keepTheirs(groupId: string): Promise<void>;
  /** Pause/resume an agent's MCP work between chunks (status.agents shows it). */
  setAgentPaused(name: string, paused: boolean): Promise<void>;
  /** setCustomThumbnail from picture bytes instead of a path (a video frame grabbed in the viewer). */
  setCustomThumbnailBytes?(id: string, bytes: Uint8Array): Promise<MutationResult>;
}

/** Things that need Electron. Implemented in src/app. */
export interface AppApi {
  pickLibraryFolder(): Promise<string | null>;
  pickDirectory(title: string): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  /** Start a native drag of the originals (called from a dragstart handler). */
  startDrag(ids: string[]): void;
  /** Ctrl+C: image pixels + file uri-list. */
  copyItems(ids: string[]): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Clipboard contents for Ctrl+V import: file paths or an image. */
  readClipboardForImport(): Promise<{ paths: string[]; image: Uint8Array | null; urls?: string[] }>;
  revealItem(id: string): Promise<void>;
  openItemWithDefaultApp(id: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  /** keepFolders recreates the folder path below baseFolderId (default: the whole tree). */
  exportItems(
    ids: string[],
    dir: string,
    opts?: { keepFolders?: boolean; baseFolderId?: string },
  ): Promise<{ jobId: string }>;
  /** Open a folder in the file manager. */
  showFolder(path: string): Promise<void>;
  /** ids = the list the reference window can step through (default: just id). */
  openReferenceWindow(id: string, ids?: string[]): Promise<void>;
  /** For files dropped into the window. Implemented directly in the preload (webUtils), not over IPC. */
  getPathForFile(file: File): string;
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'fullscreen'): void;
}

export type BoogieApi = CoreApi & AppApi;

/** Events pushed from main to renderer. */
export interface BoogieEvents {
  /** Folder tree / smart folders / tag groups / quick access / read-only state changed. */
  library: LibraryState;
  /** Item records changed on disk (ours or external). The UI refetches what it shows. */
  itemsChanged: { ids: string[]; source: 'self' | 'external' };
  itemsAdded: { ids: string[]; source: 'self' | 'external' };
  itemsRemoved: { ids: string[]; source: 'self' | 'external' };
  counts: Counts;
  job: JobProgress;
  history: HistoryEntry;
  status: AppStatus;
  /** Bring something into view (eagle:// links, the Eagle API's open hooks). */
  reveal: { kind: 'item' | 'folder' | 'smartFolder'; id: string };
}

export type BoogieEventName = keyof BoogieEvents;

/** Names of AppApi methods (used by the main-process dispatcher and the preload). */
export const APP_API_METHODS = [
  'pickLibraryFolder',
  'pickDirectory',
  'pickFiles',
  'startDrag',
  'copyItems',
  'copyText',
  'readClipboardForImport',
  'revealItem',
  'openItemWithDefaultApp',
  'openExternalUrl',
  'exportItems',
  'showFolder',
  'openReferenceWindow',
  'getPathForFile',
  'windowControl',
] as const satisfies readonly (keyof AppApi)[];

/** URL helpers shared by core (to build URLs) and app (to parse them). */
export const BOOGIE_SCHEME = 'boogie';
export function thumbUrl(libraryId: string, itemId: string, version: number): string {
  return `${BOOGIE_SCHEME}://thumb/${libraryId}/${itemId}?v=${version}`;
}
export function fileUrl(libraryId: string, itemId: string, version: number): string {
  return `${BOOGIE_SCHEME}://file/${libraryId}/${itemId}?v=${version}`;
}
export function previewUrl(libraryId: string, itemId: string, version: number): string {
  return `${BOOGIE_SCHEME}://preview/${libraryId}/${itemId}?v=${version}`;
}

/** What the preload exposes as `window.boogie`. */
export interface BoogieBridge {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  on(event: BoogieEventName, fn: (payload: unknown) => void): () => void;
  getPathForFile(file: File): string;
  startDrag(ids: string[]): void;
  /** 'main' or 'reference' (the floating reference window), plus its item id. */
  windowKind: {
    kind: 'main' | 'reference';
    itemId: string | null;
    /** Reference window: the list it steps through (openReferenceWindow's ids), itemId included. */
    itemIds?: string[];
  };
}
