<script lang="ts">
  // Playback controls for a <video> or <audio>, and the Player hook the key commands use
  // (Space, seek, frame step, speed, volume). Keys are commands in commands.ts, not handlers here.
  import Play from '@lucide/svelte/icons/play';
  import { readJSON, writeJSON } from '../../lib/storage';
  import Pause from '@lucide/svelte/icons/pause';
  import SkipBack from '@lucide/svelte/icons/skip-back';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import Repeat from '@lucide/svelte/icons/repeat';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Volume1 from '@lucide/svelte/icons/volume-1';
  import VolumeX from '@lucide/svelte/icons/volume-x';
  import Maximize from '@lucide/svelte/icons/maximize';
  import Camera from '@lucide/svelte/icons/camera';
  import { openContextMenuAt } from '../../lib/contextMenu.svelte';
  import { frameMenuItems, type FrameActions } from './menu';
  import Slider from './Slider.svelte';
  import { SPEEDS, clock, nextSpeed, stepTarget } from './media';
  import { viewer, type Player } from './state.svelte';

  interface Props {
    media: HTMLMediaElement | undefined;
    video: boolean;
    /** Frames per second, for frame stepping. */
    fps?: number;
    onfullscreen?: () => void;
    /** Video: what the frame button (and Shift+C, Shift+S) can do with the frame on screen. */
    frames?: FrameActions;
  }
  let { media, video, fps = 30, onfullscreen, frames }: Props = $props();

  const VOL_KEY = 'viewer.volume';
  function savedVolume(): { v: number; muted: boolean } {
    const s = readJSON<{ v?: unknown; muted?: unknown } | null>(VOL_KEY, null);
    if (s && typeof s.v === 'number') return { v: Math.min(1, Math.max(0, s.v)), muted: !!s.muted };
    return { v: 1, muted: false };
  }

  let cur = $state(0);
  let dur = $state(0);
  let playing = $state(false);
  let rate = $state(1);
  let vol = $state(1);
  let muted = $state(false);
  let looping = $state(false);
  let buffered = $state(0);

  $effect(() => {
    const m = media;
    if (!m) return;
    const saved = savedVolume();
    m.volume = saved.v;
    m.muted = saved.muted;

    const sync = () => {
      cur = m.currentTime;
      dur = Number.isFinite(m.duration) ? m.duration : 0;
      playing = !m.paused && !m.ended;
      rate = m.playbackRate;
      vol = m.volume;
      muted = m.muted;
      looping = m.loop;
      buffered = m.buffered.length ? m.buffered.end(m.buffered.length - 1) : 0;
    };
    // timeupdate is only ~4 Hz; while playing, follow the clock every frame for a smooth bar.
    let raf = 0;
    const tick = () => {
      cur = m.currentTime;
      raf = requestAnimationFrame(tick);
    };
    const onplay = () => {
      sync();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onstop = () => {
      cancelAnimationFrame(raf);
      sync();
    };
    const onvolume = () => {
      sync();
      writeJSON(VOL_KEY, { v: m.volume, muted: m.muted });
    };
    const plain = [
      'timeupdate',
      'durationchange',
      'loadedmetadata',
      'ratechange',
      'progress',
      'seeked',
      'emptied',
    ];
    plain.forEach((e) => m.addEventListener(e, sync));
    m.addEventListener('play', onplay);
    m.addEventListener('playing', onplay);
    m.addEventListener('pause', onstop);
    m.addEventListener('ended', onstop);
    m.addEventListener('volumechange', onvolume);
    sync();
    if (!m.paused) onplay();
    return () => {
      cancelAnimationFrame(raf);
      plain.forEach((e) => m.removeEventListener(e, sync));
      m.removeEventListener('play', onplay);
      m.removeEventListener('playing', onplay);
      m.removeEventListener('pause', onstop);
      m.removeEventListener('ended', onstop);
      m.removeEventListener('volumechange', onvolume);
    };
  });

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  function toggle() {
    const m = media;
    if (!m) return;
    if (m.paused || m.ended) void m.play().catch(() => {});
    else m.pause();
  }
  const seekBy = (dt: number) =>
    media && (media.currentTime = clamp(media.currentTime + dt, 0, dur || media.duration || 0));
  function frame(n: number) {
    const m = media;
    if (!m) return;
    m.pause();
    m.currentTime = stepTarget(m.currentTime, fps, n, dur);
  }
  const setSpeed = (r: number) => {
    if (media) media.playbackRate = r;
  };
  const player: Player = {
    get kind() {
      return video ? 'video' : 'audio';
    },
    toggle,
    seek: seekBy,
    frame: (n) => video && frame(n),
    speed: (dir) => media && setSpeed(nextSpeed(media.playbackRate, dir)),
    volume: (dv) => {
      if (!media) return;
      media.muted = false;
      media.volume = clamp(media.volume + dv, 0, 1);
    },
    mute: () => media && (media.muted = !media.muted),
    loop: () => media && (media.loop = !media.loop),
    fullscreen: () => onfullscreen?.(),
    get copyFrame() {
      return frames?.copy;
    },
    get saveFrame() {
      return frames?.save;
    },
    get frameAsThumbnail() {
      return frames?.asThumbnail;
    },
  };
  $effect(() => {
    if (!media) return;
    viewer.player = player;
    return () => {
      if (viewer.player === player) viewer.player = null;
    };
  });

  function speedMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = Math.max(8, r.top - (SPEEDS.length * 28 + 16));
    openContextMenuAt(
      r.left,
      y,
      SPEEDS.map((s) => ({
        label: `${s}×`,
        checked: Math.abs(s - rate) < 1e-6,
        run: () => setSpeed(s),
      })),
    );
  }

  function frameMenu(e: MouseEvent) {
    if (!frames) return;
    media?.pause(); // the frame you pick from is the one you keep
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenuAt(r.left, Math.max(8, r.top - 3 * 30 - 16), frameMenuItems(frames));
  }

  const shownVol = $derived(muted ? 0 : vol);
  const rateLabel = $derived(`${Number(rate.toFixed(2))}×`);
