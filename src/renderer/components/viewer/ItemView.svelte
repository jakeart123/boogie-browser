<script lang="ts">
  // Shows one item the right way for its type. Detail view, quick look and the slideshow all
  // use this; the parent keys it on the item id so zoom, pause and player state start fresh.
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import type { Item } from '../../../shared/types';
  import AudioPlayer from './AudioPlayer.svelte';
  import FilePanel from './FilePanel.svelte';
  import FontView from './FontView.svelte';
  import ImageView from './ImageView.svelte';
  import PdfView from './PdfView.svelte';
  import VideoPlayer from './VideoPlayer.svelte';
  import type { AnimPlayer } from './anim.svelte';
  import { viewKind } from '../../lib/fileKinds';
  import { FIT_VIEW, type StageView } from './stageMath';
  import { viewer, type Player } from './state.svelte';

  interface Props {
    item: Item;
    variant?: 'detail' | 'quicklook' | 'present';
    /** The current video or audio ended (slideshow moves on). */
    onended?: () => void;
    /** Double-click on a picture (the detail view closes; elsewhere it zooms). */
    ondblclick?: () => void;
  }
  let { item, variant = 'detail', onended, ondblclick }: Props = $props();

  const kind = $derived(viewKind(item.ext));
  // A picture nothing could be drawn for (a Clip Studio file, a render that failed): the file panel.
  let broken = $state(false);
  // The slideshow is on black whatever background the viewer uses.
  const bg = $derived(variant === 'present' ? ('none' as const) : viewer.bg);
  let view = $state<StageView>(FIT_VIEW);
  let anim = $state<AnimPlayer | null>(null);

  // Space, [ ] and Shift+< > work on an animated picture like they do on a video.
  $effect(() => {
    const a = anim;
    if (!a?.ready) return;
    const player: Player = {
      kind: 'gif',
      toggle: () => a.toggle(),
      frame: (n) => a.step(n),
      speed: (d) => a.nudgeSpeed(d),
    };
    viewer.player = player;
    return () => {
      if (viewer.player === player) viewer.player = null;
    };
  });
</script>

{#if kind === 'image' && !broken}
  <div class="iv">
    <ImageView
      {item}
      bind:view
      flip={viewer.flip}
      gray={viewer.gray}
      rotate={viewer.rotate}
      {bg}
      register
      animate
      bind:anim
      bind:broken
      {ondblclick}
    />
    {#if anim?.ready && variant !== 'present'}
      <button
        type="button"
        class="gif"
        class:paused={!anim.playing}
        aria-pressed={!anim.playing}
        title="{anim.playing ? 'Pause' : 'Play'} (Space). Step frames with [ and ]"
        onclick={() => anim?.toggle()}
      >
        {#if anim.playing}<Pause size={14} />{:else}<Play size={14} />{/if}
        {anim.playing ? 'Playing' : 'Paused'}
        <span class="fr">{anim.index + 1} / {anim.count}</span>
      </button>
    {/if}
  </div>
{:else if kind === 'video'}
  <VideoPlayer
    {item}
    flip={viewer.flip}
    gray={viewer.gray}
    rotate={viewer.rotate}
    {bg}
    bare={variant === 'present'}
    {onended}
  />
{:else if kind === 'audio'}
  <AudioPlayer {item} {onended} />
{:else if kind === 'pdf'}
  <PdfView {item} flip={viewer.flip} gray={viewer.gray} rotate={viewer.rotate} {bg} />
{:else if kind === 'font'}
  <FontView {item} />
{:else}
  <FilePanel {item} {bg} {ondblclick} />
{/if}

<style>
  .iv {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .gif {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    color: var(--tx);
    font-size: 12px;
    opacity: 0.85;
  }
  .gif:hover,
  .gif.paused {
    opacity: 1;
  }
  .gif:hover {
    background: var(--hov);
  }
  .fr {
    color: var(--fa);
    font-variant-numeric: tabular-nums;
  }
</style>
