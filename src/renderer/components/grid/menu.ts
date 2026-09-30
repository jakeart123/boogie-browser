// The right-click menu for one or more selected tiles.
import { openContextMenu, type MenuItem } from '../../lib/contextMenu.svelte';
import { readOnlyTip } from '../../lib/edit';
import {
  copyItems,
  copyLink,
  copyPaths,
  exportItems,
  openDefault,
  openReference,
  reveal,
} from '../../lib/files';
import { items } from '../../lib/stores/items.svelte';
import { selection } from '../../lib/stores/selection.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import * as act from './actions';

export function openTileMenu(e: MouseEvent, id: string): void {
  // Right-clicking something outside the selection selects it first, like a file manager.
  if (!selection.has(id)) selection.select(id, 'replace');
  openContextMenu(e, buildMenu(id));
}

function buildMenu(id: string): MenuItem[] {
  const ids = selection.ids;
  const many = ids.length > 1;
  const lock = readOnlyTip();
  /** An item that changes the library: disabled with the reason while read-only. */
  const edit = (item: MenuItem): MenuItem => ({ ...item, disabled: !!lock, title: lock });
  const inTrash = view.scope.kind === 'trash';
  const inFolder = view.scope.kind === 'folder';
  const open = { label: 'Open', keys: 'Enter', run: () => act.openViewer('detail', id) };

  if (inTrash) {
    return [
      open,
      { label: 'Reveal in folder', run: () => reveal(id) },
      { label: 'Copy file path', run: () => copyPaths(ids) },
      { separator: true },
      edit({ label: 'Restore', run: () => act.restore(ids) }),
      edit({
        label: 'Delete permanently',
        keys: 'Del',
        danger: true,
        run: () => act.deleteForever(ids),
      }),
    ];
  }

  const stars = new Set(ids.map((x) => items.brief(x)?.star ?? 0));
  const rate = (n: number): MenuItem => ({
    label: n === 0 ? 'No rating' : `${'★'.repeat(n)}`,
    keys: String(n),
    checked: stars.size === 1 && stars.has(n),
    run: () => act.rate(ids, n),
  });

  const menu: MenuItem[] = [
    open,
    { label: 'Open in reference window', keys: 'Ctrl O', run: () => openReference(id) },
    { label: 'Open with default app', run: () => openDefault(id) },
    { label: 'Reveal in folder', run: () => reveal(id) },
    { label: many ? 'Copy items' : 'Copy', keys: 'Ctrl C', run: () => copyItems(ids) },
    { label: 'Copy file path', run: () => copyPaths(ids) },
    { label: many ? 'Copy links' : 'Copy link', run: () => copyLink('item', ids) },
    {
      label: many ? 'Export items…' : 'Export…',
      keys: 'Ctrl Shift E',
      run: () => exportItems(ids),
    },
    { label: 'Add to other library…', run: () => ui.openDialog('copyToLibrary', { ids }) },
    { separator: true },
    edit({ label: 'Rate', submenu: [0, 1, 2, 3, 4, 5].map(rate) }),
    edit({ label: 'Add tags…', keys: 'T', run: () => ui.openOverlay('tags') }),
    edit({ label: 'Add to folder…', keys: 'F', run: () => ui.openOverlay('folderPicker') }),
  ];
  if (inFolder)
    menu.push(
      edit({ label: 'Move to folder…', keys: 'M', run: () => act.openMoveTo() }),
      edit({
        label: 'Remove from this folder',
        keys: 'Ctrl Del',
        run: () => act.removeFromFolder(ids),
      }),
    );
  menu.push(
    edit(
      many
        ? { label: 'Batch rename…', keys: 'Ctrl R', run: () => ui.openOverlay('rename') }
        : { label: 'Rename…', keys: 'F2', run: () => ui.openOverlay('rename') },
    ),
    edit({ label: 'Refresh thumbnail', run: () => act.refreshThumbnails(ids) }),
  );
  if (!many)
    menu.push(edit({ label: 'Set custom thumbnail…', run: () => act.customThumbnail(id) }));
  if (inFolder && !many)
    menu.push(edit({ label: 'Use as folder cover', run: () => act.setFolderCover(id) }));
  if (ids.length >= 2 && ids.length <= 4)
    menu.push({ label: 'Compare', keys: 'C', run: () => act.compare(ids) });
  menu.push(
    { label: 'Find duplicates of this…', run: () => ui.openDialog('duplicates', { ids }) },
    { separator: true },
    edit({ label: 'Move to trash', keys: 'Del', danger: true, run: () => act.trash(ids) }),
  );
  return menu;
}
