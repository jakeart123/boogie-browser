// App-wide commands on the selected items: undo and redo, tags, folders, rename.
import type { Command } from '../commands.svelte';
import { redo, undo } from '../edit';
import { addToLastFolder, lastFolderId } from '../lastFolder';
import { ui } from '../stores/ui.svelte';
import { hasSelection } from './shared';

export function itemCommands(): Command[] {
  return [
    {
      id: 'edit.undo',
      title: 'Undo',
      group: 'Edit',
      icon: 'undo-2',
      keys: ['Ctrl+Z'],
      when: (c) => c.region !== 'overlay',
      run: () => undo(),
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      group: 'Edit',
      icon: 'redo-2',
      keys: ['Ctrl+Shift+Z', 'Ctrl+Y'],
      when: (c) => c.region !== 'overlay',
      run: () => redo(),
    },
    {
      id: 'item.tags',
      title: 'Tags…',
      group: 'Tags',
      icon: 'tag',
      keys: ['T'],
      when: hasSelection,
      run: () => ui.openOverlay('tags'),
    },
    {
      id: 'item.folderPicker',
      title: 'Add to folder…',
      group: 'Folders',
      icon: 'folder-input',
      keys: ['F', 'Ctrl+Shift+J'],
      when: hasSelection,
      run: () => ui.openOverlay('folderPicker'),
    },
    {
      id: 'item.repeatFolder',
      title: 'Add to the last folder again',
      group: 'Folders',
      icon: 'folder-input',
      keys: ['Shift+D'],
      when: (c) => hasSelection(c) && !!lastFolderId(),
      run: () => addToLastFolder(),
    },
    {
      id: 'item.rename',
      title: 'Rename…',
      group: 'Edit',
      icon: 'pencil',
      keys: ['F2', 'Ctrl+R'],
      // Not while the sidebar has the keyboard: there F2 renames the folder under the cursor.
      when: (c) => hasSelection(c) && c.region !== 'sidebar',
      run: () => ui.openOverlay('rename'),
    },
  ];
}
