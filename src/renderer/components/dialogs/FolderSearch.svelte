<script lang="ts">
  // A search box over the folder tree with the best matches under it, for picking folders inside a
  // dialog. Libraries can have thousands of folders, so it lists at most 50 (the same ranking as
  // the folder picker). Up/Down and Enter work from the box.
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import { searchFolders } from '../../lib/folders';

  let {
    onpick,
    checked,
    none,
    placeholder = 'Search folders',
  }: {
    /** A folder id, or null for the `none` row. */
    onpick: (id: string | null) => void;
    /** Shows a checkbox per row (several can be picked). */
    checked?: (id: string) => boolean;
    /** Label of an extra first row that picks "no folder". */
    none?: string;
    placeholder?: string;
  } = $props();

  let query = $state('');
  let hi = $state(0);
  let list = $state<HTMLUListElement | null>(null);
  let box = $state<HTMLInputElement | null>(null);
  // It opens because you asked to pick a folder: typing goes straight into the search.
  onMount(() => box?.focus());

  const hits = $derived(searchFolders(query, 50));
  const rows = $derived<{ id: string | null; path: string; segs: (typeof hits)[number]['segs'] }[]>(
    [
      ...(none && !query.trim()
        ? [{ id: null, path: none, segs: [{ text: none, hit: false }] }]
        : []),
      ...hits,
    ],
  );

  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') hi = Math.min(hi + 1, rows.length - 1);
    else if (e.key === 'ArrowUp') hi = Math.max(hi - 1, 0);
    else if (e.key === 'Enter') {
      if (rows[hi]) onpick(rows[hi].id);
    } else return;
    e.preventDefault();
    queueMicrotask(() => list?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' }));
  }
</script>

<div class="fs">
  <input
    class="dg-input"
    bind:this={box}
    {placeholder}
    aria-label={placeholder}
    autocomplete="off"
    spellcheck="false"
    bind:value={query}
    oninput={() => (hi = 0)}
    onkeydown={key}
  />
  <ul bind:this={list} role="listbox" aria-label="Folders">
    {#each rows as r, i (r.id ?? '')}
      <li class:hi={i === hi} role="option" aria-selected={i === hi}>
        <button
          type="button"
          title={r.path}
          aria-pressed={checked && r.id ? checked(r.id) : undefined}
          onmousemove={() => (hi = i)}
          onclick={() => onpick(r.id)}
        >
          <!-- A drawn box, not an <input>: a control can't sit inside a button. -->
          {#if checked && r.id}<span class="box" class:on={checked(r.id)} aria-hidden="true"
              >{#if checked(r.id)}<Check size={11} strokeWidth={3} />{/if}</span
            >{/if}
          <span class="p"
            >{#each r.segs as s, j (j)}{#if s.hit}<mark>{s.text}</mark
                >{:else}{s.text}{/if}{/each}</span
          >
        </button>
      </li>
    {:else}
      <li class="none">No folders match.</li>
    {/each}
  </ul>
</div>

<style>
  .fs {
    padding: 6px;
    border-radius: 8px;
    background: var(--hov);
    border: 1px solid var(--panel-line);
  }
  ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    max-height: 190px;
    overflow-y: auto;
  }
  li button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 26px;
    padding: 0 8px;
    border-radius: 5px;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  li.hi button {
    background: var(--bls);
  }
  .box {
    width: 14px;
    height: 14px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 3px;
    border: 1px solid var(--fa);
    color: var(--bg);
  }
  .box.on {
    background: var(--bl);
    border-color: var(--bl);
  }
  .p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: none;
    color: var(--link);
    font-weight: 600;
  }
  .none {
    padding: 8px;
    color: var(--fa);
    font-size: 12px;
  }
</style>
