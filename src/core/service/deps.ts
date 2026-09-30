// The other core modules the service is built from, as factories (defaultDeps.ts makes the real
// ones), so a test can swap one out, like the Eagle monitor. Small pure helpers (an error class,
// the conflicted-copy scan) are imported directly where they are used.
import type {
  DropboxStatus,
  DupeFinder,
  EagleLibraryFactory,
  EagleMonitor,
  ImporterFactory,
  IndexFactory,
  Journal,
  LibraryWatcher,
  MediaService,
  QueryEngineFactory,
} from '../contracts';
import type {
  EagleFolderRecord,
  EagleItemRecord,
  EagleRootRecord,
  EagleTagGroupRecord,
  FolderColor,
  FolderPatch,
  OrderBy,
  QuickAccessEntry,
  SmartCondition,
} from '../../shared/types';

/**
 * Eagle's pure record rules (from src/core/eagle: edits.ts, root.ts, order.ts), in the shape
 * the service wants. All of them edit the object they are given, in place.
 */
export interface RecordEdits {
  setStar(rec: EagleItemRecord, stars: number): void; // 0 deletes the key
  trash(rec: EagleItemRecord, now: number): void;
  restore(rec: EagleItemRecord): void;
  addTags(rec: EagleItemRecord, tags: string[]): void;
  removeTags(rec: EagleItemRecord, tags: string[]): void;
  setTags(rec: EagleItemRecord, tags: string[]): void;
  addFolders(rec: EagleItemRecord, ids: string[], autoTags: string[]): void;
  removeFolders(rec: EagleItemRecord, ids: string[]): void;
  setFolders(rec: EagleItemRecord, ids: string[]): void;
  setAnnotation(rec: EagleItemRecord, text: string): void;
  setUrl(rec: EagleItemRecord, url: string): void;
  /** The item's manual position in one folder (`order[folderId]`). */
  setOrder(rec: EagleItemRecord, folderId: string, key: string): void;
}

export interface TreeEdits {
  findFolder(root: EagleRootRecord, id: string): EagleFolderRecord | null;
  /** The folder's own auto-tags plus every ancestor's. */
  autoTagsFor(root: EagleRootRecord, id: string): string[];
  /** The folder's id plus all descendant ids. */
  descendantIds(root: EagleRootRecord, id: string): string[];
  addFolder(
    root: EagleRootRecord,
    init: { name: string; parentId: string | null; iconColor?: FolderColor },
  ): string;
  updateFolder(root: EagleRootRecord, id: string, patch: FolderPatch): void;
  moveFolder(root: EagleRootRecord, id: string, parentId: string | null, index: number): void;
  /** Returns the removed ids (the folder and its descendants). */
  removeFolder(root: EagleRootRecord, id: string): string[];
  addSmartFolder(
    root: EagleRootRecord,
    init: { name: string; conditions: SmartCondition[]; parentId: string | null },
  ): string;
  updateSmartFolder(
    root: EagleRootRecord,
    id: string,
    patch: {
      name?: string;
      conditions?: SmartCondition[];
      iconColor?: FolderColor | null;
      orderBy?: OrderBy | null;
    },
  ): void;
  removeSmartFolder(root: EagleRootRecord, id: string): void;
  setQuickAccess(root: EagleRootRecord, entries: QuickAccessEntry[]): void;
  upsertTagGroup(
    root: EagleRootRecord,
    group: Partial<EagleTagGroupRecord> & { name: string; tags: string[] },
  ): string;
  removeTagGroup(root: EagleRootRecord, id: string): void;
  renameTagInGroups(root: EagleRootRecord, from: string, to: string): void;
  removeTagFromGroups(root: EagleRootRecord, tag: string): void;
}

export interface OrderEdits {
  /** The item's manual-order key in a folder (its own entry, else String(modificationTime)). */
  orderKey(rec: EagleItemRecord, folderId: string): string;
  /** String comparison, as Eagle does it. */
  compareOrder(a: string, b: string): number;
  /**
   * Keys for `count` items dropped between the neighbor shown just `above` and the one shown just
   * `below` (null at an edge). Returned in display order. `descending`: the folder shows the
   * largest key first (Eagle's MANUAL default). Throws when there is no room between the two.
   */
  placeBetween(
    above: string | null,
    below: string | null,
    count: number,
    opts?: { descending?: boolean },
  ): string[];
  /** Make equal keys distinct. `keys` are in display order; the result keeps that order. */
  spreadDuplicates(keys: string[], opts?: { descending?: boolean }): string[];
}

export interface EagleHelpers {
  edits: RecordEdits;
  tree: TreeEdits;
  order: OrderEdits;
}

export interface CoreDeps {
  eagle: EagleLibraryFactory;
  indexes: IndexFactory;
  queries: QueryEngineFactory;
  createJournal(opts: { dir: string }): Journal;
  createMedia(opts: { cacheDir: string }): MediaService;
  createWatcher(): LibraryWatcher;
  eagleMonitor: EagleMonitor;
  dropbox: DropboxStatus;
  importers: ImporterFactory;
  dupes: DupeFinder;
  helpers: EagleHelpers;
}
