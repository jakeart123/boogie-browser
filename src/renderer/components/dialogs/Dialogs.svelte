<script lang="ts">
  // Renders the dialog named by ui.dialog.kind. One at a time; each is its own component and
  // wraps itself in <Modal>. Also starts the job feed so import/duplicate results can open.
  import { onMount } from 'svelte';
  import { registerCommands } from '../../lib/commands.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { jobs } from '../status/jobs.svelte';
  import AddUrlDialog from './AddUrlDialog.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import ConflictsDialog from './ConflictsDialog.svelte';
  import CopyToLibraryDialog from './CopyToLibraryDialog.svelte';
  import DuplicatesDialog from './DuplicatesDialog.svelte';
  import ExportDialog from './ExportDialog.svelte';
  import FolderEditDialog from './FolderEditDialog.svelte';
  import ImportDialog from './ImportDialog.svelte';
  import LibrariesDialog from './LibrariesDialog.svelte';
  import PromptDialog from './PromptDialog.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import ShortcutsDialog from './ShortcutsDialog.svelte';
  import SmartFolderEditDialog from './SmartFolderEditDialog.svelte';
  import TagManagerDialog from './TagManagerDialog.svelte';

  // Ways in to the dialogs that nothing else opens: the palette entries and Ctrl+, for settings.
  onMount(() => {
    jobs.init();
    const free = () => !ui.dialog;
    return registerCommands([
      {
        id: 'app.settings',
        title: 'Settings…',
        group: 'App',
        icon: 'settings',
        keys: ['Ctrl+,'],
        allowInInput: true,
        when: free,
        run: () => ui.openDialog('settings'),
      },
      {
        id: 'library.manage',
        title: 'Open or switch library…',
        group: 'Library',
        icon: 'library',
        when: free,
        run: () => ui.openDialog('libraries'),
      },
      {
        id: 'library.create',
        title: 'Create a new library…',
        group: 'Library',
        icon: 'folder-plus',
        when: free,
        run: () => ui.openDialog('libraries', { mode: 'create' }),
      },
      {
        id: 'tags.manage',
        title: 'Manage tags…',
        group: 'Tags',
        icon: 'tags',
        when: () => free() && !!library.state,
        run: () => ui.openDialog('tagManager'),
      },
      {
        id: 'library.conflicts',
        title: 'Show conflicted copies…',
        group: 'Library',
        when: () => free() && !!library.status?.sync.conflicts.length,
        run: () => ui.openDialog('conflicts'),
      },
      {
        id: 'app.shortcuts',
        title: 'Keyboard shortcuts',
        group: 'App',
        icon: 'keyboard',
        keys: ['Ctrl+/', 'Shift+?'],
        when: (c) => free() && c.region !== 'overlay',
        run: () => ui.openDialog('shortcuts'),
      },
      {
        id: 'import.url',
        title: 'Add from URL…',
        group: 'Library',
        icon: 'link',
        when: () => free() && !!library.state && !library.readOnly,
        run: () => ui.openDialog('addUrl'),
      },
      {
        id: 'import.progress',
        title: 'Show the latest import…',
        group: 'Library',
        icon: 'download',
        when: () => free() && !!jobs.latestImport,
        run: () => ui.openDialog('import'),
      },
    ]);
  });

  const d = $derived(ui.dialog);
  const props = $derived(d?.props ?? {});
</script>

<!-- A new openDialog call (even for the same kind) gets a fresh component. -->
{#key d}
  {#if d?.kind === 'libraries'}
    <LibrariesDialog {props} />
  {:else if d?.kind === 'import'}
    <ImportDialog {props} />
  {:else if d?.kind === 'duplicates'}
    <DuplicatesDialog {props} />
  {:else if d?.kind === 'settings'}
    <SettingsDialog />
  {:else if d?.kind === 'confirm'}
    <ConfirmDialog {props} />
  {:else if d?.kind === 'folderEdit'}
    <FolderEditDialog {props} />
  {:else if d?.kind === 'smartFolderEdit'}
    <SmartFolderEditDialog {props} />
  {:else if d?.kind === 'tagManager'}
    <TagManagerDialog />
  {:else if d?.kind === 'conflicts'}
    <ConflictsDialog />
  {:else if d?.kind === 'prompt'}
    <PromptDialog {props} />
  {:else if d?.kind === 'export'}
    <ExportDialog {props} />
  {:else if d?.kind === 'addUrl'}
    <AddUrlDialog />
  {:else if d?.kind === 'copyToLibrary'}
    <CopyToLibraryDialog {props} />
  {:else if d?.kind === 'shortcuts'}
    <ShortcutsDialog />
  {/if}
{/key}
