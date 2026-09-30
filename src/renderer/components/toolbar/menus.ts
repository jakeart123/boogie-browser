// Menu contents for the toolbar: view options (title chevron), sort, and "+".
import type { MenuItem } from '../../lib/contextMenu.svelte';
import { readOnlyTip, toastWithUndo } from '../../lib/edit';
import { importFiles, importFolder, pasteFromClipboard } from '../../lib/files';
import {
  LAYOUTS,
  setLayout,
  toggleChecker,
  toggleMeta,
  toggleNames,
  toggleSubfolders,
} from '../../lib/prefs';
import { setFolderSort, SORTS } from '../../lib/sorts';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import type { SortSpec } from '../../../shared/types';
import { newFolder } from '../../lib/appCommands';

export function viewMenu(): MenuItem[] {
  return [
    ...LAYOUTS.map((l) => ({
      label: l.label,
      checked: view.layout === l.id,
      run: () => setLayout(l.id),
    })),
    { separator: true },
    { label: 'Show names', keys: 'Ctrl Alt 4', checked: view.showNames, run: toggleNames },
    { label: 'Show dimensions', keys: 'Ctrl Alt 5', checked: view.showMeta, run: toggleMeta },
    {
      label: 'Show subfolder contents',
      keys: 'Ctrl Alt 7',
      checked: view.showSubfolderContents,
      run: toggleSubfolders,
    },
    {
      label: 'Checkerboard behind pictures',
      checked: view.checker,
      run: toggleChecker,
    },
    {
      label: 'Grayscale thumbnails',
      keys: 'Ctrl Alt G',
      checked: view.grayscale,
      run: () => (view.grayscale = !view.grayscale),
    },
  ];
}

// ── sort ──

export function currentSort(): SortSpec {
  return view.sort ?? view.result?.sort ?? { by: 'IMPORT', ascending: false };
}

async function makeFolderDefault(folderId: string, sort: SortSpec): Promise<void> {
  const r = await setFolderSort(folderId, sort.by, sort.ascending);
  if (r) toastWithUndo('Saved as this folder’s default sort', r.groupId);
}

export function sortMenu(): MenuItem[] {
  const cur = currentSort();
  const scope = view.scope;
  const inFolder = scope.kind === 'folder';
  const fixedDirection = cur.by === 'RANDOM' || cur.by === 'MANUAL';
  const items: MenuItem[] = SORTS.filter((o) => !o.folderOnly || inFolder).map((o) => ({
    label: o.label,
    checked: cur.by === o.by,
    run: () => view.setSort({ by: o.by, ascending: cur.by === o.by ? cur.ascending : o.ascending }),
  }));
  items.push(
    { separator: true },
    {
      label: 'Ascending',
      checked: cur.ascending,
      disabled: fixedDirection,
      run: () => view.setSort({ by: cur.by, ascending: true }),
    },
    {
      label: 'Descending',
      checked: !cur.ascending,
      disabled: fixedDirection,
      run: () => view.setSort({ by: cur.by, ascending: false }),
    },
  );
  if (scope.kind === 'folder') {
    const folderId = scope.id;
    const lock = readOnlyTip();
    items.push(
      { separator: true },
      {
        label: 'Make this the folder’s default',
        disabled: !!lock,
        title: lock,
        run: () => void makeFolderDefault(folderId, cur),
      },
    );
  }
  return items;
}

// ── plus ──

export function addMenu(): MenuItem[] {
  const lock = readOnlyTip();
  const edit = (item: MenuItem): MenuItem => ({ ...item, disabled: !!lock, title: lock });
  return [
    edit({ label: 'Import files…', run: importFiles }),
    edit({ label: 'Import a folder…', run: importFolder }),
    edit({ label: 'Add from URL…', run: () => ui.openDialog('addUrl') }),
    edit({ label: 'Paste from clipboard', keys: 'Ctrl V', run: () => pasteFromClipboard() }),
    { separator: true },
    edit({ label: 'New folder', keys: 'Ctrl Shift N', run: newFolder }),
    { separator: true },
    { label: 'Find duplicates…', run: () => ui.openDialog('duplicates') },
  ];
}
