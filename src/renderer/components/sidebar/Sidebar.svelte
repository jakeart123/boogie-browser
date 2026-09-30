<script lang="ts">
  // The left column: library switcher on top, then one scrolling body with the special views,
  // Quick Access, tags, smart folders and the folder tree. Everything under it is in this folder.
  import { onMount } from 'svelte';
  import { focus, registerCommands } from '../../lib/commands.svelte';
  import { canEdit } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import FolderTree from './FolderTree.svelte';
  import LibraryHeader from './LibraryHeader.svelte';
  import Nav from './Nav.svelte';
  import QuickAccess from './QuickAccess.svelte';
  import SmartFolders from './SmartFolders.svelte';
  import TagsSection from './TagsSection.svelte';
  import './sidebar.css';

  let scroller = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let viewH = $state(0);

  onMount(() =>
    registerCommands([
      {
        id: 'sidebar.newSmartFolder',
        title: 'New smart folder…',
        group: 'Folders',
        icon: 'sparkles',
        keys: ['Ctrl+Alt+Shift+N'],
        when: (c) => c.region !== 'overlay' && !!library.state && !ui.dialog && !ui.picker,
        run: () => void (canEdit() && ui.openDialog('smartFolderEdit', {})),
      },
    ]),
  );
</script>

<!-- Keyboard focus belongs to the sidebar as soon as you click or tab into it. -->
<div
  class="sb"
  role="presentation"
  onpointerdowncapture={() => (focus.region = 'sidebar')}
  onfocusin={() => (focus.region = 'sidebar')}
>
  <LibraryHeader />
  {#if library.state}
    <div
      class="sb-scroll"
      bind:this={scroller}
      bind:clientHeight={viewH}
      onscroll={() => scroller && (scrollTop = scroller.scrollTop)}
    >
      <Nav />
      <QuickAccess />
      <TagsSection />
      <SmartFolders />
      <FolderTree {scroller} {scrollTop} {viewH} />
    </div>
  {/if}
</div>
