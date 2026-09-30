<script lang="ts">
  // One picture on a Stage: the thumbnail at once, the big rendition swapped in when it has
  // loaded. Also used for the thumbnail of items the viewer can't play or render itself.
  import { untrack } from 'svelte';
  import type { Item } from '../../../shared/types';
  import { beginItemDrag } from '../../lib/dnd';
  import { AnimPlayer, MAX_ANIM_BYTES, animMime } from './anim.svelte';
  import Stage from './Stage.svelte';
  import SwapImg from './SwapImg.svelte';
  import { FIT_VIEW, type StageView } from './stageMath';
  import type { Bg } from './state.svelte';

  interface Props {
    item: Item;
    view?: StageView;
    flip?: boolean;
    gray?: boolean;
    rotate?: number;
    bg?: Bg | 'none';
    opacity?: number;
    register?: boolean;
    /** At fit, dragging the picture starts a native drag of the file (reference window). */
    dragOut?: boolean;
    /**
     * Play an animated GIF or WebP through an AnimPlayer (pause, frame step, speed). Bound out
     * so the parent can drive it; null until the frames are decoded, or for a still picture.
     */
    animate?: boolean;
    anim?: AnimPlayer | null;
    /** Bound out: nothing could be loaded (the parent may show something else instead). */
    broken?: boolean;
    /** Show only the thumbnail (videos and files we can't render). */
    thumbOnly?: boolean;
    onclick?: () => void;
    ondblclick?: () => void;
  }
  let {
    item,
    view = $bindable(FIT_VIEW),
    flip = false,
    gray = false,
    rotate = 0,
    bg = 'dark',
    opacity = 1,
    register = false,
    dragOut = false,
    animate = false,
    anim = $bindable(null),
    broken = $bindable(false),
    thumbOnly = false,
    onclick,
    ondblclick,
  }: Props = $props();

  let loNat = $state<{ w: number; h: number } | null>(null);
  let hiNat = $state<{ w: number; h: number } | null>(null);
  let hiOk = $state(false);
  let hiFailed = $state(false);
  let loFailed = $state(false);
  let zoomed = $state(false);
  let cv = $state<HTMLCanvasElement>();

  const natural = (img: HTMLImageElement) =>
    img.naturalWidth > 0 && img.naturalHeight > 0
      ? { w: img.naturalWidth, h: img.naturalHeight }
      : null;

  // The item's own size is what "100%" means, but only if it agrees with the picture we actually
  // got (EXIF rotation can swap the sides; then trust the picture).
  const dims = $derived.by(() => {
    const own = item.width && item.height ? { w: item.width, h: item.height } : null;
    const nat = hiNat ?? loNat;
    if (!nat) return own ?? { w: 0, h: 0 };
    if (own && Math.abs(own.w / own.h - nat.w / nat.h) / (nat.w / nat.h) < 0.02) return own;
    return nat;
  });

  // A GIF or WebP waits for the player to read its header: a still one then loads as usual, an
  // animated one shows the player's copy of the file (downloaded once). Once the player has the
  // frames it draws them itself, and the <img> (which can't be paused) goes.
  const playable = untrack(() => animate && !!animMime(item.ext) && item.size <= MAX_ANIM_BYTES);
  const bigSrc = $derived(
    thumbOnly || hiFailed || anim?.ready
      ? ''
      : !playable
        ? item.previewUrl
        : (anim?.src ?? (anim?.kind === 'still' ? item.previewUrl : '')),
  );
  $effect(() => {
    broken = loFailed && (thumbOnly || hiFailed);
  });
  const loading = $derived(!thumbOnly && !hiOk && !hiFailed);
  // Huge pictures come as a smaller stand-in (8192 px). Zoomed in, say so: "100%" is the original's
  // size, but the pixels on screen are the preview's.
  const standIn = $derived.by(() => {
    const own = Math.max(item.width ?? 0, item.height ?? 0);
    const got = hiNat ? Math.max(hiNat.w, hiNat.h) : 0;
    return hiOk && got > 0 && own > got * 1.05 ? { got, own } : null;
  });

  // The URL is read once: an edit bumps its version, and restarting the animation for a rating is silly.
  $effect(() => {
    const canvas = cv;
    const type = untrack(() => animMime(item.ext));
    if (!playable || !canvas || !type) return;
    const player = new AnimPlayer(canvas);
    void player.load(
      untrack(() => item.fileUrl),
      type,
    );
    anim = player;
    return () => {
      player.destroy();
      anim = null;
    };
  });
</script>

<div class="iv">
  <Stage
    w={dims.w}
    h={dims.h}
    bind:view
    bind:zoomed
    {flip}
    {gray}
    {rotate}
    {bg}
    {opacity}
    {register}
    {onclick}
    {ondblclick}
  >
    {#if !hiOk}
      <SwapImg
        src={item.thumbUrl}
        fit="contain"
        onload={(img) => (loNat = natural(img))}
        onerror={() => (loFailed = true)}
      />
    {/if}
    {#if bigSrc}
      <SwapImg
        src={bigSrc}
        draggable={dragOut && !zoomed}
        ondragstart={(e) => beginItemDrag(e, [item.id])}
        onload={(img) => ((hiNat = natural(img)), (hiOk = true))}
        onerror={() => (hiFailed = true)}
      />
    {/if}
    {#if animate}<canvas bind:this={cv} class="anim" class:off={!anim?.ready}></canvas>{/if}
  </Stage>
  {#if loading}<span class="spin" aria-label="Loading"></span>{/if}
  {#if broken}
    <p class="err">Couldn’t load this picture</p>
  {:else if hiFailed && !thumbOnly}
    <p class="note">Couldn’t load the full picture. Showing the thumbnail.</p>
  {:else if standIn && zoomed}
    <p class="note">
      This is a preview ({standIn.got.toLocaleString()} px). The original is {standIn.own.toLocaleString()}
      px.
    </p>
  {/if}
</div>

<style>
  .iv {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .anim {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .anim.off {
    display: none;
  }
  .spin {
    position: absolute;
    right: 14px;
    bottom: 14px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--panel-line);
    border-top-color: var(--mu);
    opacity: 0;
    /* Only show for slow loads (huge files), so a fast swap doesn't flicker. */
    animation:
      spin-in 200ms ease-out 500ms forwards,
      spin 900ms linear infinite;
    pointer-events: none;
  }
  @keyframes spin-in {
    to {
      opacity: 1;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .note {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    margin: 0;
    padding: 4px 12px;
    border-radius: 12px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    color: var(--mu);
    font-size: 12px;
    pointer-events: none;
  }
  .err {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--fa);
    pointer-events: none;
  }
</style>