</script>

<div class="bar">
  <button
    type="button"
    class="ib"
    aria-label={playing ? 'Pause' : 'Play'}
    title="{playing ? 'Pause' : 'Play'} (Space)"
    onclick={toggle}
  >
    {#if playing}<Pause size={16} />{:else}<Play size={16} />{/if}
  </button>
  <span class="time" aria-live="off">{clock(cur, !playing)} / {clock(dur)}</span>
  <Slider
    label="Seek"
    value={cur}
    max={dur || 1}
    {buffered}
    tip={(v) => clock(v)}
    onchange={(v) => media && (media.currentTime = v)}
  />
  {#if video}
    <button
      type="button"
      class="ib"
      aria-label="Previous frame"
      title="Previous frame ( [ )"
      onclick={() => frame(-1)}><SkipBack size={14} /></button
    >
    <button
      type="button"
      class="ib"
      aria-label="Next frame"
      title="Next frame ( ] )"
      onclick={() => frame(1)}><SkipForward size={14} /></button
    >
  {/if}
  <button
    type="button"
    class="ib txt"
    aria-label="Speed"
    title="Speed (Shift+. faster, Shift+, slower)"
    onclick={speedMenu}>{rateLabel}</button
  >
  <button
    type="button"
    class="ib"
    class:on={looping}
    aria-label="Loop"
    aria-pressed={looping}
    title="Loop (L)"
    onclick={() => player.loop?.()}
  >
    <Repeat size={15} />
  </button>
  <button
    type="button"
    class="ib"
    aria-label={muted ? 'Unmute' : 'Mute'}
    title="{muted ? 'Unmute' : 'Mute'} (M)"
    onclick={() => player.mute?.()}
  >
    {#if shownVol === 0}<VolumeX size={16} />{:else if shownVol < 0.5}<Volume1
        size={16}
      />{:else}<Volume2 size={16} />{/if}
  </button>
  <span class="vol"
    ><Slider
      label="Volume"
      value={shownVol}
      tip={(v) => `${Math.round(v * 100)}%`}
      onchange={(v) => ((media!.muted = false), (media!.volume = v))}
    /></span
  >
  {#if video && frames}
    <button
      type="button"
      class="ib"
      aria-label="Frame"
      title="This frame: copy (Shift+C), save (Shift+S) or use as the thumbnail"
      onclick={frameMenu}><Camera size={15} /></button
    >
  {/if}
  {#if video && onfullscreen}
    <button
      type="button"
      class="ib"
      aria-label="Full screen"
      title="Full screen (double-click the video)"
      onclick={onfullscreen}><Maximize size={15} /></button
    >
  {/if}
</div>

<style>
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 44px;
    padding: 0 12px;
    background: var(--bg);
    border-top: 1px solid var(--line);
    color: var(--mu);
  }
  .ib {
    flex: none;
    min-width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: var(--radius);
    color: var(--mu);
  }
  .ib:hover {
    background: var(--hov);
    color: var(--tx);
  }
  .ib.on {
    color: var(--bl-soft);
    background: var(--bls);
  }
  .ib.txt {
    padding: 0 8px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .ib:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
  .time {
    flex: none;
    min-width: 92px;
    font-size: 12px;
    color: var(--mu);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .vol {
    flex: none;
    width: 76px;
    display: flex;
  }
</style>
