<script lang="ts">
  // Column headers for the list layout. Clicking one sorts by it; clicking again flips the order.
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import { view } from '../../lib/stores/view.svelte';
  import type { OrderBy } from '../../../shared/types';

  // `hide` marks the columns Grid.svelte drops first when the window is narrow.
  const cols: { label: string; by: OrderBy | null; first: boolean; hide?: string }[] = [
    { label: '', by: null, first: true },
    { label: 'Name', by: 'NAME', first: true },
    { label: 'Type', by: 'EXT', first: true },
    { label: 'Dimensions', by: 'RESOLUTION', first: false, hide: 'c-dim' },
    { label: 'Size', by: 'FILESIZE', first: false },
    { label: 'Rating', by: 'RATING', first: false, hide: 'c-rate' },
    { label: 'Tags', by: 'TAGS', first: false, hide: 'c-tags' },
    { label: 'Date added', by: 'IMPORT', first: false },
  ];

  const current = $derived(view.sort ?? view.result?.sort ?? null);

  function sortBy(by: OrderBy, firstAscending: boolean) {
    if (current?.by === by) view.setSort({ by, ascending: !current.ascending });
    else view.setSort({ by, ascending: firstAscending });
  }
</script>

<div class="head">
  {#each cols as c, i (i)}
    {#if c.by}
      {@const by = c.by}
      <button
        class="col {c.hide ?? ''}"
        class:on={current?.by === by}
        title="Sort by {c.label.toLowerCase()}"
        onclick={() => sortBy(by, c.first)}
      >
        {c.label}
        {#if current?.by === by}
          {#if current.ascending}<ArrowUp size={12} />{:else}<ArrowDown size={12} />{/if}
        {/if}
      </button>
    {:else}
      <span></span>
    {/if}
  {/each}
</div>

<style>
  .head {
    position: sticky;
    top: 0;
    z-index: 2;
    height: 30px;
    display: grid;
    grid-template-columns: var(--list-cols);
    align-items: center;
    column-gap: 10px;
    padding: 0 12px 0 8px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--fa);
  }
  .col {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 6px;
    margin-left: -6px;
    border-radius: 5px;
    text-align: left;
    color: inherit;
  }
  .col:hover {
    background: var(--hov);
    color: var(--tx);
  }
  .col.on {
    color: var(--tx);
  }
</style>
