// Current library, its folder tree, counts, tags, known libraries, status and settings.
// When a different library becomes the open one (however that happened: the Libraries dialog, the
// sidebar's library menu, the palette, or the main process), the view starts over: scope, filter,
// sort, back/forward, selection and the item cache belong to the old library.
import { api, on } from '../api';
import type {
  AppSettings,
  AppStatus,
  Counts,
  FolderNode,
  KnownLibrary,
  LibraryState,
  Scope,
  SmartFolderNode,
  TagInfo,
} from '../../../shared/types';
import { items } from './items.svelte';
import { selection } from './selection.svelte';
import { ui } from './ui.svelte';
import { view } from './view.svelte';

export interface FolderInfo {
  node: FolderNode;
  parentId: string | null;
  /** Names from the top level down to this folder. */
  path: string[];
}

class LibraryStore {
  #state = $state.raw<LibraryState | null>(null);
  counts = $state.raw<Counts | null>(null);
  tags = $state.raw<TagInfo[]>([]);
  known = $state.raw<KnownLibrary[]>([]);
  status = $state.raw<AppStatus | null>(null);
  settings = $state.raw<AppSettings | null>(null);
  error = $state<string | null>(null);

  /** id -> folder info, rebuilt whenever the tree changes. */
  folders = $derived(indexFolders(this.#state?.folders ?? []));
  smartFolders = $derived(indexSmart(this.#state?.smartFolders ?? []));
  readOnly = $derived(this.#state?.readOnly ?? true);

  private subscribed = false;
  /** False until init() has loaded the first state; that one starts the view itself. */
  private started = false;

  get state(): LibraryState | null {
    return this.#state;
  }

  set state(next: LibraryState | null) {
    const prev = this.#state;
    this.#state = next;
    if (!this.started || !next) return;
    if (next.ref.id !== prev?.ref.id) {
      // The viewer and the pickers hold the old library's item ids.
      ui.viewer = null;
      ui.closeOverlay();
      selection.clear();
      items.clear();
      this.counts = null;
      this.tags = [];
      view.reset(next.ref.id, (s) => this.exists(s));
      // However it was opened (here, the Eagle API's library switch, an agent), load its tags.
      void this.reloadMeta().catch(() => {});
    } else if (prev.indexing && !next.indexing) {
      // The first scan just finished: the tags asked for while it ran were not all there yet.
      void this.reloadMeta().catch(() => {});
    }
  }

  /** Resolves once init() has opened the first library and started the view. */
  readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor() {
    this.ready = new Promise((r) => (this.markReady = r));
  }

  async init(): Promise<void> {
    this.subscribe();
    const [known, settings, status, state] = await Promise.all([
      api.listLibraries(),
      api.getSettings(),
      api.getStatus(),
      api.getLibraryState(),
    ]);
    this.known = known;
    this.settings = settings;
    view.applySettings(settings); // before the first query, so nothing lays out at the defaults
    this.status = status;
    // Like Eagle, start in the library that was open last time (the list is most recent first).
    // If it can't open now, the Libraries dialog shows instead.
    const last = state ? null : known.find((k) => k.exists && k.lastOpenedAt);
    const first = last ? await api.openLibrary(last.path).catch(() => null) : state;
    // A library opened while we were asking (an agent, the Eagle API) arrived as a 'library'
    // event and is newer than the answers above: don't overwrite it with "nothing open".
    if (!this.#state) this.state = first;
    this.started = true;
    if (this.state) view.reset(this.state.ref.id, (s) => this.exists(s));
    this.markReady();
    if (this.state) await this.reloadMeta();
  }

  async open(path: string, opts?: { readOnly?: boolean }): Promise<void> {
    try {
      this.error = null;
      this.state = await api.openLibrary(path, opts);
      this.known = await api.listLibraries();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async create(parentDir: string, name: string): Promise<void> {
    this.state = await api.createLibrary(parentDir, name);
    this.known = await api.listLibraries();
  }

  async reloadMeta(): Promise<void> {
    const [counts, tags] = await Promise.all([api.getCounts(), api.listTags()]);
    this.counts = counts;
    this.tags = tags;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = await api.setSettings(patch);
  }

  folder(id: string): FolderInfo | undefined {
    return this.folders.get(id);
  }

  /** The open library as the known-libraries list has it (shared or not, partner's name). */
  get current(): KnownLibrary | undefined {
    const path = this.#state?.ref.path;
    return path ? this.known.find((k) => k.path === path) : undefined;
  }

  /** Whether a place to look still exists in this library (a folder may be gone since). */
  exists(s: Scope): boolean {
    if (s.kind === 'folder') return this.folders.has(s.id);
    if (s.kind === 'smartFolder') return this.smartFolders.has(s.id);
    return s.kind !== 'ids';
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    on('library', (s) => (this.state = s));
    on('counts', (c) => (this.counts = c));
    on('status', (s) => (this.status = s));
    let tagTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshTags = () => {
      clearTimeout(tagTimer);
      tagTimer = setTimeout(async () => (this.tags = await api.listTags()), 300);
    };
    on('itemsChanged', refreshTags);
    on('itemsAdded', refreshTags);
    on('itemsRemoved', refreshTags);
  }
}

function indexFolders(roots: FolderNode[]): Map<string, FolderInfo> {
  const map = new Map<string, FolderInfo>();
  const walk = (nodes: FolderNode[], parentId: string | null, path: string[]) => {
    for (const node of nodes) {
      const p = [...path, node.name];
      map.set(node.id, { node, parentId, path: p });
      walk(node.children, node.id, p);
    }
  };
  walk(roots, null, []);
  return map;
}

function indexSmart(roots: SmartFolderNode[]): Map<string, SmartFolderNode> {
  const map = new Map<string, SmartFolderNode>();
  const walk = (nodes: SmartFolderNode[]) =>
    nodes.forEach((n) => (map.set(n.id, n), walk(n.children)));
  walk(roots);
  return map;
}

export const library = new LibraryStore();
