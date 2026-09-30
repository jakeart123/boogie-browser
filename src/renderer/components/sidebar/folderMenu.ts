// The right-click menu of a folder row.
import { api } from '../../lib/api';
import type { MenuItem } from '../../lib/contextMenu.svelte';
import { canEdit, mutate, readOnlyTip } from '../../lib/edit';
import { folderSortMenu } from '../../lib/sorts';
import { ui } from '../../lib/stores/ui.svelte';
import { FOLDER_COLORS, type FolderColor, type FolderNode } from '../../../shared/types';
import { copyLink, exportFolder } from '../../lib/files';
import { deleteFolder, inQuickAccess, sortFoldersAZ, toggleQuickAccess } from './actions';

const COLOR_NAMES: [FolderColor, string][] = [
  ['red', 'Red'],
  ['orange', 'Orange'],
  ['yellow', 'Yellow'],
  ['green', 'Green'],
  ['aqua', 'Aqua'],
  ['blue', 'Blue'],
  ['purple', 'Purple'],
  ['pink', 'Pink'],
];

function setColor(id: string, iconColor: FolderColor | null): void {
  if (canEdit()) void mutate(() => api.updateFolder(id, { iconColor }));
}

export function folderMenu(
  node: FolderNode,
  on: { newSub: () => void; rename: () => void },
): MenuItem[] {
  const lock = readOnlyTip();
  /** Changes the library: disabled, with the reason, while read-only. */
  const edit = (item: MenuItem): MenuItem => ({ ...item, disabled: !!lock, title: lock });
  const current = node.iconColor && FOLDER_COLORS[node.iconColor] ? node.iconColor : null;
  return [
    edit({ label: 'New subfolder', run: on.newSub }),
    edit({ label: 'Rename', keys: 'F2', run: on.rename }),
    edit({
      label: 'Color',
      submenu: [
        ...COLOR_NAMES.map(([c, label]): MenuItem => ({
          label,
          swatch: FOLDER_COLORS[c],
          checked: current === c,
          run: () => setColor(node.id, c),
        })),
        { separator: true },
        // A hollow dot: no color.
        {
          label: 'None',
          swatch: 'transparent',
          checked: !current,
          run: () => setColor(node.id, null),
        },
      ],
    }),
    edit({ label: 'Edit folder…', run: () => ui.openDialog('folderEdit', { id: node.id }) }),
    edit({ label: 'Sort this folder by', submenu: folderSortMenu(node) }),
    ...(node.children.length > 1
      ? [edit({ label: 'Sort subfolders A to Z', run: () => void sortFoldersAZ(node.id) })]
      : []),
    { separator: true },
    { label: 'Copy link', run: () => void copyLink('folder', node.id) },
    { label: 'Export folder…', run: () => exportFolder(node.id) },
    { separator: true },
    edit({
      label: inQuickAccess('folder', node.id) ? 'Remove from Quick Access' : 'Add to Quick Access',
      run: () => void toggleQuickAccess('folder', node.id),
    }),
    { separator: true },
    edit({
      label: 'Delete folder…',
      keys: 'Del',
      danger: true,
      run: () => void deleteFolder(node.id),
    }),
  ];
}
