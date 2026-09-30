// Pure helpers for the library's root metadata.json (folders, smart folders, quick access, tag
// groups). They work on the raw parsed record, keep the key order of anything they don't touch,
// and return whether they changed something, so they slot straight into
// `lib.updateRoot((root) => addFolder(root, {...}), ctx)`. Writing (version guard, backup, ...)
// is the adapter's job; this file never touches the disk.
import type {
  EagleFolderRecord,
  EagleRootRecord,
  EagleSmartFolderRecord,
  EagleTagGroupRecord,
  FolderColor,
  FolderPatch,
  OrderBy,
  QuickAccessEntry,
  SmartCondition,
} from '../../shared/types';
import { FOLDER_COLORS } from '../../shared/types';
import { guid } from './ids';
import { sanitizeFolderName } from './names';
import { normalizeTags } from './edits';

const ORDER_BYS: readonly string[] = [
  'IMPORT',
  'NAME',
  'EXT',
  'RESOLUTION',
  'FILESIZE',
  'RATING',
  'DURATION',
  'BTIME',
  'MTIME',
  'TAGS',
  'MANUAL',
  'RANDOM',
];

// ───────────────────────── key order ─────────────────────────
// Eagle rewrites every folder record with the same key order, so a NEW key goes where Eagle would
// put it (not at the end) when the record is well formed. Unknown keys never move.

const FOLDER_KEYS = [
  'id',
  'name',
  'description',
  'children',
  'modificationTime',
  'tags',
  'extendTags',
  'pinyin',
  'icon',
  'iconColor',
  'password',
  'passwordTips',
  'coverId',
  'orderBy',
  'sortIncrease',
];
const SMART_KEYS = [
  'id',
  'icon',
  'iconColor',
  'name',
  'description',
  'modificationTime',
  'conditions',
  'children',
  'orderBy',
  'sortIncrease',
];
const GROUP_KEYS = ['id', 'name', 'tags', 'color', 'description'];

type Bag = Record<string, unknown>;

/** Set `key`; a key already present keeps its position, a new one is slotted in by `order`. */
function setOrdered(rec: object, key: string, value: unknown, order: readonly string[]): void {
  const o = rec as Bag;
  if (key in o) {
    o[key] = value;
    return;
  }
  const rank = order.indexOf(key);
  const nextKey = Object.keys(o).find((k) => order.indexOf(k) > rank);
  if (rank < 0 || nextKey === undefined) {
    o[key] = value;
    return;
  }
  const entries = Object.entries(o);
  for (const [k] of entries) delete o[k];
  for (const [k, v] of entries) {
    if (k === nextKey) o[key] = value;
    o[k] = v;
  }
}

function deleteKey(rec: object, key: string): boolean {
  if (!(key in rec)) return false;
  delete (rec as Bag)[key];
  return true;
}

// ───────────────────────── generic tree helpers ─────────────────────────

interface TreeNode {
  id: string;
  children?: TreeNode[];
}
interface Located<T> {
  node: T;
  parent: T | null;
  siblings: T[];
  index: number;
}

function locate<T extends TreeNode>(list: T[], id: string): Located<T> | null {
  const stack: { list: T[]; parent: T | null }[] = [{ list, parent: null }];
  while (stack.length) {
    const { list: cur, parent } = stack.pop()!;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].id === id) return { node: cur[i], parent, siblings: cur, index: i };
      if (Array.isArray(cur[i].children) && cur[i].children!.length)
        stack.push({ list: cur[i].children as T[], parent: cur[i] });
    }
  }
  return null;
}

function collectIds(node: TreeNode, includeSelf: boolean): string[] {
  const out: string[] = includeSelf ? [node.id] : [];
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const n = stack.shift()!;
    out.push(n.id);
    if (n.children) stack.unshift(...n.children);
  }
  return out;
}

function allIds(root: EagleRootRecord): Set<string> {
  const ids = new Set<string>();
  for (const f of root.folders ?? []) for (const id of collectIds(f, true)) ids.add(id);
  for (const f of root.smartFolders ?? []) for (const id of collectIds(f, true)) ids.add(id);
  for (const g of root.tagsGroups ?? []) ids.add(g.id);
  return ids;
}

