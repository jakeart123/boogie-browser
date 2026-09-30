<script lang="ts">
  // A video on the shared stage (so it zooms, pans, flips and goes gray like a picture) with our
  // own controls under it. Formats Chromium can't decode fall back to the thumbnail panel.
  import { untrack } from 'svelte';
  import type { Item } from '../../../shared/types';
  import FilePanel from './FilePanel.svelte';
  import MediaBar from './MediaBar.svelte';
  import Stage from './Stage.svelte';
  import { canPlayVideo } from '../../lib/fileKinds';
  import { estimateFps } from './media';
  import { copyFrame, frameAsThumbnail, saveFrame } from './actions';
  import type { FrameActions } from './menu';
  import { FIT_VIEW, type StageView } from './stageMath';
  import { viewer, type Bg } from './state.svelte';

  interface Props {
    item: Item;
    flip?: boolean;
    gray?: boolean;
    rotate?: number;
    bg?: Bg | 'none';
    /** Start playing at once (detail, quick look, slideshow). */
    autoplay?: boolean;
    /** No control bar (slideshow). */
    bare?: boolean;
    onended?: () => void;
  }
  let {
    item,
    flip = false,
    gray = false,
    rotate = 0,
    bg = 'dark',
    autoplay = true,
    bare = false,
    onended,
  }: Props = $props();

  // An edit bumps the URL's version; reloading would restart the video, so the source is fixed.
  const src = untrack(() => item.fileUrl);
  let v = $state<HTMLVideoElement>();
  let wrap = $state<HTMLDivElement>();
  let view = $state<StageView>(FIT_VIEW);
  let vw = $state(0);
  let vh = $state(0);
  let failed = $state(!canPlayVideo(untrack(() => item.ext)));
  let fps = $state(30);

  const w = $derived(vw || item.width || 0);
  const h = $derived(vh || item.height || 0);

  function meta() {
    if (!v) return;
    vw = v.videoWidth;
    vh = v.videoHeight;
    // Sound but no picture: the video codec (HEVC, ProRes...) isn't supported here.
    if (!vw && item.width) failed = true;
  }

  function toggle() {
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  }

  // Pause first: the frame you asked for is the one on screen, not one a moment later.
  const grab = (fn: (v: HTMLVideoElement) => unknown) => () => {
    if (!v) return;
    v.pause();
    void fn(v);
  };
  const frames: FrameActions = {
    copy: grab(copyFrame),
    save: grab((el) => saveFrame(el, item.name)),
    asThumbnail: grab((el) => frameAsThumbnail(el, item.id)),
  };

  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap?.requestFullscreen?.().catch(() => {});
  }

  // Frame rate from the gaps between presented frames, so [ and ] step one real frame.
  $effect(() => {
    const el = v;
    if (!el || !('requestVideoFrameCallback' in el)) return;
    const gaps: number[] = [];
    let last: { t: number; n: number } | null = null;
    let id = 0;
    const onframe = (_now: number, md: VideoFrameCallbackMetadata) => {
      if (last && md.presentedFrames === last.n + 1) gaps.push(md.mediaTime - last.t);
      if (gaps.length > 60) gaps.shift();
      if (gaps.length >= 5) fps = estimateFps(gaps);
      last = { t: md.mediaTime, n: md.presentedFrames };
      id = el.requestVideoFrameCallback(onframe);
    };
    id = el.requestVideoFrameCallback(onframe);
    return () => el.cancelVideoFrameCallback(id);
  });

  // In the slideshow a video that can't play must not hold it up: show the panel for a moment, move on.
  $effect(() => {
    if (!failed || !bare || !onended || viewer.paused) return;
    const t = setTimeout(onended, 3000);
    return () => clearTimeout(t);
  });

  // Let go of the decoder when we leave (a 5 GB file must not keep streaming from a hidden element).
  $effect(() => {
    const el = v;
    return () => {
      if (!el) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  });
</script>

{#if failed}
  <FilePanel {item} {bg} message="Can’t play this format here." />
{:else}
  <div class="vp" bind:this={wrap}>
    <div class="box">
      <Stage
        {w}
        {h}
        bind:view
        {flip}
        {gray}
        {rotate}
        {bg}
        register
        onclick={toggle}
        ondblclick={fullscreen}
      >
        <!-- svelte-ignore a11y_media_has_caption -->
        <!-- crossorigin: boogie:// answers any origin, and without it the frame can't be read back -->
        <video
          bind:this={v}
          {src}
          crossorigin="anonymous"
          poster={item.thumbUrl}
          {autoplay}
          preload="metadata"
          playsinline
          disablepictureinpicture
          onloadedmetadata={meta}
          onerror={() => (failed = true)}
          {onended}
        ></video>
      </Stage>
    </div>
    {#if !bare}<MediaBar media={v} video {fps} onfullscreen={fullscreen} {frames} />{/if}
  </div>
{/if}

<style>
  .vp {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--thumb-bg);
  }
  .box {
    flex: 1;
    min-height: 0;
  }
  video {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
