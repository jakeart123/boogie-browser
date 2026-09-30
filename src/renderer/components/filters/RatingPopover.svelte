<script lang="ts">
  import Star from '@lucide/svelte/icons/star';
  import { view } from '../../lib/stores/view.svelte';
  import Popover from './Popover.svelte';

  const cur = $derived(view.filter.rating ?? []);

  function toggle(n: number) {
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b);
    view.setFilter({ rating: next.length ? next : undefined });
  }
</script>

<Popover
  kind="rating"
  title="Filter by rating"
  onclear={cur.length ? () => view.setFilter({ rating: undefined }) : undefined}
>
  <div class="col" role="group" aria-label="Ratings">
    {#each [5, 4, 3, 2, 1, 0] as n (n)}
      <button
        class="tog"
        data-autofocus={n === 5 ? '' : undefined}
        aria-pressed={cur.includes(n)}
        onclick={() => toggle(n)}
      >
        {#if n === 0}
          Unrated
        {:else}
          <span class="stars" aria-label="{n} {n === 1 ? 'star' : 'stars'}">
            {#each { length: 5 } as _, i (i)}<Star size={13} class={i < n ? 'on' : 'off'} />{/each}
          </span>
        {/if}
      </button>
    {/each}
  </div>
  <p class="hint">Pick more than one to match any of them.</p>
</Popover>

<style>
  .col {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .tog {
    height: 30px;
    justify-content: flex-start;
  }
  .stars {
    display: inline-flex;
    gap: 2px;
  }
  .stars :global(.on) {
    color: var(--star);
    fill: var(--star);
  }
  .stars :global(.off) {
    color: var(--fa);
  }
</style>