function freshId(root: EagleRootRecord, now: number): string {
  const used = allIds(root);
  let id = guid(now);
  while (used.has(id)) id = guid(now);
  return id;
}

/** Take `id` out of wherever it is and put it in `parentList` at `index` (counted after removal). */
function moveInTree<T extends TreeNode>(
  list: T[],
  id: string,
  parentId: string | null,
  index: number,
): boolean {
  const from = locate(list, id);
  if (!from) throw new Error(`Not found: ${id}`);
  let target: T[];
  if (parentId === null) target = list;
  else {
    if (parentId === id || collectIds(from.node, false).includes(parentId))
      throw new Error("A folder can't be moved into itself or one of its own subfolders.");
    const p = locate(list, parentId);
    if (!p) throw new Error(`Parent not found: ${parentId}`);
    target = (p.node.children ??= []) as T[];
  }
  from.siblings.splice(from.index, 1);
  const at = Math.max(0, Math.min(Math.trunc(index), target.length));
  target.splice(at, 0, from.node);
  return !(from.siblings === target && at === from.index);
}

function cleanLabel(name: string): string {
  return (
    String(name ?? '')
      .normalize('NFC')
      .trim()
      .slice(0, 1024) || 'Untitled'
  );
}

function ensureArray<K extends keyof EagleRootRecord>(
  root: EagleRootRecord,
  key: K,
): NonNullable<EagleRootRecord[K]> {
  if (!Array.isArray(root[key])) (root as Bag)[key as string] = [];
  return root[key] as NonNullable<EagleRootRecord[K]>;
}

function checkColor(c: string): FolderColor {
  if (!(c in FOLDER_COLORS)) throw new Error(`Unknown folder color: ${c}`);
  return c as FolderColor;
}

// ───────────────────────── folders: reading ─────────────────────────

export function locateFolder(root: EagleRootRecord, id: string): Located<EagleFolderRecord> | null {
  return locate(root.folders ?? [], id);
}

export function findFolder(root: EagleRootRecord, id: string): EagleFolderRecord | null {
  return locateFolder(root, id)?.node ?? null;
}

/** Top-most ancestor first, ending with the folder itself. Empty if the folder doesn't exist. */
export function folderPath(root: EagleRootRecord, id: string): EagleFolderRecord[] {
  const path: EagleFolderRecord[] = [];
  let loc = locateFolder(root, id);
  while (loc) {
    path.unshift(loc.node);
    loc = loc.parent ? locateFolder(root, loc.parent.id) : null;
  }
  return path;
}

/** Ancestors of the folder, top-most first, NOT including the folder. */
export function ancestors(root: EagleRootRecord, id: string): EagleFolderRecord[] {
  return folderPath(root, id).slice(0, -1);
}

/** Ids below the folder (not the folder itself unless `includeSelf`). */
export function descendantIds(root: EagleRootRecord, id: string, includeSelf = false): string[] {
  const f = findFolder(root, id);
  return f ? collectIds(f, includeSelf) : [];
}

/** The tags an item gets when it is put in the folder: the folder's own plus every ancestor's. */
export function autoTagsFor(root: EagleRootRecord, folderId: string): string[] {
  const own: string[] = [];
  const path = folderPath(root, folderId);
  for (let i = path.length - 1; i >= 0; i--) for (const t of path[i].tags ?? []) own.push(t);
  return normalizeTags(own).reverse();
}

// ───────────────────────── folders: editing ─────────────────────────

