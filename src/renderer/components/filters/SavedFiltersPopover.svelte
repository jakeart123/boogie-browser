<script lang="ts">
  // The toolbar funnel (and Alt+F): saved filters on top (click applies, right-click renames or
  // deletes, drag reorders), "Save this filter" when one is set, then every filter you can add.
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import GripVertical from '@lucide/svelte/icons/grip-vertical';
  import { openContextMenu } from '../../lib/contextMenu.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { SavedFilterInfo } from '../../../shared/types';
  import { MENU } from './filterMenu';
  import { filterUi } from './filterUi.svelte';
  import Popover from './Popover.svelte';
  import {
    applySaved,
    deleteSaved,
    moveSaved,
    renameSaved,
    saveCurrentFilter,
    savedFilters,
    updateSaved,
  } from './savedFilters.svelte';

  const list = $derived(savedFilters());
  const lock = $derived(readOnlyTip());
  let dragFrom = $state<number | null>(null);
  let dropAt = $state<number | null>(null);

  // Keyboard: the first saved filter has focus on open, Up and Down walk the buttons, Enter
  // applies, F2 renames and Delete deletes the one with focus (Tab stays in the popover).
  function onkey(e: KeyboardEvent, f?: SavedFilterInfo) {
    if (f && e.key === 'F2' && !lock) return void (e.preventDefault(), renameSaved(f));
    if (f && e.key === 'Delete' && !lock) return void (e.preventDefault(), deleteSaved(f));
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).closest('.pop');
    const all = [
      ...(box?.querySelectorAll<HTMLButtonElement>('.body button:not(:disabled)') ?? []),
    ];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
  }

  function apply(f: SavedFilterInfo) {
    filterUi.close();
    applySaved(f);
  }

  function menu(e: MouseEvent, f: SavedFilterInfo) {
    openContextMenu(e, [
      { label: 'Apply', run: () => apply(f) },
      {
        label: 'Replace with the current filter',
        disabled: !!lock || !view.filtered,
        title: lock,
        run: () => updateSaved(f),
      },
      { separator: true },
      { label: 'Rename…', disabled: !!lock, title: lock, run: () => renameSaved(f) },
      { label: 'Delete…', danger: true, disabled: !!lock, title: lock, run: () => deleteSaved(f) },
    ]);
  }

  function dragStart(e: DragEvent, i: number) {
    if (lock || !e.dataTransfer) return e.preventDefault();
    dragFrom = i;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  }
  function dragOver(e: DragEvent, i: number) {
    if (dragFrom === null) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = e.clientY < r.top + r.height / 2 ? i : i + 1;
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    const from = dragFrom;
    const at = dropAt;
    dragFrom = dropAt = null;
    if (from === null || at === null) return;
    // `at` is a gap in the old list; the core wants the final position.
    const to = at > from ? at - 1 : at;
    if (to !== from) void moveSaved(list[from], list[to].index);
  }
</script>

<Popover title="Filters" kind="saved">
  <h4>Saved filters</h4>
  {#if list.length}
    <ul class="saved" role="list" ondragleave={() => (dropAt = null)}>
      {#each list as f, i (f.index + ':' + f.name)}
        <li
          class:gap-before={dropAt === i}
          class:gap-after={dropAt === i + 1 && i === list.length - 1}
          ondragover={(e) => dragOver(e, i)}
          ondrop={drop}
        >
          <button
            class="row"
            data-autofocus={i === 0 ? true : undefined}
            onkeydown={(e) => onkey(e, f)}
            draggable={!lock}
            title={f.unsupported.length
              ? `Also uses ${f.unsupported.join(', ')} (Eagle only)`
              : f.name}
            onclick={() => apply(f)}
            oncontextmenu={(e) => menu(e, f)}
            ondragstart={(e) => dragStart(e, i)}
            ondragend={() => (dragFrom = dropAt = null)}
          >
            <GripVertical size={12} class="grip" />
            <span class="nm">{f.name}</span>
          </button>
          {#if f.unsupported.length}
            <span class="eagle">Eagle only: {f.unsupported.join(', ')}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="hint">Nothing saved yet. Set up a filter, then save it here.</p>
  {/if}
  <button
    class="save"
    onkeydown={(e) => onkey(e)}
    disabled={!view.filtered || !!lock || !library.state}
    title={lock ?? (view.filtered ? 'Save the filter you have now' : 'Set up a filter first')}
    onclick={() => (filterUi.close(), saveCurrentFilter())}
    ><BookmarkPlus size={13} />Save this filter…</button
  >

  <h4>Add a filter</h4>
  <div class="kinds">
    {#each MENU as m, i (m.label)}
      <button
        class="kind"
        data-autofocus={!list.length && i === 0 ? true : undefined}
        onkeydown={(e) => onkey(e)}
        title={m.keys ? `${m.label} (${m.keys})` : m.label}
        onclick={() => filterUi.openPopover(m.kind, filterUi.menuAnchor(), m.field)}
        >{m.label}</button
      >
    {/each}
  </div>
</Popover>

<style>
  h4 {
    margin: 2px 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
  }
  h4:not(:first-child) {
    margin-top: 14px;
  }
  .saved {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
  }
  li {
    border-top: 2px solid transparent;
    border-bottom: 2px solid transparent;
  }
  li.gap-before {
    border-top-color: var(--bl);
  }
  li.gap-after {
    border-bottom-color: var(--bl);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 28px;
    padding: 0 8px 0 2px;
    border-radius: 6px;
    font-size: 12.5px;
    text-align: left;
    color: var(--tx);
  }
  .row:hover {
    background: var(--hov);
  }
  .row :global(.grip) {
    color: var(--fa);
    flex: none;
    cursor: grab;
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .eagle {
    display: block;
    padding: 0 8px 4px 20px;
    font-size: 11px;
    color: var(--warn);
  }
  .hint {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--fa);
  }
  .save {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px dashed var(--chip-line);
    font-size: 12px;
    color: var(--mu);
  }
  .save:hover:not(:disabled) {
    background: var(--hov);
    color: var(--tx);
  }
  .save:disabled {
    opacity: 0.55;
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .kind {
    height: 24px;
    padding: 0 9px;
    border-radius: 12px;
    background: var(--hov);
    border: 1px solid var(--chip-line);
    font-size: 11.5px;
    color: var(--tx);
  }
  .kind:hover {
    border-color: var(--bl);
  }
</style>
