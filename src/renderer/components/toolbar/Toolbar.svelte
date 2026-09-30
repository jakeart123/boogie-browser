<script lang="ts">
  // The 48 px bar above the grid: panel toggles, back/forward, where you are (with view options),
  // thumbnail zoom, sort, color search, filters, the command bar, "+" and Settings. Its empty
  // middle is the window's drag region. Also registers the app-wide shortcuts (see globalCommands.ts).
  import type { Component } from 'svelte';
  import ArrowDownWideNarrow from '@lucide/svelte/icons/arrow-down-wide-narrow';
  import ArrowUpNarrowWide from '@lucide/svelte/icons/arrow-up-narrow-wide';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Folder from '@lucide/svelte/icons/folder';
  import Funnel from '@lucide/svelte/icons/funnel';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Images from '@lucide/svelte/icons/images';
  import Inbox from '@lucide/svelte/icons/inbox';
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import Pipette from '@lucide/svelte/icons/pipette';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Tag from '@lucide/svelte/icons/tag';
  import Tags from '@lucide/svelte/icons/tags';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { openMenuBelow } from '../../lib/contextMenu.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import { setThumbSize, ZOOM_MAX, ZOOM_MIN } from '../../lib/prefs';
  import { sortLabel } from '../../lib/sorts';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { FOLDER_COLORS } from '../../../shared/types';
  import { filterUi } from '../filters/filterUi.svelte';
  import { emptyTrash } from '../../lib/appCommands';
  import { addMenu, currentSort, sortMenu, viewMenu } from './menus';

  // Where you are: an icon, a name, and (for folders) the folder's color.
  const where = $derived.by<{ name: string; icon: Component<any>; color?: string }>(() => {
    const s = view.scope;
    switch (s.kind) {
      case 'all':
        return { name: 'All', icon: Images };
      case 'uncategorized':
        return { name: 'Uncategorized', icon: Inbox };
      case 'untagged':
        return { name: 'Untagged', icon: Tags };
      case 'trash':
        return { name: 'Trash', icon: Trash2 };
      case 'random':
        return { name: 'Random', icon: Shuffle };
      case 'folder': {
        const f = library.folder(s.id)?.node;
        return {
          name: f?.name ?? 'Folder',
          icon: Folder,
          color: f?.iconColor ? FOLDER_COLORS[f.iconColor] : undefined,
        };
      }
      case 'smartFolder': {
        const f = library.smartFolders.get(s.id);
        return {
          name: f?.name ?? 'Smart folder',
          icon: Sparkles,
          color: f?.iconColor ? FOLDER_COLORS[f.iconColor] : undefined,
        };
      }
      case 'tag':
        return { name: s.name, icon: Tag };
      case 'ids':
        return { name: 'Selected items', icon: Images };
    }
  });

  const sort = $derived(currentSort());
  const SortIcon = $derived(sort.ascending ? ArrowUpNarrowWide : ArrowDownWideNarrow);
  const count = $derived(view.result ? view.result.total.toLocaleString() : '');
  // Before a library is open there is nothing to sort, filter, zoom or add to.
  const noLib = $derived(!library.state);
</script>