/** Add a folder (top level, or under `parentId`) and return its id. Record keys follow Eagle's order. */
export function addFolder(
  root: EagleRootRecord,
  opts: { name: string; parentId?: string | null; iconColor?: FolderColor | null; now?: number },
): string {
  const now = opts.now ?? Date.now();
  const list = ensureArray(root, 'folders');
  let siblings = list;
  if (opts.parentId) {
    const parent = findFolder(root, opts.parentId);
    if (!parent) throw new Error(`Parent folder not found: ${opts.parentId}`);
    siblings = parent.children = Array.isArray(parent.children) ? parent.children : [];
  }
  const id = freshId(root, now);
  const rec: EagleFolderRecord = {
    id,
    name: sanitizeFolderName(opts.name),
    description: '',
    children: [],
    modificationTime: now,
    tags: [],
    password: '',
    passwordTips: '',
  };
  if (opts.iconColor) setOrdered(rec, 'iconColor', checkColor(opts.iconColor), FOLDER_KEYS);
  siblings.push(rec);
  return id;
}

export function renameFolder(root: EagleRootRecord, id: string, name: string): boolean {
  return updateFolder(root, id, { name });
}

/**
 * Apply a FolderPatch. `iconColor`, `icon`, `coverId` and `orderBy` set a key or (null) delete it.
 * `orderBy` and `sortIncrease` are always written together, `sortIncrease` defaulting to true when
 * a folder gets its first `orderBy`. Like Eagle, the folder's own modificationTime is left alone.
 */
export function updateFolder(root: EagleRootRecord, id: string, patch: FolderPatch): boolean {
  const f = findFolder(root, id);
  if (!f) throw new Error(`Folder not found: ${id}`);
  let changed = false;
  const set = (key: string, value: unknown) => {
    if (JSON.stringify((f as Bag)[key]) === JSON.stringify(value) && key in f) return;
    setOrdered(f, key, value, FOLDER_KEYS);
    changed = true;
  };
  if (patch.name !== undefined) set('name', sanitizeFolderName(patch.name));
  if (patch.description !== undefined) set('description', String(patch.description));
  if (patch.tags !== undefined) set('tags', normalizeTags(patch.tags));
  if (patch.iconColor !== undefined) {
    if (patch.iconColor === null) changed = deleteKey(f, 'iconColor') || changed;
    else set('iconColor', checkColor(patch.iconColor));
  }
  if (patch.icon !== undefined) {
    if (patch.icon === null || patch.icon === '') changed = deleteKey(f, 'icon') || changed;
    else set('icon', patch.icon);
  }
  if (patch.coverId !== undefined) {
    if (patch.coverId === null) changed = deleteKey(f, 'coverId') || changed;
    else set('coverId', patch.coverId);
  }
  if (patch.orderBy !== undefined) {
    if (patch.orderBy === null) {
      changed = deleteKey(f, 'orderBy') || changed;
      changed = deleteKey(f, 'sortIncrease') || changed;
    } else {
      if (!ORDER_BYS.includes(patch.orderBy)) throw new Error(`Unknown sort: ${patch.orderBy}`);
      const first = !('orderBy' in f);
      set('orderBy', patch.orderBy as OrderBy);
      set('sortIncrease', patch.sortIncrease ?? (first ? true : f.sortIncrease !== false));
    }
  } else if (patch.sortIncrease !== undefined && 'orderBy' in f) {
    set('sortIncrease', patch.sortIncrease);
  }
  return changed;
}

/**
 * Move a folder under `parentId` (null = top level). `index` is its position among the new
 * siblings once the folder has been taken out. Refuses to move a folder into its own subtree.
 */
export function moveFolder(
  root: EagleRootRecord,
  id: string,
  parentId: string | null,
  index: number,
): boolean {
  return moveInTree(ensureArray(root, 'folders'), id, parentId, index);
}

/** Remove a folder and its subfolders (and their quick-access entries). Returns every removed id, folder first. */
export function removeFolder(root: EagleRootRecord, id: string): string[] {
  const loc = locateFolder(root, id);
  if (!loc) return [];
  const ids = collectIds(loc.node, true);
  loc.siblings.splice(loc.index, 1);
  dropQuickAccess(root, ids);
  return ids;
}

// ───────────────────────── smart folders ─────────────────────────

export function locateSmartFolder(
  root: EagleRootRecord,
  id: string,
): Located<EagleSmartFolderRecord> | null {
  return locate(root.smartFolders ?? [], id);
}

export function findSmartFolder(root: EagleRootRecord, id: string): EagleSmartFolderRecord | null {
  return locateSmartFolder(root, id)?.node ?? null;
}

