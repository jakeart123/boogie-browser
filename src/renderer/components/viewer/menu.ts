// The right-click menu on the picture in the detail view and quick look. It acts on the item on
// screen (the grid's menu acts on the selection) and uses the same helpers as the grid, so the
// read-only rule, confirms and toasts match.
import { openContextMenu, type MenuItem } from '../../lib/contextMenu.svelte';
import { readOnlyTip } from '../../lib/edit';
import {
  copyItems,
  copyLink,
  copyPaths,
  exportItems,
  openDefault,
  openSource,
  reveal,
} from '../../lib/files';
import { items } from '../../lib/stores/items.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import * as act from './actions';
import { viewer } from './state.svelte';

/** What the video player can do with the frame on screen. */
export interface FrameActions {
  copy(): void;
  save(): void;
  asThumbnail(): void;
}

/** A menu entry that edits the library: disabled, saying why, while it's read-only. */
function lockable(m: MenuItem): MenuItem {
  const lock = readOnlyTip();
  return lock ? { ...m, disabled: true, title: lock } : m;
}

export function frameMenuItems(f: FrameActions, edit = lockable): MenuItem[] {
  return [
    { label: 'Copy frame', keys: 'Shift C', run: () => f.copy() },
    { label: 'Save frame…', keys: 'Shift S', run: () => f.save() },
    edit({ label: 'Use this frame as the thumbnail', run: () => f.asThumbnail() }),
  ];
}

export function openItemMenu(e: MouseEvent, id: string): void {
  openContextMenu(e, itemMenu(id));
}

function itemMenu(id: string): MenuItem[] {
  const lock = readOnlyTip();
  const edit = (item: MenuItem): MenuItem => ({ ...item, disabled: !!lock, title: lock });
  const ids = [id];
  const brief = items.brief(id);
  const full = items.full(id);

  const outward: MenuItem[] = [
    { label: 'Open in reference window', keys: 'Ctrl O', run: () => act.openReferenceHere(id) },
    { label: 'Open with default app', keys: 'Shift Enter', run: () => openDefault(id) },
    { label: 'Reveal in folder', run: () => reveal(id) },
    { label: 'Copy', keys: 'Ctrl C', run: () => copyItems(ids) },
    { label: 'Copy file path', run: () => copyPaths(ids) },
    { label: 'Copy link', run: () => copyLink('item', ids) },
  ];
  if (full?.url)
    outward.push({ label: 'Open source URL', keys: 'Ctrl Shift O', run: () => openSource(id) });

  if (brief?.isDeleted ?? full?.isDeleted) {
    return [
      ...outward,
      { separator: true },
      edit({ label: 'Restore', run: () => act.restore(id) }),
      edit({
        label: 'Delete permanently',
        keys: 'Del',
        danger: true,
        run: () => act.deleteForever(id),
      }),
    ];
  }

  const star = brief?.star ?? full?.star ?? 0;
  const rate = (n: number): MenuItem => ({
    label: n === 0 ? 'No rating' : '★'.repeat(n),
    keys: String(n),
    checked: star === n,
    run: () => act.rate(id, n),
  });
  const p = viewer.player;
  const frames: FrameActions | null =
    p?.kind === 'video' && p.copyFrame && p.saveFrame && p.frameAsThumbnail
      ? { copy: p.copyFrame, save: p.saveFrame, asThumbnail: p.frameAsThumbnail }
      : null;

  const menu: MenuItem[] = [
    ...outward,
    { label: 'Export…', run: () => exportItems(ids) },
    { label: 'Add to other library…', run: () => ui.openDialog('copyToLibrary', { ids }) },
    { separator: true },
    edit({ label: 'Rate', submenu: [0, 1, 2, 3, 4, 5].map(rate) }),
    edit({ label: 'Add tags…', keys: 'T', run: () => ui.openOverlay('tags', { ids }) }),
    edit({
      label: 'Add to folder…',
      keys: 'F',
      run: () => ui.openOverlay('folderPicker', { ids }),
    }),
  ];
  if (act.inFolderView())
    menu.push(
      edit({
        label: 'Remove from this folder',
        keys: 'Ctrl Del',
        run: () => act.removeFromFolder(id),
      }),
    );
  menu.push(edit({ label: 'Rename…', keys: 'F2', run: () => ui.openOverlay('rename', { ids }) }));
  if (frames) menu.push({ separator: true }, ...frameMenuItems(frames, edit));
  menu.push(
    { separator: true },
    edit({ label: 'Move to trash', keys: 'Del', danger: true, run: () => act.trashOrDelete(id) }),
  );
  return menu;
}
