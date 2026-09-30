<script lang="ts">
  // Everything that changed in the library, newest first, by day. Anything can be undone from here.
  import { tick, untrack } from 'svelte';
  import HistoryRow from './HistoryRow.svelte';
  import { history } from './history.svelte';
  import { groupByDay } from './logic';

  const days = $derived(groupByDay(history.entries, history.now));

  // "Review" in the status strip: scroll to the newest change the partner's Eagle may have
  // overwritten (those rows are tinted, so the rest are easy to spot below it).
  let listEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (history.revealStale) untrack(() => void reveal());
  });
  async function reveal() {
    await history.loadBack(Date.now() - 7 * 86_400_000);
    await tick();
    listEl?.querySelector('.hev.stale')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    history.revealStale = 0; // done: opening History later starts at the top as usual
  }
</script>

{#if !history.entries.length}
  <div class="note empty">
    {#if history.error}Could not load history: {history.error}
    {:else if history.loading}Loading history&hellip;
    {:else}No changes yet. Edits made by you, an agent or a partner will show up here.{/if}
  </div>
{:else}
  <div bind:this={listEl}>
    {#each days as day, i (i)}
      <div class="hday" class:first={i === 0}>{day.label}</div>
      {#each day.entries as e (e.groupId)}
        <HistoryRow entry={e} today={day.label === 'Today'} />
      {/each}
    {/each}
    {#if history.hasMore}
      <button type="button" class="more" disabled={history.loading} onclick={() => history.more()}
        >{history.loading ? 'Loading…' : 'Load more'}</button
      >
    {/if}
  </div>
{/if}

<style>
  .hday {
    font-size: 11px;
    font-weight: 600;
    color: var(--fa);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 14px 0 4px;
  }
  .hday.first {
    margin-top: 6px;
  }
  .empty {
    padding: 8px 0;
  }
  .more {
    display: block;
    width: 100%;
    height: 30px;
    margin-top: 10px;
    border-radius: 6px;
    background: var(--chip);
    color: var(--tx);
    font-size: 12px;
    cursor: pointer;
  }
  .more:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
