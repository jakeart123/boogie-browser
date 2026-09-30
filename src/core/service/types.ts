// Shared shapes for the service files: what is open (Session), what a mutation touched
// (Touch), and what the session needs from the host that owns it (Env).
import type { BoogieEventName, BoogieEvents } from '../../shared/api';
import type {
  AppSettings,
  ConflictFile,
  EagleRootRecord,
  HistoryEntry,
  LibraryRef,
  LibraryState,
  MutationResult,
} from '../../shared/types';
import type {
  AppPaths,
  EagleLibrary,
  EagleSavedFilter,
  Importer,
  Journal,
  LibraryIndex,
  LibraryWatcher,
  MediaService,
  QueryEngine,
  UrlBuilder,
} from '../contracts';
import type { CoreDeps } from './deps';
import type { JobManager } from './jobs';
import type { Mutex } from './util';

export interface Env {
  deps: CoreDeps;
  paths: AppPaths;
  jobs: JobManager;
  settings(): AppSettings;
  /** The shared media service (subprocess pool), created on first use. */
  media(): MediaService;
  emit<K extends BoogieEventName>(event: K, payload: BoogieEvents[K]): void;
  hasListener(event: BoogieEventName): boolean;
  /** Something the status strip shows changed. */
  statusChanged(): void;
  setLastExternal(entry: HistoryEntry): void;
}

export type ReadOnlyKind = NonNullable<LibraryState['readOnlyKind']>;

/** A library opened only to read it (other libraries in a duplicate scan). */
export interface OpenSource {
  ref: LibraryRef;
  lib: EagleLibrary;
  index: LibraryIndex;
  urls: UrlBuilder;
}

export interface Session {
  env: Env;
  ref: LibraryRef;
  lib: EagleLibrary;
  index: LibraryIndex;
  query: QueryEngine;
  journal: Journal;
  importer: Importer;
  watcher: LibraryWatcher;
  urls: UrlBuilder;
  /** The root metadata.json as last written or read. Folder names for labels, auto-tags, etc. */
  root: EagleRootRecord;

  /** What the service enforces. */
  readOnly: boolean;
  readOnlyReason: string | null;
  readOnlyKind: ReadOnlyKind | null;
  /** The adapter was opened read-only, so becoming editable means reopening. */
  adapterReadOnly: boolean;
  userReadOnly: boolean;
  /** Set when the library's Eagle version is unsupported (never changes while open). */
  versionReason: string | null;

  shared: boolean;
  partnerName: string | null;

  indexing: { done: number; total: number } | null;
  syncPromise: Promise<void> | null;
  /** A watcher event arrived while the index was still syncing: sync once more afterwards. */
  needsResync: boolean;
  /** Items we wrote while a sync was running; re-read afterwards in case the scan raced us. */
  dirtyDuringSync: Set<string>;
  /** Conflicted copies at the library root (from the watcher). */
  conflicts: ConflictFile[];
  /** Conflicted copies inside item folders, by item id (only items that have some). */
  itemConflicts: Map<string, ConflictFile[]>;

  /** Serializes mutations and external-change handling. */
  lock: Mutex;
  /** Keeps each actor's own actions in the order asked (see group.ts inOrder). */
  actorQueues: Map<string, Mutex>;
  abort: AbortController;
  /** The background verify pass (catches edits that never raised mtime.json), while it runs. */
  verifying: { stop: AbortController; done: Promise<void> } | null;
  dupeSources: OpenSource[];
  closed: boolean;

  /** tags.json as last read or written (undefined until the first read, null when it has none). */
  tagsFile?: { starred: string[]; recent: string[] } | null;
  /** saved-filters.json entries as last read or written (same). Converted for the UI on each state build. */
  savedFilterEntries?: EagleSavedFilter[] | null;
  /** The partner's Eagle as seen through the shared files: pending items, touches, rechecks (partner.ts). */
  partner?: import('./partner').Partner;
}

/** What one mutation touched. Filled in by the operation, read by runGroup. */
export interface Touch {
  changed: Set<string>;
  added: Set<string>;
  removed: Set<string>;
  /** The root metadata.json was written. */
  root: boolean;
  skipped: MutationResult['skipped'];
  warning?: string;
  /** Final history label, when it depends on what actually happened. */
  label?: string;
  /** Overrides the default `changed` count of the MutationResult. */
  count?: number;
  /** Inside a locked group: let queued work (other edits, outside changes) run, then continue. */
  pause(): Promise<void>;
}
