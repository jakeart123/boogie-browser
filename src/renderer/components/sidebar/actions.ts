// Everything the sidebar does to the app: each function is one user action, with the toasts,
// confirmations and read-only checks the spec asks for (the shared rules are in lib/edit).
// Components stay about layout and events.
import { api } from '../../lib/api';
import { readDrop, type Drop } from '../../lib/dnd';
import { canEdit, confirmBulk, errorText, fail, mutate, toastWithUndo } from '../../lib/edit';
import { importPaths, importUrl } from '../../lib/files';
import { leaveFolders } from '../../lib/folders';
import { plural, quoted } from '../../lib/format';
import { followTagInTriageKeys, renameTarget } from '../../lib/tags';
import { library } from '../../lib/stores/library.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import { countDescendants, isSelfOrDescendant } from './tree';

// ───────────── scopes ─────────────

export const openFolder = (id: string) =>
  view.setScope({ kind: 'folder', id, includeSubfolders: view.showSubfolderContents });
export const openSmartFolder = (id: string) => view.setScope({ kind: 'smartFolder', id });
export const openRandom = () =>
  view.setScope({ kind: 'random', seed: Math.floor(Math.random() * 2 ** 31) });

// ───────────── libraries ─────────────
// The library store starts the view over when the open library changes.

export async function openKnownLibrary(path: string): Promise<void> {
  try {
    await library.open(path);
  } catch (e) {
    ui.toast(`Couldn’t open that library. ${errorText(e)}`, { kind: 'error' });
  }
}

export async function openOtherLibrary(): Promise<void> {
  try {
    const path = await api.pickLibraryFolder();
    if (!path) return;
    await api.addLibrary(path);
    await library.open(path);
  } catch (e) {
    ui.toast(`Couldn’t open that library. ${errorText(e)}`, { kind: 'error' });
  }
}

// ───────────── folders ─────────────