export function addSmartFolder(
  root: EagleRootRecord,
  opts: {
    name: string;
    conditions: SmartCondition[];
    parentId?: string | null;
    description?: string;
    icon?: string;
    iconColor?: FolderColor;
    now?: number;
  },
): string {
  const now = opts.now ?? Date.now();
  const list = ensureArray(root, 'smartFolders');
  let siblings = list;
  if (opts.parentId) {
    const parent = findSmartFolder(root, opts.parentId);
    if (!parent) throw new Error(`Parent smart folder not found: ${opts.parentId}`);
    siblings = parent.children = Array.isArray(parent.children) ? parent.children : [];
  }
  const id = freshId(root, now);
  // Eagle always writes icon and iconColor, "" when unset (eagle-proof D.root.smart).
  const rec = {
    id,
    icon: opts.icon ?? '',
    iconColor: opts.iconColor ? checkColor(opts.iconColor) : '',
    name: cleanLabel(opts.name),
    description: opts.description ?? '',
    modificationTime: now,
    conditions: opts.conditions,
    children: [],
  } as EagleSmartFolderRecord;
  siblings.push(rec);
  return id;
}

/** Editing the rules counts as "Save Changes" in Eagle and refreshes modificationTime; renames and colors don't. */
export function updateSmartFolder(
  root: EagleRootRecord,
  id: string,
  patch: {
    name?: string;
    description?: string;
    icon?: string | null;
    iconColor?: FolderColor | null;
    conditions?: SmartCondition[];
    orderBy?: OrderBy | null;
    sortIncrease?: boolean;
    now?: number;
  },
): boolean {
  const f = findSmartFolder(root, id);
  if (!f) throw new Error(`Smart folder not found: ${id}`);
  let changed = false;
  const set = (key: string, value: unknown) => {
    if (key in f && JSON.stringify((f as Bag)[key]) === JSON.stringify(value)) return false;
    setOrdered(f, key, value, SMART_KEYS);
    changed = true;
    return true;
  };
  if (patch.name !== undefined) set('name', cleanLabel(patch.name));
  if (patch.description !== undefined) set('description', String(patch.description));
  // Cleared like Eagle clears them: "" (a running Eagle would put a deleted key back anyway).
  if (patch.icon !== undefined) {
    if (patch.icon === null || patch.icon === '') {
      if ('icon' in f) set('icon', '');
    } else set('icon', patch.icon);
  }
  if (patch.iconColor !== undefined) {
    if (patch.iconColor === null) {
      if ('iconColor' in f) set('iconColor', '');
    } else set('iconColor', checkColor(patch.iconColor));
  }
  if (patch.conditions !== undefined && set('conditions', patch.conditions))
    set('modificationTime', patch.now ?? Date.now());
  if (patch.orderBy !== undefined) {
    if (patch.orderBy === null) {
      changed = deleteKey(f, 'orderBy') || changed;
      changed = deleteKey(f, 'sortIncrease') || changed;
    } else {
      if (!ORDER_BYS.includes(patch.orderBy)) throw new Error(`Unknown sort: ${patch.orderBy}`);
      const first = !('orderBy' in f);
      set('orderBy', patch.orderBy);
      set('sortIncrease', patch.sortIncrease ?? (first ? true : f.sortIncrease !== false));
    }
  } else if (patch.sortIncrease !== undefined && 'orderBy' in f) {
    set('sortIncrease', patch.sortIncrease);
  }
  return changed;
}

export function moveSmartFolder(
  root: EagleRootRecord,
  id: string,
  parentId: string | null,
  index: number,
): boolean {
  return moveInTree(ensureArray(root, 'smartFolders'), id, parentId, index);
}

/** Remove a smart folder and its nested ones (and their quick-access entries). Returns every removed id. */
export function removeSmartFolder(root: EagleRootRecord, id: string): string[] {
  const loc = locateSmartFolder(root, id);
  if (!loc) return [];
  const ids = collectIds(loc.node, true);
  loc.siblings.splice(loc.index, 1);
  dropQuickAccess(root, ids);
  return ids;
}

