<script lang="ts">
  // One thumbnail tile (justified, masonry and grid layouts). Positioned by the parent with a
  // transform; everything here is cheap because only the tiles near the viewport exist.
  import File from '@lucide/svelte/icons/file';
  import FileText from '@lucide/svelte/icons/file-text';
  import FileArchive from '@lucide/svelte/icons/file-archive';
  import Film from '@lucide/svelte/icons/film';
  import Music from '@lucide/svelte/icons/music';
  import Star from '@lucide/svelte/icons/star';
  import Type from '@lucide/svelte/icons/type';
  import { fileKind, wantsBadge, type FileKind } from '../../lib/fileKinds';
  import { duration } from '../../lib/format';
  import { items } from '../../lib/stores/items.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import type { LayoutKind } from './layout';
  import { SETTLE_MS, dropSrc, loadedLately, markLoaded } from './thumbLoad';

  interface Props {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    kind: LayoutKind;
    showNames: boolean;
    showMeta: boolean;
    /** Arrived from outside (the partner, an agent, a browser extension) during this session. */
    isNew: boolean;
    /** Set only on the one tile being hover-previewed. */
    hover: { kind: 'video' | 'gif' | 'audio'; src: string } | null;
  }
  let { id, x, y, w, h, kind, showNames, showMeta, isNew, hover }: Props = $props();

  let loaded = $state(false);
  let broken = $state(false);
  let video = $state<HTMLVideoElement>();
  let videoReady = $state(false);

  // The cache keeps the old brief while an edited item is fetched again, so nothing blinks.
  const b = $derived(items.brief(id));
  const selected = $derived(selection.has(id));
  const primary = $derived(selection.primary === id);
  const fk = $derived<FileKind>(b ? fileKind(b.ext) : 'image');
  const src = $derived(hover?.kind === 'gif' ? hover.src : b?.thumbUrl);
  // The picture is asked for once the tile has stayed in the window a moment (thumbLoad.ts).
  let settled = $state(false);
  $effect(() => {
    const t = setTimeout(() => (settled = true), SETTLE_MS);
    return () => clearTimeout(t);
  });
  const showImg = $derived(settled || loadedLately(src));
  // A new picture (Refresh thumbnail, an edit elsewhere) gets a fresh try even if the old one failed.
  $effect(() => {
    void b?.thumbUrl;
    broken = false;
  });
  // The next hover starts from the thumbnail, not a blank video layer.
  $effect(() => {
    if (hover?.kind !== 'video') videoReady = false;
  });
  // Types Eagle can't draw have no thumbnail in the library, but Boogie may have its own cached
  // preview for them (localThumb): drawn like any other, fitted, since their size isn't known.
  const drawable = $derived(!!b && (!b.noPreview || !!b.localThumb));
  // The placeholder already spells out the file type, so it needs no badge on top.
  const showsPlaceholder = $derived(!!b && (!drawable || broken));
  const meta = $derived(b?.width && b.height ? `${b.width} × ${b.height}` : '');

  // A cached image can finish loading before Svelte attaches onload.
  function ready(img: HTMLImageElement) {
    if (img.complete && img.naturalWidth > 0) loaded = true;
  }

  function onLoad() {
    loaded = true;
    markLoaded(src);
  }

  function scrub(e: PointerEvent) {
    if (!video || !Number.isFinite(video.duration)) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    video.currentTime = f * video.duration;
  }
</script>

<div
  class="tile"
  class:sel={selected}
  class:pri={primary}
  role="option"
  aria-selected={selected}
  data-id={id}
  style="transform: translate({x}px, {y}px); width: {w}px"
