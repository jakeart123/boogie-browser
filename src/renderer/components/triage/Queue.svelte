<script lang="ts">
  // The queue down the left: a few sorted items above the one on screen (dimmed, with what
  // happened to them) and the next ones below it with a clue from their notes. Only a window
  // around the current item is drawn, so a 7,000-item queue costs the same as a small one.
  import { items } from '../../lib/stores/items.svelte';
  import type { TriageSession } from '../../lib/stores/triage.svelte';
  import { clueLine } from './clues';
  import { outcomeText } from './queue';

  let { session: s }: { session: TriageSession } = $props();

  const BEFORE = 3;
  const AFTER = 14;
  const rows = $derived.by(() => {
    const from = Math.max(0, s.index - BEFORE);
    return s.ids.slice(from, s.index + AFTER + 1).map((id, k) => ({ id, i: from + k }));
  });

  // Tiles need briefs; the clue line needs the note (full records, batched in one request).
  $effect(() => {
    const ids = rows.map((r) => r.id);
    items.ensure(ids);
    void items.loadFulls(ids).catch(() => {});
  });
</script>

<aside class="queue" aria-label="Queue">
  <div class="qh">
    <span>Queue</span><span class="n"
      >{(s.index + 1).toLocaleString()} of {s.ids.length.toLocaleString()}</span
    >
  </div>
  <div class="ql">
    {#each rows as r (r.id)}
      {@const b = items.brief(r.id)}
      {@const o = s.outcomes[r.id]}
      {@const res = o ? outcomeText(o) : null}
      <button
        type="button"
        class="qr"
        class:done={!!o}
        class:now={r.i === s.index}
        title={b?.name}
        onclick={() => (s.index = r.i)}
      >
        <span class="th"
          >{#if b}<img src={b.thumbUrl} alt="" loading="lazy" draggable="false" />{/if}</span
        >
        <span class="tx">
          <span class="nm">{b?.name ?? ''}</span>
          <span class="sub">
            {#if res}
              {#if res.key}<span class="kc">{res.key}</span>{/if}{res.text}
            {:else}
              {clueLine(items.full(r.id)?.annotation ?? '') || 'no notes'}
            {/if}
          </span>
        </span>
      </button>
    {/each}
  </div>
</aside>

<style>
  .queue {
    grid-area: queue;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--side);
    border-right: 1px solid var(--line);
  }
  .qh {
    display: flex;
    justify-content: space-between;
    padding: 12px 14px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mu);
  }
  .qh .n {
    font-family: var(--mono);
    letter-spacing: 0;
    text-transform: none;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .ql {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    mask-image: linear-gradient(#000 85%, transparent);
  }
  .qr {
    display: grid;
    grid-template-columns: 60px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 6px 14px;
    border-left: 2px solid transparent;
    text-align: left;
  }
  .qr:hover {
    background: var(--hov);
  }
  .qr.done {
    opacity: 0.5;
  }
  .qr.now {
    opacity: 1;
    background: var(--hov);
    border-left-color: var(--bl);
  }
  .th {
    width: 60px;
    height: 44px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--thumb-bg);
  }
  .th img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tx {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .nm,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
  }
  .nm {
    font-family: var(--mono);
    color: var(--tx);
  }
  .sub {
    color: var(--mu);
  }
  .done .sub {
    color: var(--tx);
  }
  .kc {
    display: inline-block;
    margin-right: 5px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--tx);
    color: var(--bg);
    font-family: var(--mono);
    font-size: 9.5px;
    font-weight: 600;
  }
  .qr:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
</style>
