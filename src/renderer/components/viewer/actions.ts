// What the viewer does to the item on screen. The tiles are hidden behind it, so every change says
// so in a toast (with Undo where there is something to undo). An item that leaves the view (trash,
// remove from this folder) also leaves the list the viewer steps through, and the next one shows.
import { api, inElectron } from '../../lib/api';
import { canEdit, editItems, fail, mutate } from '../../lib/edit';
import { leaveFolders } from '../../lib/folders';
import { items } from '../../lib/stores/items.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';

export function rate(id: string, stars: number) {
  return editItems(
    [id],
    { star: stars },
    {
      done: stars ? `Rated ${stars} ${stars === 1 ? 'star' : 'stars'}` : 'Rating cleared',
    },
  );
}

/** The item's place in the list after `id` is taken out of it (the next one moves up). */
export function indexAfterRemoval(ids: readonly string[], index: number, id: string): number {
  const at = ids.indexOf(id);
  if (at < 0) return index;
  const left = ids.length - 1;
  return Math.max(0, Math.min(at < index ? index - 1 : index, left - 1));
}

/** Take an item out of the viewer's list; close the viewer when nothing is left. */
export function dropFromViewer(id: string): void {
  const v = ui.viewer;
  if (!v || !v.ids.includes(id)) return;
  const ids = v.ids.filter((x) => x !== id); // a new array: the grid's result may be this same list
  if (!ids.length) return void (ui.viewer = null);
  ui.viewer = { ...v, ids, index: indexAfterRemoval(v.ids, v.index, id) };
}

const isTrashed = (id: string) => items.brief(id)?.isDeleted ?? items.full(id)?.isDeleted ?? false;

/** Del: to the trash, and on to the next item. An item already in the trash is deleted for good. */
export async function trashOrDelete(id: string): Promise<void> {
  if (!canEdit()) return;
  if (isTrashed(id)) return deleteForever(id);
  const r = await mutate(() => api.trashItems([id]), 'Moved to the trash');
  if (r?.changed) dropFromViewer(id);
}

export async function deleteForever(id: string): Promise<void> {
  if (!canEdit()) return;
  const ok = await ui.confirm(
    'Delete this item permanently?',
    'It leaves the library. Boogie keeps a recoverable copy outside it, but it will not show up in Eagle anymore.',
    'Delete',
    true,
  );
  if (!ok) return;
  const r = await mutate(() => api.deletePermanently([id]), 'Deleted 1 item');
  if (r?.changed) dropFromViewer(id);
}

export async function restore(id: string): Promise<void> {
  if (!canEdit()) return;
  const r = await mutate(() => api.restoreItems([id]), 'Restored 1 item');
  if (r?.changed) dropFromViewer(id); // it left the Trash you are looking at
}

/** The folder you are viewing (and the subfolders it shows): Ctrl+Delete. */
export const inFolderView = () => view.scope.kind === 'folder';

export async function removeFromFolder(id: string): Promise<void> {
  const leave = leaveFolders(view.scope, '');
  if (!leave.length) return;
  const r = await editItems([id], { removeFolders: leave }, { done: 'Removed from this folder' });
  if (r?.changed) dropFromViewer(id);
}

/**
 * The reference window steps through the list the viewer was opened on (Eagle: the arrow keys go
 * through the selection): a window of it around this item, as a plain array (the viewer's list is
 * reactive state, which can't cross to the main process).
 */
export async function openReferenceHere(id: string): Promise<void> {
  const v = ui.viewer;
  const at = v ? v.ids.indexOf(id) : -1;
  const ids = v && at >= 0 ? [...v.ids.slice(Math.max(0, at - 2000), at + 2000)] : [id];
  try {
    await api.openReferenceWindow(id, ids);
  } catch (e) {
    fail(e);
  }
}

// ── video frames (Eagle: Shift+C copies the frame, Shift+S saves it) ──

/** The frame on screen as PNG. The video must be same-origin or loaded with crossorigin. */
export function frameBlob(v: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height)
    return Promise.reject(new Error('There is no frame to grab yet.'));
  g.drawImage(v, 0, 0);
  return new Promise((done, failed) =>
    c.toBlob((b) => (b ? done(b) : failed(new Error('Could not grab this frame.'))), 'image/png'),
  );
}

/** "clip.mp4" at 83.4 s -> "clip 1m23s.png" (a name that sorts and says where it came from). */
export function frameFileName(itemName: string, seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${itemName} ${m ? `${m}m` : ''}${String(s % 60).padStart(m ? 2 : 1, '0')}s.png`;
}

export async function copyFrame(v: HTMLVideoElement): Promise<void> {
  try {
    const blob = await frameBlob(v);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    ui.toast('Copied the frame', { kind: 'ok', ms: 2000 });
  } catch (e) {
    fail(e, 'Could not copy the frame: ');
  }
}

/** A download: Electron asks where to save it, a browser uses its downloads folder. */
export async function saveFrame(v: HTMLVideoElement, itemName: string): Promise<void> {
  try {
    const blob = await frameBlob(v);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = frameFileName(itemName, v.currentTime);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (!inElectron) ui.toast(`Saved ${a.download}`, { kind: 'ok', ms: 2500 });
  } catch (e) {
    fail(e, 'Could not save the frame: ');
  }
}

/** Eagle's "set as cover": the frame becomes the item's thumbnail (in the library, for the partner too). */
export async function frameAsThumbnail(v: HTMLVideoElement, id: string): Promise<void> {
  if (!canEdit()) return;
  try {
    const bytes = new Uint8Array(await (await frameBlob(v)).arrayBuffer());
    await mutate(() => api.setCustomThumbnailBytes!(id, bytes), 'Changed the thumbnail');
  } catch (e) {
    fail(e);
  }
}
