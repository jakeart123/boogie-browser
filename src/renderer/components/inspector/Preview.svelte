<script lang="ts">
  // The big preview of one item. Shows the thumbnail at once and swaps in the larger rendition once
  // it has loaded, but only after you've stayed on the item a moment: for most pictures that is
  // the full-size original (often many megabytes), and paging through items with the arrow keys
  // must not download every one you pass. Leaving the item cancels the download, and a thumbnail
  // that is already sharp in the box needs no upgrade. An edit (a new version of the same item)
  // keeps the picture that's up: no flicker, no second download. Click opens the detail viewer;
  // dragging it out works like dragging a tile.
  import { untrack } from 'svelte';
  import Play from '@lucide/svelte/icons/play';
  import FileIcon from '@lucide/svelte/icons/file';
  import type { Item } from '../../../shared/types';
  import { beginItemDrag } from '../../lib/dnd';
  import { fileKind } from '../../lib/fileKinds';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';

  let { item }: { item: Item } = $props();

  /** How long to stay on an item before its large preview is fetched. */
  const DWELL_MS = 250;

  const isVideo = $derived(fileKind(item.ext) === 'video');
  const isAudio = $derived(fileKind(item.ext) === 'audio');
  // Videos and audio have no image rendition; everything else may have a bigger preview.
  const upgrade = $derived(!isVideo && !isAudio && !item.noPreview ? item.previewUrl : null);

  let src = $state('');
  let failed = $state(false);
  let boxW = $state(0);
  let boxH = $state(0);
  /** What is on screen (not reactive: only the effect below reads and writes it). */
  let shown = { id: '', big: false };

  /** The thumbnail is sharp enough when drawing it in the box doesn't enlarge it. */
  const covers = (img: HTMLImageElement) => {
    const w = untrack(() => boxW) - 20;
    const h = untrack(() => boxH) - 20;
    if (w <= 0 || h <= 0 || !img.naturalWidth || !img.naturalHeight) return false;
    return Math.min(w / img.naturalWidth, h / img.naturalHeight) * devicePixelRatio <= 1;
  };

  $effect(() => {
    const id = item.id;
    const thumb = item.thumbUrl;
    const big = upgrade && upgrade !== thumb ? upgrade : null;
    // An edit gives the item a new version (and new URLs), but the original file is the same:
    // keep the big picture that's up rather than dropping to the thumbnail and downloading it again.
    if (big && shown.id === id && shown.big && untrack(() => src)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probes: HTMLImageElement[] = [];
    const load = (url: string, isBig: boolean, then?: (img: HTMLImageElement) => void) => {
      const img = new Image();
      img.onload = () => {
        if (!live) return;
        src = url;
        failed = false;
        shown = { id, big: isBig };
        then?.(img);
      };
      img.src = url;
      probes.push(img);
    };
    if (!untrack(() => src)) src = thumb;
    load(thumb, false, (img) => {
      if (big && !covers(img)) timer = setTimeout(() => load(big, true), DWELL_MS);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      // Emptying src cancels a download nobody will look at.
      for (const img of probes) {
        img.onload = null;
        img.src = '';
      }
    };
  });

  function open() {
    const ids = view.result?.ids ?? [];
    const index = ids.indexOf(item.id);
    ui.viewer =
      index >= 0 ? { mode: 'detail', ids, index } : { mode: 'detail', ids: [item.id], index: 0 };
  }
</script>

<button
  type="button"
  class="prev"
  aria-label="Open {item.name}"
  title="Open in the viewer"
  draggable="true"
  onclick={open}
  ondragstart={(e) => beginItemDrag(e, [item.id])}
  bind:clientWidth={boxW}
  bind:clientHeight={boxH}
>
  {#if src && !failed}
    <img {src} alt="" draggable="false" onerror={() => (failed = true)} />
  {:else}
    <span class="ext"><FileIcon size={28} strokeWidth={1.25} />{item.ext.toUpperCase()}</span>
  {/if}
  {#if isVideo}<span class="play"><Play size={20} fill="currentColor" /></span>{/if}
</button>

<style>
  .prev {
    display: block;
    position: relative;
    width: 100%;
    height: 250px;
    border-radius: 7px;
    background: var(--fld);
    cursor: pointer;
    overflow: hidden;
  }
  img {
    position: absolute;
    inset: 10px;
    width: calc(100% - 20px);
    height: calc(100% - 20px);
    object-fit: contain;
    filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.45));
  }
  .ext {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--fa);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
  }
  .play {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 44px;
    height: 44px;
    margin: -22px 0 0 -22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    color: var(--tx);
    pointer-events: none;
  }
  .play :global(svg) {
    margin-left: 2px;
  }
</style>
