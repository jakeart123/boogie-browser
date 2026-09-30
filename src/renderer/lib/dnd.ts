// One drag-and-drop vocabulary for the grid, sidebar, inspector and viewer.
// In Electron, dragging items out is a native OS drag of the original files (api.startDrag),
// so a drop back onto our own window arrives as file paths inside the open library; we map
// those back to item ids. In the web dev server, items travel as a custom MIME type instead.
import { api, inElectron } from './api';

export const ITEMS_MIME = 'application/x-boogie-items';

export type Drop =
  | { kind: 'items'; ids: string[] } // our own items (move/add/reorder)
  | { kind: 'files'; paths: string[]; folders: number } // files (and folders) from outside: import
  | { kind: 'url'; url: string } // a link or image dragged from a browser: import by URL
  | null;

// Our own items being dragged, from dragstart until the drag ends. Drop targets use this to tell a
// reorder from an import while the drag is still hovering. In Electron the HTML drag is swapped
// for a native one that carries files, so its dataTransfer can't say whose files they are, and the
// native drag has no dragend we can see when it's dropped in another app. So it ends on dragend or
// drop in our window, on the first pointer event well after it started (pointer events stop while
// any drag is going, so one arriving later means the drag is over), or when the drag leaves the
// window: the next drag to come in may be files from another app, and a drop still recognizes our
// own files by their path (readDrop), so forgetting early costs nothing.
let own: { ids: string[]; since: number } | null = null;

/** The ids of our own items being dragged right now, if any. */
export function ownDragIds(): string[] | null {
  return own?.ids ?? null;
}

let watching = false;
function watchDragEnd(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const end = () => (own = null);
  const pointer = () => {
    if (own && performance.now() - own.since > 500) own = null;
  };
  window.addEventListener('dragend', end, true);
  window.addEventListener('drop', () => setTimeout(end, 0), true); // after the drop handlers ran
  window.addEventListener('pointermove', pointer, true);
  window.addEventListener('pointerdown', pointer, true);
  window.addEventListener('dragleave', (e) => leftWindow(e) && end(), true);
}

/** A dragleave that goes out of the window, not just onto another element in it. */
function leftWindow(e: { relatedTarget: EventTarget | null; clientX: number; clientY: number }) {
  if (e.relatedTarget) return false;
  const { clientX: x, clientY: y } = e;
  return (x <= 0 && y <= 0) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight;
}

/** Call from a tile's dragstart. */
export function beginItemDrag(e: DragEvent, ids: string[]): void {
  own = { ids, since: performance.now() };
  watchDragEnd();
  if (inElectron) {
    e.preventDefault(); // hand over to the native drag, which carries the real files
    api.startDrag(ids);
    return;
  }
  e.dataTransfer?.setData(ITEMS_MIME, JSON.stringify(ids));
  e.dataTransfer!.effectAllowed = 'copyMove';
}

/** Item id from a path like <root>/images/<ID>.info/<file>, if it's inside `libraryRoot`. */
export function itemIdFromPath(path: string, libraryRoot: string): string | null {
  const prefix = libraryRoot.replace(/\/+$/, '') + '/images/';
  if (!path.startsWith(prefix)) return null;
  const m = /^([0-9A-Za-z-]{13,36})\.info\//.exec(path.slice(prefix.length));
  return m ? m[1] : null;
}

/** Decode a drop. `libraryRoot` = the open library's path (to recognize our own files). */
export function readDrop(e: DragEvent, libraryRoot: string | null): Drop {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const custom = dt.getData(ITEMS_MIME);
  if (custom) return { kind: 'items', ids: JSON.parse(custom) };
  if (dt.files.length) {
    const paths = [...dt.files].map((f) => api.getPathForFile(f)).filter(Boolean);
    if (libraryRoot) {
      const ids = paths.map((p) => itemIdFromPath(p, libraryRoot));
      if (ids.length && ids.every(Boolean)) return { kind: 'items', ids: ids as string[] };
    }
    if (paths.length) return { kind: 'files', paths, folders: countFolders(dt) };
  }
  const uri = dt
    .getData('text/uri-list')
    .split('\n')
    .find((l) => l && !l.startsWith('#'));
  if (uri && /^(https?|data):/.test(uri.trim())) return { kind: 'url', url: uri.trim() };
  const html = dt.getData('text/html');
  const src = /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  if (src && /^(https?|data):/.test(src)) return { kind: 'url', url: src };
  return null;
}

/** How many of the dropped files are folders (only readable while the drop event runs). */
function countFolders(dt: DataTransfer): number {
  let n = 0;
  for (const item of dt.items ?? [])
    if (item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory) n++;
  return n;
}

/** True if the drag carries something we can accept (for dragover highlighting). */
export function dragHasPayload(e: DragEvent): boolean {
  const types = e.dataTransfer?.types ?? [];
  return (
    types.includes(ITEMS_MIME) ||
    types.includes('Files') ||
    types.includes('text/uri-list') ||
    types.includes('text/html')
  );
}
