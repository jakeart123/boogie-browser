// What the grid does to items, shared by the keyboard commands, the right-click menu and the
// selection bar. The guards, confirms and toasts come from lib/edit; files in and out from lib/files.
import { api } from '../../lib/api';
import { canEdit, confirmBulk, editItems, fail, mutate } from '../../lib/edit';
import { currentFolderId, openDefault, openReference } from '../../lib/files';
import { leaveFolders } from '../../lib/folders';
import { plural } from '../../lib/format';
import { library } from '../../lib/stores/library.svelte';
import { selection } from '../../lib/stores/selection.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';

// ── Viewing ──

export function openViewer(mode: 'detail' | 'quicklook', id: string): void {
  const ids = view.result?.ids;
  const index = ids ? ids.indexOf(id) : -1;
  if (ids && index >= 0) ui.viewer = { mode, ids, index };
}

export function compare(ids: string[] = selection.ids): void {
  if (ids.length < 2 || ids.length > 4) return void ui.toast('Pick 2 to 4 items to compare');
  ui.viewer = { mode: 'compare', ids: [...ids], index: 0 };
}

/** Double-click / Ctrl+double-click. */
export function activate(id: string, ctrl = false): void {
  if (ctrl) return void openReference(id);
  const action = library.settings?.doubleClickAction ?? 'detail';
  if (action === 'reference') void openReference(id);
  else if (action === 'open') void openDefault(id);
  else openViewer('detail', id);
}

// ── Editing ──

/** Quiet: the stars on the tiles say it worked. */
export function rate(ids: string[], star: number) {
  return editItems(ids, { star });
}

export async function trash(ids: string[]): Promise<void> {
  if (
    !ids.length ||
    !canEdit() ||
    !(await confirmBulk(ids.length, { what: `move ${plural(ids.length, 'item')} to the trash` }))
  )
    return;
  await mutate(() => api.trashItems(ids), `Moved ${plural(ids.length, 'item')} to the trash`);
}

export async function restore(ids: string[]): Promise<void> {
  if (!ids.length || !canEdit()) return;
  await mutate(() => api.restoreItems(ids), `Restored ${plural(ids.length, 'item')}`);
}

export async function deleteForever(ids: string[]): Promise<void> {
  if (!ids.length || !canEdit()) return;
  const ok = await ui.confirm(
    `Delete ${plural(ids.length, 'item')} permanently?`,
    'They leave the library. Boogie keeps a recoverable copy outside it, but they will not show up in Eagle anymore.',
    'Delete',
    true,
  );
  if (ok) await mutate(() => api.deletePermanently(ids), `Deleted ${plural(ids.length, 'item')}`);
}

/** Out of the folder you're viewing, and out of the subfolders it shows, so they leave the view. */
export function removeFromFolder(ids: string[]) {
  const leave = leaveFolders(view.scope, '');
  if (!leave.length) return;
  const n = plural(ids.length, 'item');
  return editItems(
    ids,
    { removeFolders: leave },
    { what: `remove ${n} from this folder`, done: `Removed ${n} from this folder` },
  );
}

/** A job (the strip shows its progress); this resolves when it's done. */
export async function refreshThumbnails(ids: string[]): Promise<void> {
  if (!ids.length || !canEdit()) return;
  await mutate(() => api.refreshThumbnails(ids), `Refreshed ${plural(ids.length, 'thumbnail')}`);
}

/** Quiet, like dragging anything into place; Ctrl+Z undoes it. */
export async function reorder(ids: string[], beforeId: string | null): Promise<void> {
  const folderId = currentFolderId();
  if (!folderId || !ids.length || !canEdit()) return;
  const r = await mutate(() => api.reorderItems(folderId, ids, beforeId));
  // The core switches the folder to manual order; drop a temporary sort so the result shows.
  if (r && view.sort) view.setSort(null);
}

export function openTags(): void {
  if (selection.count && canEdit()) ui.openOverlay('tags');
}
/** "Move to…" (M): Enter moves out of the folder you're in; F's picker adds instead. */
export function openMoveTo(): void {
  if (selection.count && canEdit()) ui.openOverlay('folderPicker', { move: true });
}

/** Pick a picture file to show as this item's thumbnail (Eagle's custom thumbnail). */
export async function customThumbnail(id: string): Promise<void> {
  if (!canEdit()) return;
  try {
    const [path] = await api.pickFiles();
    if (path) await mutate(() => api.setCustomThumbnail(id, path), 'Changed the thumbnail');
  } catch (e) {
    fail(e);
  }
}

/** The folder you're in shows this item on its card. */
export async function setFolderCover(id: string): Promise<void> {
  const folderId = currentFolderId();
  if (!folderId || !canEdit()) return;
  await mutate(() => api.updateFolder(folderId, { coverId: id }), 'Set as the folder’s cover');
}
