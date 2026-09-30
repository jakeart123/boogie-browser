<script lang="ts">
  // The item's color palette as one bar. Click a swatch to search the library by that color.
  import Pipette from '@lucide/svelte/icons/pipette';
  import type { Item } from '../../../shared/types';
  import { view } from '../../lib/stores/view.svelte';
  import { openContextMenu } from '../../lib/contextMenu.svelte';
  import { colorFilter, hex, sameRgb, swatchGrow } from './logic';
  import { copyText } from '../../lib/files';

  let { palettes }: { palettes: Item['palettes'] } = $props();

  const swatches = $derived(palettes.slice(0, 10));
  const active = $derived(view.filter.color?.rgb);
  const onThisItem = $derived(swatches.some((p) => sameRgb(p.color, active)));

  function toggle(p: Item['palettes'][number]) {
    view.setFilter({ color: sameRgb(active, p.color) ? undefined : colorFilter(p.color, p.ratio) });
  }

  function menu(e: MouseEvent, p: Item['palettes'][number]) {
    openContextMenu(e, [
      { label: `Copy ${hex(p.color)}`, run: () => copyText(hex(p.color)) },
      {
        label: sameRgb(active, p.color) ? 'Stop searching by this color' : 'Search by this color',
        run: () => toggle(p),
      },
    ]);
  }
</script>

{#if swatches.length}
  <div class="pal" role="group" aria-label="Colors">
    {#each swatches as p, i (i)}
      <button
        type="button"
        class="sw"
        class:on={sameRgb(active, p.color)}
        style:flex="{swatchGrow(p.ratio)} 1 0"
        style:background="rgb({p.color.join(',')})"
        aria-label="{hex(p.color)}, {Math.round(p.ratio)} percent. Search by this color"
        title="{hex(p.color)} · {Math.round(p.ratio)}%"
        onclick={() => toggle(p)}
        oncontextmenu={(e) => menu(e, p)}
      ></button>
    {/each}
  </div>
  {#if view.filter.color}
    <div class="hint">
      <Pipette size={12} />
      <span>{onThisItem ? 'Searching by this color' : 'Searching by a color'}</span>
      <button type="button" class="clear" onclick={() => view.setFilter({ color: undefined })}
        >Clear</button
      >
    </div>
  {/if}
{/if}

<style>
  .pal {
    display: flex;
    gap: 5px;
    margin: 12px 0 14px;
  }
  .sw {
    min-width: 10px;
    height: 20px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    cursor: pointer;
  }
  .sw.on {
    box-shadow:
      0 0 0 2px var(--side),
      0 0 0 3.5px var(--tx);
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -6px 0 12px;
    font-size: 11px;
    color: var(--fa);
  }
  .clear {
    margin-left: auto;
    color: var(--link);
    font-size: 11px;
    cursor: pointer;
  }
</style>