<div class="tb" role="toolbar" aria-label="Toolbar">
  <button
    class="ib"
    class:on={ui.sidebarVisible}
    title="Show or hide the sidebar (Ctrl+Alt+1)"
    aria-label="Show or hide the sidebar"
    aria-pressed={ui.sidebarVisible}
    onclick={() => (ui.sidebarVisible = !ui.sidebarVisible)}><PanelLeft size={16} /></button
  >
  <button
    class="ib"
    title="Back (Alt+Left)"
    aria-label="Back"
    disabled={!view.back.length}
    onclick={() => view.goBack()}><ChevronLeft size={16} /></button
  >
  <button
    class="ib fwd"
    title="Forward (Alt+Right)"
    aria-label="Forward"
    disabled={!view.forward.length}
    onclick={() => view.goForward()}><ChevronRight size={16} /></button
  >

  <button
    class="ttl"
    disabled={noLib}
    title="View options"
    aria-haspopup="menu"
    onclick={(e) => openMenuBelow(e.currentTarget, viewMenu())}
  >
    {#if where.color}
      <where.icon size={18} style="color:{where.color};fill:{where.color}" />
    {:else}
      <where.icon size={17} class="muted" />
    {/if}
    <span class="nm">{where.name}</span>
    <ChevronDown size={14} class="muted" />
  </button>
  <span class="n" aria-label="Items shown">{count}</span>
  {#if view.scope.kind === 'trash' && library.counts?.trash}
    <button
      class="emptytrash"
      disabled={library.readOnly}
      title={readOnlyTip() ?? 'Remove everything in the trash from the library'}
      onclick={() => emptyTrash()}>Empty trash</button
    >
  {/if}

  <div class="sp"></div>

  <label class="zoom" title="Thumbnail size (Ctrl+= and Ctrl+-)">
    <ImageIcon size={13} />
    <input
      type="range"
      min={ZOOM_MIN}
      max={ZOOM_MAX}
      step="10"
      aria-label="Thumbnail size"
      disabled={noLib}
      value={view.thumbSize}
      oninput={(e) => setThumbSize(Number(e.currentTarget.value))}
    />
    <ImageIcon size={17} />
  </label>

  <button
    class="ib"
    title="Sort: {sortLabel(sort)}"
    aria-label="Sort"
    disabled={noLib}
    aria-haspopup="menu"
    onclick={(e) => openMenuBelow(e.currentTarget, sortMenu())}
  >
    <SortIcon size={16} />
  </button>
  <button
    class="ib pip"
    class:on={!!view.filter.color}
    disabled={noLib}
    title="Search by color (Alt+C)"
    aria-label="Search by color"
    onclick={(e) => filterUi.openPopover('color', e.currentTarget)}><Pipette size={16} /></button
  >
  <button
    class="ib"
    class:on={view.filtered}
    bind:this={filterUi.toolbarAnchor}
    disabled={noLib}
    title="Filters and saved filters (Alt+F)"
    aria-label="Filters"
    aria-haspopup="dialog"
    onclick={(e) => filterUi.openPopover('saved', e.currentTarget)}><Funnel size={15} /></button
  >

  <button
    class="cmd"
    onclick={() => ui.openOverlay('command')}
    aria-label="Search, filter, or run a command"
  >
    <Search size={14} />
    <span class="ph">Search, filter, or run a command</span>
    <kbd>Ctrl K</kbd>
  </button>

  <button
    class="ib"
    title={noLib
      ? 'Open a library first'
      : (readOnlyTip() ?? 'Add files, a folder or a new folder')}
    aria-label="Add"
    disabled={noLib}
    aria-haspopup="menu"
    onclick={(e) => openMenuBelow(e.currentTarget, addMenu())}><Plus size={17} /></button
  >
  <!-- Always here (the sidebar can be hidden), so Settings never depends on knowing Ctrl+K. -->
  <button
    class="ib"
    title="Settings (Ctrl+,)"
    aria-label="Settings"
    onclick={() => ui.openDialog('settings')}><Settings size={16} /></button
  >
  <button
    class="ib"
    class:on={ui.inspectorVisible}
    title="Show or hide the inspector (Ctrl+Alt+2)"
    aria-label="Show or hide the inspector"
    aria-pressed={ui.inspectorVisible}
    onclick={() => (ui.inspectorVisible = !ui.inspectorVisible)}><PanelRight size={16} /></button
  >
</div>

<style>
  .tb {
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--toolbar-h);
    flex: none;
    padding: 0 10px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    container-type: inline-size;
    -webkit-app-region: drag;
    user-select: none;
  }
  .tb button,
  .tb label,
  .tb input {
    -webkit-app-region: no-drag;
  }
  .ib {
    display: grid;
    place-items: center;
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    color: var(--mu);
  }
  .ib:hover:not(:disabled) {
    background: var(--hov);
    color: var(--tx);
  }
  .ib:disabled {
    color: var(--fa);
    opacity: 0.55;
  }
  .ib.on {
    color: var(--link);
  }
  .ib:focus-visible,
  .ttl:focus-visible,
  .cmd:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -1px;
  }
  .ttl {
    display: flex;
    align-items: center;
    gap: 8px;
    /* Keep the icon and the start of the name visible even in the narrowest window. */
    min-width: 56px;
    height: 30px;
    margin-left: 6px;
    padding: 0 8px;
    flex: 0 1 auto;
    border-radius: 6px;
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
  }
  .ttl:hover:not(:disabled) {
    background: var(--hov);
  }
  .ttl:disabled,
  .zoom input:disabled {
    opacity: 0.45;
  }
  .ttl .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 30ch;
  }
  .ttl :global(.muted) {
    color: var(--fa);
    flex: none;
  }
  .n {
    margin-left: 2px;
    color: var(--fa);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .emptytrash {
    margin-left: 8px;
    height: 24px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--line);
    color: var(--err);
    font-size: 12px;
  }
  .emptytrash:hover:not(:disabled) {
    background: var(--bls);
  }
  .emptytrash:disabled {
    color: var(--fa);
  }
  .sp {
    flex: 1;
    align-self: stretch;
    min-width: 12px;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-right: 10px;
    color: var(--fa);
  }
  .zoom input {
    -webkit-appearance: none;
    appearance: none;
    width: 110px;
    height: 3px;
    border-radius: 3px;
    background: var(--chip-line);
    outline: 0;
  }
  .zoom input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--tx);
    border: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }
  .zoom input:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: 4px;
  }
  .cmd {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 330px;
    min-width: 140px;
    height: 32px;
    margin-left: 6px;
    padding: 0 6px 0 11px;
    border-radius: 8px;
    background: var(--fld);
    border: 1px solid var(--chip-line);
    color: var(--mu);
    text-align: left;
    cursor: text;
  }
  .cmd:hover {
    border-color: var(--fa);
  }
  .cmd .ph {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @container (max-width: 1000px) {
    .zoom input {
      width: 70px;
    }
    .cmd {
      flex-basis: 260px;
    }
  }
  /* A 1280 px window with both panels open lands here: the slider stays, its icons go. */
  @container (max-width: 800px) {
    .zoom {
      margin-right: 4px;
    }
    .zoom :global(svg) {
      display: none;
    }
    .zoom input {
      width: 56px;
    }
    .cmd {
      flex-basis: 176px;
    }
    .cmd kbd {
      display: none;
    }
    .ttl .nm {
      max-width: 16ch;
    }
  }
  @container (max-width: 700px) {
    .zoom {
      display: none;
    }
  }
  /* Very narrow: the command bar shrinks to its search icon so the title keeps its room. */
  @container (max-width: 640px) {
    .cmd {
      flex: none;
      min-width: 0;
      width: 32px;
      padding: 0;
      justify-content: center;
    }
    .cmd .ph {
      display: none;
    }
    .n {
      display: none;
    }
  }
  /* Narrowest window (both panels open). Color search stays in the filter menu; Alt Right still goes forward. */
  @container (max-width: 480px) {
    .pip,
    .fwd {
      display: none;
    }
    .sp {
      min-width: 0;
    }
  }
</style>