// ───────────────────────── quick access ─────────────────────────

function dropQuickAccess(root: EagleRootRecord, ids: string[]): void {
  if (!Array.isArray(root.quickAccess)) return;
  const gone = new Set(ids);
  const kept = root.quickAccess.filter((e) => !gone.has(e?.id));
  if (kept.length !== root.quickAccess.length) root.quickAccess = kept;
}

/** Replace the quick-access list. Entries are cut down to `{type, id}` like Eagle saves them, first mention of an id wins. */
export function setQuickAccess(
  root: EagleRootRecord,
  entries: readonly QuickAccessEntry[],
): boolean {
  const seen = new Set<string>();
  const next: QuickAccessEntry[] = [];
  for (const e of entries) {
    if (
      (e?.type !== 'folder' && e?.type !== 'smartFolder') ||
      typeof e.id !== 'string' ||
      seen.has(e.id)
    )
      continue;
    seen.add(e.id);
    next.push({ type: e.type, id: e.id });
  }
  if (Array.isArray(root.quickAccess) && JSON.stringify(root.quickAccess) === JSON.stringify(next))
    return false;
  root.quickAccess = next;
  return true;
}

// ───────────────────────── tag groups ─────────────────────────

export interface TagGroupInput {
  id?: string;
  name: string;
  tags: readonly string[];
  color?: string | null;
  description?: string | null;
  now?: number;
}

const cleanGroupTags = (tags: readonly string[]) =>
  normalizeTags(tags.map((t) => String(t).replace(/[\r\n]/g, '')));

/**
 * Create a tag group, or update the one with the same id. `index` (optional) is its position in the
 * sidebar order. Returns the id. Array order is the sidebar order.
 */
export function upsertTagGroup(
  root: EagleRootRecord,
  input: TagGroupInput,
  index?: number,
): string {
  const groups = ensureArray(root, 'tagsGroups');
  const existing = input.id ? groups.find((g) => g.id === input.id) : undefined;
  const g: EagleTagGroupRecord = existing ?? {
    id: input.id ?? freshId(root, input.now ?? Date.now()),
    name: '',
    tags: [],
  };
  setOrdered(g, 'name', cleanLabel(input.name), GROUP_KEYS);
  setOrdered(g, 'tags', cleanGroupTags(input.tags), GROUP_KEYS);
  if (input.color === null) deleteKey(g, 'color');
  else if (input.color !== undefined) setOrdered(g, 'color', input.color, GROUP_KEYS);
  if (input.description === null) deleteKey(g, 'description');
  else if (input.description !== undefined)
    setOrdered(g, 'description', input.description, GROUP_KEYS);
  if (!existing) groups.push(g);
  if (index !== undefined) {
    groups.splice(groups.indexOf(g), 1);
    groups.splice(Math.max(0, Math.min(Math.trunc(index), groups.length)), 0, g);
  }
  return g.id;
}

export function removeTagGroup(root: EagleRootRecord, id: string): boolean {
  const groups = root.tagsGroups;
  if (!Array.isArray(groups)) return false;
  const i = groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  groups.splice(i, 1);
  return true;
}

/** Replace `from` with `to` in every group that lists it (no duplicates). Used when a tag is renamed. */
export function renameTagInGroups(root: EagleRootRecord, from: string, to: string): boolean {
  let changed = false;
  for (const g of root.tagsGroups ?? []) {
    if (!Array.isArray(g.tags) || !g.tags.includes(from)) continue;
    g.tags = normalizeTags(g.tags.map((t) => (t === from ? to : t)));
    changed = true;
  }
  return changed;
}

/** Take a tag out of every group (used when a tag is deleted). */
export function removeTagFromGroups(root: EagleRootRecord, tag: string): boolean {
  let changed = false;
  for (const g of root.tagsGroups ?? []) {
    if (!Array.isArray(g.tags) || !g.tags.includes(tag)) continue;
    g.tags = g.tags.filter((t) => t !== tag);
    changed = true;
  }
  return changed;
}
