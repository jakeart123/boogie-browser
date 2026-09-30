// App-wide commands on the library: folders, imports, the trash, reload, duplicates.
import { tick } from 'svelte';
import { api } from '../api';
import { commands, type Command } from '../commands.svelte';
import { canEdit, fail, mutate } from '../edit';
import { exportFolder, importFiles, importFolder } from '../files';
import { plural } from '../format';
import { library } from '../stores/library.svelte';
import { ui } from '../stores/ui.svelte';
import { view } from '../stores/view.svelte';
import { free } from './shared';

/** Read every file again, like Eagle's reload (the focus check only looks at what changed). */
async function reloadLibrary(): Promise<void> {
  try {
    await api.refresh({ full: true });
    ui.toast('Reloaded the library', { kind: 'ok', ms: 2500 });
  } catch (e) {
    fail(e);
  }
}

/**
 * Ctrl+Shift+N and "+ > New folder": the sidebar makes it (with its name editor, inside the folder
 * you are looking at), so show the sidebar first and let it mount.
 */
export async function newFolder(): Promise<void> {
  if (!library.state || !canEdit()) return;
  ui.sidebarVisible = true;
  await tick();
  await commands.run('sidebar.newFolder');
}

/** Empty the trash (the toolbar in Trash, the sidebar's Trash menu, the palette), after asking. */
export async function emptyTrash(): Promise<void> {
  const n = library.counts?.trash ?? 0;
  if (!n || !canEdit()) return;
  // A running Eagle on the partner's computer never notices items leaving (live-behavior §4).
  const lib = library.current;
  const partner = lib?.shared
    ? `\n\n${lib.partnerName ? `${lib.partnerName}’s Eagle` : 'Your partner’s Eagle'} will keep showing them until it restarts.`
    : '';
  const ok = await ui.confirm(
    'Empty the trash?',
    `${plural(n, 'item')} leave the library. Boogie keeps a recoverable copy outside it, but they will not show up in Eagle anymore.${partner}`,
    'Empty trash',
    true,
  );
  if (ok) await mutate(() => api.emptyTrash(), `Emptied the trash (${plural(n, 'item')})`);
}

export function libraryCommands(): Command[] {
  return [
    {
      id: 'folder.goTo',
      mainWindow: true,
      title: 'Go to folder…',
      group: 'Folders',
      icon: 'folder-open',
      keys: ['Ctrl+J'],
      when: (c) => !!library.state && free(c),
      run: () => ui.openOverlay('goToFolder'),
    },
    {
      id: 'folder.new',
      mainWindow: true,
      title: 'New folder',
      group: 'Folders',
      icon: 'folder-plus',
      keys: ['Ctrl+Shift+N'],
      when: (c) => !!library.state && free(c),
      run: newFolder,
    },
    {
      id: 'folder.autoTags',
      mainWindow: true,
      title: 'Set auto-tags for this folder…',
      group: 'Folders',
      icon: 'tag',
      keys: ['Ctrl+Shift+R'],
      when: (c) => free(c) && !ui.viewer && view.scope.kind === 'folder' && !library.readOnly,
      run: () => {
        if (view.scope.kind === 'folder')
          ui.openDialog('folderEdit', { id: view.scope.id, focus: 'tags' });
      },
    },
    {
      id: 'folder.export',
      title: 'Export this folder…',
      group: 'Folders',
      icon: 'upload',
      when: (c) => free(c) && view.scope.kind === 'folder',
      run: () => {
        if (view.scope.kind === 'folder') exportFolder(view.scope.id);
      },
    },
    {
      id: 'import.files',
      title: 'Import files…',
      group: 'Library',
      icon: 'download',
      when: () => !library.readOnly,
      run: importFiles,
    },
    {
      id: 'import.folder',
      title: 'Import a folder…',
      group: 'Library',
      icon: 'folder-plus',
      when: () => !library.readOnly,
      run: importFolder,
    },
    {
      id: 'library.emptyTrash',
      title: 'Empty trash…',
      group: 'Library',
      icon: 'trash-2',
      when: (c) => free(c) && !library.readOnly && !!library.counts?.trash,
      run: emptyTrash,
    },
    {
      id: 'library.reload',
      title: 'Reload the library from disk',
      group: 'Library',
      icon: 'refresh-cw',
      when: () => !!library.state,
      run: reloadLibrary,
    },
    {
      id: 'dupes.open',
      title: 'Find duplicates…',
      group: 'Library',
      icon: 'files',
      run: () => ui.openDialog('duplicates'),
    },
  ];
}
