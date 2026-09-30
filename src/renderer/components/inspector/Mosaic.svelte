<script lang="ts">
  // Header for a multi-selection: "N items" over a 2x2 of the first thumbnails. Drag it to drag them all.
  import type { Item } from '../../../shared/types';
  import { beginItemDrag } from '../../lib/dnd';

  let { items, ids }: { items: Item[]; ids: string[] } = $props();
  const first = $derived(items.slice(0, 4));
</script>

<div
  class="mosaic"
  role="img"
  aria-label="{ids.length} items selected"
  draggable="true"
  ondragstart={(e) => beginItemDrag(e, ids)}
>
  <div class="grid" class:one={first.length === 1}>
    {#each first as it (it.id)}
      <img src={it.thumbUrl} alt="" draggable="false" />
    {/each}
  </div>
  <div class="count">{ids.length.toLocaleString()} items</div>
</div>

<style>
  .mosaic {
    margin-bottom: 4px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    height: 180px;
    padding: 8px;
    border-radius: 7px;
    background: var(--fld);
  }
  .grid.one {
    grid-template-columns: 1fr;
  }
  img {
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: cover;
    border-radius: 4px;
    background: var(--thumb-bg);
  }
  .count {
    margin-top: 10px;
    font-size: 14px;
    font-weight: 600;
  }
</style>