>
  <div
    class="th"
    class:contain={kind === 'grid' || !!b?.localThumb}
    style="height: {h}px"
    role="presentation"
    draggable="true"
    onpointermove={hover?.kind === 'video' ? scrub : undefined}
  >
    {#if b && drawable && !broken}
      {#if showImg}
        <img
          class:loaded
          {src}
          alt={b.name}
          decoding="async"
          draggable="true"
          use:ready
          use:dropSrc
          onload={onLoad}
          onerror={() => !hover && (broken = true)}
        />
      {/if}
    {:else if b}
      <div class="ph">
        {#if fk === 'video'}<Film size={28} />
        {:else if fk === 'audio'}<Music size={28} />
        {:else if fk === 'pdf' || fk === 'doc'}<FileText size={28} />
        {:else if fk === 'archive'}<FileArchive size={28} />
        {:else if fk === 'font'}<Type size={28} />
        {:else}<File size={28} />{/if}
        <span>{b.ext}</span>
      </div>
    {/if}
    {#if hover?.kind === 'audio'}
      <audio src={hover.src} autoplay preload="auto"></audio>
    {/if}
    {#if hover?.kind === 'video'}
      <video
        bind:this={video}
        class="pv"
        class:on={videoReady}
        src={hover.src}
        muted
        playsinline
        preload="metadata"
        onloadeddata={() => (videoReady = true)}
      ></video>
    {/if}
    {#if b}
      <div class="badges">
        {#if isNew}<span class="new" title="New from outside"></span>{/if}
        {#if wantsBadge(b.ext) && !showsPlaceholder}<span class="ext">{b.ext}</span>{/if}
      </div>
      {#if b.duration && (fk === 'video' || fk === 'audio')}<span class="dur"
          >{duration(b.duration)}</span
        >{/if}
      {#if b.star > 0}<span class="stars" title="{b.star} of 5 stars"
          ><Star size={10} fill="currentColor" strokeWidth={0} />{b.star}</span
        >{/if}
    {/if}
  </div>
  {#if b && (showNames || showMeta)}
    {#if showNames}<div class="nm"><span>{b.name}</span></div>{/if}
    {#if showMeta}<div class="mt" class:tight={!showNames}>{meta}</div>{/if}
  {/if}
</div>

<style>
  .tile {
    position: absolute;
    left: 0;
    top: 0;
    user-select: none;
  }
  .th {
    position: relative;
    overflow: hidden;
    border-radius: 5px;
    background: var(--thumb-bg);
  }
  /* View option: a checkerboard shows which parts of a picture are transparent. */
  :global(.checker) .th {
    background: repeating-conic-gradient(var(--thumb-bg) 0 25%, var(--hov) 0 50%) 0 0 / 16px 16px;
  }
  .tile:not(.sel):hover .th {
    box-shadow: 0 0 0 1px var(--chip-line);
  }
  img,
  .pv {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .contain img,
  .contain .pv {
    object-fit: contain;
  }
  img {
    opacity: 0;
    transition: opacity 100ms ease-out;
  }
  img.loaded {
    opacity: 1;
  }
  .pv {
    position: absolute;
    inset: 0;
    opacity: 0;
    pointer-events: none;
    background: var(--thumb-bg);
  }
  .pv.on {
    opacity: 1;
  }
  .ph {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--fa);
  }
  .ph span {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .badges {
    position: absolute;
    top: 7px;
    left: 7px;
    display: flex;
    align-items: center;
    gap: 5px;
    pointer-events: none;
  }
  .new {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--rm);
    box-shadow: 0 0 0 2px color-mix(in srgb, black 45%, transparent);
  }
  .ext,
  .dur,
  .stars {
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    padding: 3px 5px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--thumb-bg) 78%, transparent);
    color: var(--tx);
    pointer-events: none;
  }
  .ext {
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .dur {
    position: absolute;
    left: 7px;
    bottom: 7px;
    font-variant-numeric: tabular-nums;
  }
  .stars {
    position: absolute;
    right: 7px;
    bottom: 7px;
    display: flex;
    align-items: center;
    gap: 3px;
    color: var(--star);
    opacity: 0.85;
  }

  .nm {
    margin-top: 7px;
    height: 17px;
    font-size: 12px;
    line-height: 17px;
    text-align: center;
    white-space: nowrap;
  }
  .nm span {
    display: inline-block;
    max-width: 100%;
    padding: 0 6px;
    border-radius: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: top;
  }
  .mt {
    height: 16px;
    font-size: 11px;
    line-height: 16px;
    color: var(--fa);
    text-align: center;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mt.tight {
    margin-top: 6px;
  }

  /* Selection: the primary item (the one the inspector shows) gets the strong ring. */
  .sel .th {
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--bl-soft);
  }
  .sel.pri .th {
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--bl);
  }
  .sel.pri .nm span {
    background: var(--bl);
    color: var(--tx);
  }
</style>
