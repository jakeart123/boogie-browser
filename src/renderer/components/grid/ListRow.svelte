<script lang="ts">
  // One row of the list layout: thumb, name, type, dimensions, size, rating, tags, date added.
  import File from '@lucide/svelte/icons/file';
  import Star from '@lucide/svelte/icons/star';
  import { dateTime, fileSize } from '../../lib/format';
  import { items } from '../../lib/stores/items.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { SETTLE_MS, dropSrc, loadedLately, markLoaded } from './thumbLoad';

  interface Props {
    id: string;
    y: number;
    w: number;
    h: number;
    x: number;
    isNew: boolean;
  }
  let { id, x, y, w, h, isNew }: Props = $props();

  // The cache keeps the old records while an edited item is fetched again, so nothing blinks.
  const b = $derived(items.brief(id));
  const full = $derived(items.full(id));
  const selected = $derived(selection.has(id));
  const primary = $derived(selection.primary === id);
  let broken = $state(false);
  $effect(() => {
    void b?.thumbUrl;
    broken = false;
  });
  // The thumbnail is asked for once the row has stayed in the window a moment (thumbLoad.ts).
  let settled = $state(false);
  $effect(() => {
    const t = setTimeout(() => (settled = true), SETTLE_MS);
    return () => clearTimeout(t);
  });
</script>

<div
  class="row"
  class:sel={selected}
  class:pri={primary}
  role="option"
  aria-selected={selected}
  data-id={id}
  draggable="true"
  style="transform: translate({x}px, {y}px); width: {w}px; height: {h}px"
>
  {#if b}
    <div class="th">
      {#if (!b.noPreview || b.localThumb) && !broken}
        {#if settled || loadedLately(b.thumbUrl)}
          <img
            src={b.thumbUrl}
            alt=""
            decoding="async"
            draggable="false"
            use:dropSrc
            onload={() => markLoaded(b?.thumbUrl)}
            onerror={() => (broken = true)}
          />
        {/if}
      {:else}
        <File size={16} />
      {/if}
      {#if isNew}<span class="new"></span>{/if}
    </div>
    <div class="name" title={b.name}>{b.name}</div>
    <div class="ext">{b.ext}</div>
    <div class="num c-dim">{b.width && b.height ? `${b.width} × ${b.height}` : ''}</div>
    <div class="num">{fileSize(b.size)}</div>
    <div class="rate c-rate" title={b.star ? `${b.star} of 5 stars` : 'Not rated'}>
      {#each [1, 2, 3, 4, 5] as n (n)}
        <Star size={11} strokeWidth={0} fill="currentColor" class={n <= b.star ? 'on' : 'off'} />
      {/each}
    </div>
    <div class="tags c-tags" title={full?.tags.join(', ')}>
      {full
        ? full.tags.join(', ')
        : b.tagCount
          ? `${b.tagCount} ${b.tagCount === 1 ? 'tag' : 'tags'}`
          : ''}
    </div>
    <div class="num">{full ? dateTime(full.importedAt) : ''}</div>
  {/if}
</div>

<style>
  .row {
    position: absolute;
    left: 0;
    top: 0;
    display: grid;
    grid-template-columns: var(--list-cols);
    align-items: center;
    column-gap: 10px;
    padding: 0 12px 0 8px;
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    user-select: none;
  }
  .row:hover {
    background: var(--hov);
  }
  .row.sel {
    background: var(--bls);
  }
  .row.pri {
    box-shadow: inset 2px 0 0 var(--bl);
  }
  .th {
    position: relative;
    width: 36px;
    height: 36px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--thumb-bg);
    display: grid;
    place-items: center;
    color: var(--fa);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .new {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--rm);
    box-shadow: 0 0 0 1.5px color-mix(in srgb, black 50%, transparent);
  }
  .name,
  .tags {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ext {
    color: var(--mu);
    text-transform: uppercase;
    font-size: 11px;
  }
  .num {
    color: var(--mu);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tags {
    color: var(--mu);
  }
  .rate {
    display: flex;
    gap: 1px;
  }
  .rate :global(.on) {
    color: var(--star);
  }
  .rate :global(.off) {
    color: var(--chip-line);
  }
</style>