export async function createFolder(name: string, parentId: string | null): Promise<string | null> {
  if (!name || !canEdit()) return null;
  try {
    return (await api.createFolder(name, parentId)).id;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** True when the core accepted the new name. */
export async function renameFolder(id: string, name: string): Promise<boolean> {
  const current = library.folder(id)?.node.name;
  if (!name || name === current || !canEdit()) return false;
  return !!(await mutate(() => api.updateFolder(id, { name })));
}

export async function moveFolder(
  id: string,
  parentId: string | null,
  index: number,
  toast = false,
): Promise<void> {
  if (!canEdit()) return;
  const name = library.folder(id)?.node.name ?? 'Folder';
  const into = parentId
    ? `into ${quoted(library.folder(parentId)?.node.name ?? '')}`
    : 'to the top level';
  await mutate(
    () => api.moveFolder(id, parentId, index),
    toast ? `Moved ${quoted(name)} ${into}` : undefined,
  );
}

export async function deleteFolder(id: string): Promise<void> {
  const info = library.folder(id);
  if (!info || !canEdit()) return;
  const subs = countDescendants(info.node);
  const items = library.counts?.folders[id]?.deep ?? 0;
  const parts = [`${quoted(info.node.name)} will be removed from the library.`];
  if (subs) parts.push(`Its ${plural(subs, 'subfolder')} go with it.`);
  parts.push(
    items
      ? `The ${plural(items, 'item')} inside stay in your library.`
      : 'Your items are not deleted.',
  );
  const { ok, checked } = await ui.confirmWith(
    `Delete ${quoted(info.node.name)}?`,
    parts.join(' '),
    {
      confirmLabel: 'Delete folder',
      danger: true,
      checkbox: 'Also move its items to the trash if they are in no other folder',
    },
  );
  if (!ok) return;
  // Leave the folder first so the grid isn't asking about something that no longer exists.
  const s = view.scope;
  if (s.kind === 'folder' && isSelfOrDescendant(library.folders, id, s.id))
    view.setScope({ kind: 'all' });
  await mutate(
    () => api.deleteFolder(id, { deleteContents: checked }),
    `Deleted ${quoted(info.node.name)}`,
  );
}

/**
 * "Sort A to Z": a folder's subfolders (or the top level) in name order, as one change: one write
 * of the library's root file and one History entry, with Undo.
 */
export async function sortFoldersAZ(parentId: string | null): Promise<void> {
  if (!canEdit()) return;
  const siblings = parentId
    ? (library.folder(parentId)?.node.children ?? [])
    : (library.state?.folders ?? []);
  const inOrder = siblings.every(
    (f, i) =>
      i === 0 ||
      siblings[i - 1].name.localeCompare(f.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      }) <= 0,
  );
  if (inOrder) return void ui.toast('Already in A to Z order');
  await mutate(
    () => api.sortFolders(parentId),
    `Sorted ${plural(siblings.length, 'folder')} A to Z`,
  );
}

// ───────────── smart folders ─────────────

export async function deleteSmartFolder(id: string): Promise<void> {
  const node = library.smartFolders.get(id);
  if (!node || !canEdit()) return;
  const ok = await ui.confirm(
    `Delete ${quoted(node.name)}?`,
    'Only the saved search is removed. Your items are not touched.',
    'Delete smart folder',
    true,
  );
  if (!ok) return;
  if (view.scope.kind === 'smartFolder' && view.scope.id === id) view.setScope({ kind: 'all' });
  await mutate(() => api.deleteSmartFolder(id), `Deleted ${quoted(node.name)}`);
}

// ───────────── quick access ─────────────

export const inQuickAccess = (type: 'folder' | 'smartFolder', id: string) =>
  !!library.state?.quickAccess.some((e) => e.type === type && e.id === id);

/** Add or remove a folder or smart folder. Missing ids already in the list are kept as they are. */
export async function toggleQuickAccess(type: 'folder' | 'smartFolder', id: string): Promise<void> {
  if (!canEdit()) return;
  const list = (library.state?.quickAccess ?? []).map((e) => ({ type: e.type, id: e.id }));
  const next = inQuickAccess(type, id)
    ? list.filter((e) => !(e.type === type && e.id === id))
    : [...list, { type, id }];
  await mutate(() => api.setQuickAccess(next));
}

// ───────────── tags ─────────────

export async function renameTag(from: string, typed: string): Promise<void> {
  const to = renameTarget(from, typed);
  if (!to || to === from || !canEdit()) return;
  const merge = library.tags.some((t) => t.name === to);
  if (merge) {
    const ok = await ui.confirm(
      `Merge into ${quoted(to)}?`,
      `${quoted(to)} already exists. Every item tagged ${quoted(from)} will get ${quoted(to)} instead.`,
      'Merge tags',
    );
    if (!ok) return;
  }
  const res = await mutate(
    () => api.renameTag(from, to),
    merge ? `Merged ${quoted(from)} into ${quoted(to)}` : `Renamed tag to ${quoted(to)}`,
  );
  if (!res) return;
  followTagInTriageKeys(from, to);
  if (view.scope.kind === 'tag' && view.scope.name === from)
    view.setScope({ kind: 'tag', name: to });
  void library.reloadMeta();
}

export async function deleteTag(name: string): Promise<void> {
  if (!canEdit()) return;
  const count = library.tags.find((t) => t.name === name)?.count ?? 0;
  const ok = await ui.confirm(
    `Delete tag ${quoted(name)}?`,
    `It will be removed from ${plural(count, 'item')}. The items stay.`,
    'Delete tag',
    true,
  );
  if (!ok) return;
  if (view.scope.kind === 'tag' && view.scope.name === name) view.setScope({ kind: 'all' });
  const res = await mutate(() => api.deleteTag(name), `Deleted tag ${quoted(name)}`);
  if (!res) return;
  followTagInTriageKeys(name, null);
  void library.reloadMeta();
}

// ───────────── dropping things on a folder row ─────────────

/** Items, files or a link dropped on a folder. Shift held with items means move, not add. */
export async function dropOnFolder(e: DragEvent, folderId: string): Promise<void> {
  if (!canEdit()) return;
  const name = library.folder(folderId)?.node.name ?? 'folder';
  let drop: Drop;
  try {
    drop = readDrop(e, library.state?.ref.path ?? null);
  } catch {
    return;
  }
  if (!drop) return;
  if (drop.kind === 'files')
    return importPaths(drop.paths, folderId, { keepFolderStructure: true, folders: drop.folders });
  if (drop.kind === 'url') return importUrl(drop.url, folderId);
  const { ids } = drop;
  // Eagle's "move" is: leave the folder we're looking at (and the subfolders it shows), join the target.
  const leave = e.shiftKey ? leaveFolders(view.scope, folderId) : [];
  const move = leave.length > 0;
  if (
    !(await confirmBulk(ids.length, {
      what: `${move ? 'move' : 'add'} ${plural(ids.length, 'item')} to ${quoted(name)}`,
    }))
  )
    return;
  const res = await mutate(() =>
    api.updateItems(ids, { addFolders: [folderId], ...(move ? { removeFolders: leave } : {}) }),
  );
  if (res?.changed)
    toastWithUndo(
      `${move ? 'Moved' : 'Added'} ${plural(res.changed, 'item')} to ${quoted(name)}`,
      res.groupId,
    );
  else if (res) ui.toast(`Already in ${quoted(name)}`);
}
