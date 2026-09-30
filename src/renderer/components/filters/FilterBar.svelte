<script lang="ts">
  // The strip under the toolbar: one chip per active filter, a "+ Filter" menu, "165 of 566", a
  // lock and "Clear all". Draws nothing while no filter is active and no popover is open. Also
  // hosts the filter popovers and registers the filter shortcuts.
  import { onMount, untrack } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import Plus from '@lucide/svelte/icons/plus';
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import Lock from '@lucide/svelte/icons/lock';
  import LockOpen from '@lucide/svelte/icons/lock-open';
  import { registerCommands, type CommandContext } from '../../lib/commands.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { FilterSpec } from '../../../shared/types';
  import { iconFor } from '../pickers/icons';
  import { describeFilter, type PopoverKind } from './chips';
  import { filterUi } from './filterUi.svelte';
  import { openFilterMenu } from './filterMenu';
  import ColorPopover from './ColorPopover.svelte';
  import DatePopover from './DatePopover.svelte';
  import RangePopover from './RangePopover.svelte';
  import RatingPopover from './RatingPopover.svelte';
  import SavedFiltersPopover from './SavedFiltersPopover.svelte';
  import { applySaved, saveCurrentFilter, savedFilters } from './savedFilters.svelte';
  import ShapePopover from './ShapePopover.svelte';
  import TagsPopover from './TagsPopover.svelte';
  import TypePopover from './TypePopover.svelte';
  import UrlNotePopover from './UrlNotePopover.svelte';

  const chips = $derived(
    describeFilter(view.filter, {
      folderName: (id) => library.folder(id)?.node.name ?? 'Missing folder',
    }),
  );
  const visible = $derived(view.filtered || !!filterUi.open);

  // The scope's size without any filter, from the counts the library already keeps.
  const scopeTotal = $derived.by<number | null>(() => {
    const c = library.counts;
    const s = view.scope;
    if (!c) return null;
    switch (s.kind) {
      case 'all':
      case 'random':
        return c.all;
      case 'uncategorized':
        return c.uncategorized;
      case 'untagged':
        return c.untagged;
      case 'trash':
        return c.trash;
      case 'folder': {
        const n = c.folders[s.id];
        return n ? (s.includeSubfolders ? n.deep : n.own) : 0;
      }
      case 'smartFolder':
        return c.smartFolders[s.id] ?? null;
      case 'tag':
        return library.tags.find((t) => t.name === s.name)?.count ?? null;
      case 'ids':
        return s.ids.length;
    }
  });

  function editChip(chip: (typeof chips)[number], el: Element) {
    if (chip.edit === 'keywords') ui.openOverlay('command', { text: view.filter.keywords ?? '' });
    else filterUi.openPopover(chip.edit, el, chip.field);
  }

  function removeChip(key: keyof FilterSpec) {
    view.setFilter({ [key]: undefined } as Partial<FilterSpec>);
  }

  function clearAll() {
    filterUi.close();
    view.clearFilter();
  }

  // "Keep filter when changing folders": a scope change wipes the filter (view.setScope), so put the
  // saved one back. Works for scope changes we don't make ourselves (sidebar clicks).
  // A different library starts over, lock and all (its folders and tags are not this one's).
  let saved: FilterSpec | null = null;
  let lastScope = JSON.stringify(view.scope);
  let lastLibrary = library.state?.ref.id;
  $effect(() => {
    const scope = JSON.stringify(view.scope);
    const locked = filterUi.lock;
    const filtered = view.filtered;
    const snapshot = filtered ? ($state.snapshot(view.filter) as FilterSpec) : null;
    const libraryId = library.state?.ref.id;
    untrack(() => {
      const scopeChanged = scope !== lastScope;
      lastScope = scope;
      if (libraryId !== lastLibrary) {
        lastLibrary = libraryId;
        saved = null;
        filterUi.lock = false;
        return;
      }
      if (!locked) return void (saved = null);
      if (filtered) return void (saved = snapshot);
      if (!saved) return; // locked before any filter exists: stays on and picks up the next one
      if (scopeChanged) view.setFilter(saved);
      else ((saved = null), (filterUi.lock = false)); // cleared here, so the lock has nothing left to keep
    });
  });

  // Each saved filter is a palette entry ("Filter: Hands, 4 stars"), kept in step with the file.
  $effect(() => {
    const list = savedFilters();
    // The registry is state too: register without making this effect depend on it.
    return untrack(() =>
      registerCommands(
        list.map((f) => ({
          id: `savedFilter.${f.index}`,
          title: `Filter: ${f.name}`,
          group: 'Saved filters',
          icon: 'bookmark',
          run: () => applySaved(f),
        })),
      ),
    );
  });

  // The palette, the pickers and the dialogs sit under the popovers, so a popover gives way when
  // one opens (a saved filter's Rename… opens a dialog, say).
  $effect(() => {
    if (ui.overlay || ui.dialog) filterUi.close();
  });

  onMount(() => {
    const open = (kind: PopoverKind, title: string, key: string) => ({
      id: `filter.${kind}`,
      title,
      group: 'Filter',
      icon: 'funnel',
      keys: [key],
      mainWindow: true,
      when: (c: CommandContext) => c.region !== 'overlay' && !ui.dialog && !!library.state,
      run: () => filterUi.openPopover(kind),
    });
    const off = registerCommands([
      {
        id: 'filter.menu',
        mainWindow: true,
        title: 'Add a filter…',
        group: 'Filter',
        icon: 'funnel',
        keys: ['Ctrl+Shift+F'],
        when: (c) => c.region !== 'overlay' && !ui.dialog && !!library.state,
        run: openFilterMenu,
      },
      open('tags', 'Filter by tags', 'Alt+T'),
      open('color', 'Filter by color', 'Alt+C'),
      open('shape', 'Filter by shape', 'Alt+S'),
      open('rating', 'Filter by rating', 'Alt+R'),
      open('type', 'Filter by file type', 'Alt+E'),
      open('date', 'Filter by date imported', 'Alt+D'),
      {
        id: 'filter.clear',
        mainWindow: true,
        title: 'Clear all filters',
        group: 'Filter',
        icon: 'x',
        when: () => view.filtered,
        run: clearAll,
      },
      {
        id: 'filter.saved',
        mainWindow: true,
        title: 'Saved filters…',
        group: 'Saved filters',
        icon: 'bookmark',
        keys: ['Alt+F'],
        when: (c) => c.region !== 'overlay' && !ui.dialog && !!library.state,
        run: () => filterUi.openPopover('saved', filterUi.toolbarAnchor),
      },
      {
        id: 'filter.save',
        mainWindow: true,
        title: 'Save this filter…',
        group: 'Saved filters',
        icon: 'bookmark',
        when: () => view.filtered && !library.readOnly,
        run: saveCurrentFilter,
      },
      {
        id: 'filter.closePopover',
        anyMode: true,
        title: 'Close filter popover',
        hidden: true,
        allowInInput: true,
        priority: 30,
        keys: ['Escape'],
        when: () => !!filterUi.open,
        run: () => filterUi.close(),
      },
    ]);
    return () => {
      off();
      filterUi.close();
    };
  });
