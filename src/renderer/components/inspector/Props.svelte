<script lang="ts">
  // The property list: rating (clickable stars), size, dates. With several items selected, just the rating.
  import Star from '@lucide/svelte/icons/star';
  import type { Item } from '../../../shared/types';
  import { fileKind } from '../../lib/fileKinds';
  import { dateTime, duration, fileSize, plural } from '../../lib/format';
  import { history } from './history.svelte';
  import { editSelected } from './edit';
  import { commonValue, dateOnly, lastActor } from './logic';

  let { items, ids, readonly }: { items: Item[]; ids: string[]; readonly: boolean } = $props();

  const one = $derived(items.length === 1 && ids.length === 1 ? items[0] : null);
  const common = $derived(commonValue(items.map((i) => String(i.star))));
  const rating = $derived(common.mixed ? 0 : Number(common.value));
  let hover = $state<number | null>(null);

  function rate(star: number) {
    const next = star === rating ? 0 : star;
    return editSelected(
      ids,
      { star: next },
      {
        what: `${next ? `set the rating to ${plural(next, 'star')} on` : 'clear the rating on'} ${plural(ids.length, 'item')}`,
      },
    );
  }

  const by = $derived(one ? lastActor(history.entries, one.id) : null);
  const hasDuration = $derived(
    !!one &&
      one.duration != null &&
      (one.duration > 0 || ['video', 'audio'].includes(fileKind(one.ext))),
  );
</script>

<dl class="props">
  <div>
    <dt>Rating</dt>
    <dd class="stars" role="group" aria-label="Rating" onmouseleave={() => (hover = null)}>
      {#if common.mixed}<span class="mixed">Mixed</span>{/if}
      {#each [1, 2, 3, 4, 5] as s (s)}
        {@const on = s <= (hover ?? rating)}
        <button
          type="button"
          class="star"
          class:on
          disabled={readonly}
          aria-label="{s} star{s === 1 ? '' : 's'}"
          aria-pressed={s <= rating}
          title={readonly
            ? undefined
            : s === rating
              ? 'Click again to clear'
              : `${s} star${s === 1 ? '' : 's'}`}
          onmouseenter={() => (hover = s)}
          onclick={() => rate(s)}
        >
          <Star size={14} fill={on ? 'currentColor' : 'none'} />
        </button>
      {/each}
    </dd>
  </div>
  {#if one}
    {#if one.width && one.height}<div>
        <dt>Dimensions</dt>
        <dd>{one.width} &times; {one.height}</dd>
      </div>{/if}
    <div>
      <dt>Size</dt>
      <dd>{fileSize(one.size)} &middot; {one.ext.toUpperCase()}</dd>
    </div>
    {#if hasDuration}<div>
        <dt>Duration</dt>
        <dd>{duration(one.duration ?? 0)}</dd>
      </div>{/if}
    <div>
      <dt>Date imported</dt>
      <dd>{one.importedAt ? dateTime(one.importedAt) : 'Unknown'}</dd>
    </div>
    <div>
      <dt>Last changed</dt>
      <dd>
        {one.modifiedAt ? dateOnly(one.modifiedAt) : 'Unknown'}{#if by && one.modifiedAt}{' by ' +
            by.name}{/if}
      </dd>
    </div>
    {#if one.isDeleted && one.deletedTime}<div>
        <dt>Moved to trash</dt>
        <dd>{dateTime(one.deletedTime)}</dd>
      </div>{/if}
  {/if}
</dl>

<style>
  .props {
    border-top: 1px solid var(--line);
    margin: 16px 0 0;
    padding-top: 4px;
  }
  .props div {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    min-height: 27px;
    font-size: 12px;
  }
  dt {
    color: var(--fa);
    flex: none;
  }
  dd {
    margin: 0;
    color: var(--tx);
    font-variant-numeric: tabular-nums;
    text-align: right;
    min-width: 0;
  }
  .stars {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }
  .mixed {
    color: var(--fa);
    font-size: 11px;
    margin-right: 6px;
  }
  .star {
    display: grid;
    place-items: center;
    width: 18px;
    height: 20px;
    color: var(--fa);
    cursor: pointer;
  }
  .star.on {
    color: var(--star);
  }
  .star:disabled {
    cursor: default;
  }
</style>