</script>

{#if visible}
  <div class="filt" role="toolbar" aria-label="Filters">
    <div class="chips">
      {#each chips as chip (chip.key)}
        {@const Icon = iconFor(chip.icon)}
        <span class="chip" class:editing={filterUi.open && filterUi.open.kind === chip.edit}>
          <button
            class="lbl"
            title="Edit filter: {chip.title}"
            onclick={(e) => editChip(chip, e.currentTarget)}
          >
            {#if chip.swatch}<span class="sw" style="background:{chip.swatch}"></span>{:else}<Icon
                size={12}
              />{/if}
            <span class="txt">
              {#each chip.segs as seg, i (i)}<span class:struck={seg.struck}>{seg.text}</span
                >{' '}{/each}
            </span>
          </button>
          <button
            class="x"
            aria-label="Remove filter: {chip.title}"
            onclick={() => removeChip(chip.key)}><X size={11} /></button
          >
        </span>
      {/each}
    </div>
    <button class="add" bind:this={filterUi.barAnchor} onclick={openFilterMenu}
      ><Plus size={13} />Filter</button
    >
    {#if view.result}
      <span class="res">
        {#if scopeTotal !== null}<b>{view.result.total.toLocaleString()}</b> of {scopeTotal.toLocaleString()}{:else}<b
            >{view.result.total.toLocaleString()}</b
          > results{/if}
      </span>
    {/if}
    <span class="grow"></span>
    <button
      class="lock"
      class:on={filterUi.lock}
      aria-pressed={filterUi.lock}
      title={filterUi.lock
        ? 'The filter stays when you change folders'
        : 'Keep filter when changing folders'}
      onclick={() => (filterUi.lock = !filterUi.lock)}
    >
      {#if filterUi.lock}<Lock size={13} />{:else}<LockOpen size={13} />{/if}
      <span class="lbl2">Keep when changing folders</span>
    </button>
    {#if view.filtered}
      <button
        class="savef"
        disabled={library.readOnly}
        title={library.readOnly
          ? readOnlyTip()
          : 'Keep this filter to use again (Alt+F lists them)'}
        onclick={saveCurrentFilter}><BookmarkPlus size={13} />Save filter…</button
      >
      <button class="clear" onclick={clearAll}>Clear all</button>
    {/if}
  </div>
{/if}

{#if filterUi.open}
  {#key `${filterUi.open.kind}:${filterUi.open.field ?? ''}`}
    {@const k = filterUi.open.kind}
    {#if k === 'tags' || k === 'folders'}<TagsPopover kind={k} />
    {:else if k === 'color'}<ColorPopover />
    {:else if k === 'shape'}<ShapePopover />
    {:else if k === 'rating'}<RatingPopover />
    {:else if k === 'type'}<TypePopover />
    {:else if k === 'date'}<DatePopover />
    {:else if k === 'size' || k === 'dimensions' || k === 'duration'}<RangePopover kind={k} />
    {:else if k === 'urlnote'}<UrlNotePopover />
    {:else if k === 'saved'}<SavedFiltersPopover />
    {/if}
  {/key}
{/if}

<style>
  .filt {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    min-height: var(--filterbar-h);
    flex: none;
    padding: 6px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--mu);
    min-width: 0;
    container-type: inline-size;
  }

  /* Chips wrap onto more lines instead of hiding behind a scroll. */
  .chips {
    display: contents;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    flex: none;
    height: 26px;
    border-radius: 13px;
    background: var(--hov);
    border: 1px solid var(--chip-line);
    color: var(--tx);
    white-space: nowrap;
    max-width: 420px;
  }
  .chip.editing {
    border-color: var(--bl);
  }
  .lbl {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 100%;
    padding: 0 4px 0 10px;
    border-radius: 13px 0 0 13px;
    min-width: 0;
  }
  .lbl :global(svg) {
    color: var(--fa);
    flex: none;
  }
  .txt {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .struck {
    text-decoration: line-through;
    color: var(--mu);
  }
  .sw {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex: none;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
  }
  .x {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-right: 3px;
    border-radius: 50%;
    color: var(--fa);
    flex: none;
  }
  .x:hover {
    background: var(--chip);
    color: var(--tx);
  }
  .add,
  .clear,
  .savef,
  .lock {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    border-radius: 7px;
    color: var(--mu);
    flex: none;
  }
  .add {
    border: 1px dashed var(--chip-line);
  }
  .add:hover,
  .clear:hover,
  .savef:hover:not(:disabled),
  .lock:hover {
    background: var(--hov);
    color: var(--tx);
  }
  .lock.on {
    color: var(--link);
    background: var(--bls);
  }
  .res {
    margin-left: 6px;
    color: var(--fa);
    flex: none;
    white-space: nowrap;
  }
  .res b {
    color: var(--tx);
    font-weight: 500;
  }
  .grow {
    flex: 1;
  }
  button:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
  @container (max-width: 860px) {
    .lbl2 {
      display: none;
    }
  }
</style>
