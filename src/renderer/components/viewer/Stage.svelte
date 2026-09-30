<script lang="ts">
  // The one zoom / pan / flip / grayscale / rotate surface. Detail view, quick look, compare
  // panes and the reference window all use it. It knows nothing about what it shows: the
  // content (an <img>, a <video>...) is a child that fills a box of the picture's natural size,
  // and the whole box is moved with a single CSS transform, so zooming never re-lays anything out.
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import { viewer, type Bg, type StageApi } from './state.svelte';
  import {
    FIT_VIEW,
    canPan,
    clampView,
    fitScale,
    panBy,
    zoomAround,
    type Ctx,
    type StageView,
  } from './stageMath';

  interface Props {
    /** Natural size of the content in px (0 while unknown). */
    w: number;
    h: number;
    view?: StageView;
    flip?: boolean;
    gray?: boolean;
    rotate?: number;
    /** 'none' leaves the stage see-through (reference window, top layer of split compare). */
    bg?: Bg | 'none';
    opacity?: number;
    /** Let the key commands and the zoom label reach this stage. */
    register?: boolean;
    /** Bound out: the picture is bigger than the stage, so dragging pans. */
    zoomed?: boolean;
    /** A plain click (not the end of a drag). */
    onclick?: () => void;
    /** Replaces the default double-click (fit <-> 100%). */
    ondblclick?: () => void;
    children: Snippet;
  }
  let {
    w,
    h,
    view = $bindable(FIT_VIEW),
    flip = false,
    gray = false,
    rotate = 0,
    bg = 'dark',
    opacity = 1,
    register = false,
    zoomed = $bindable(false),
    onclick,
    ondblclick,
    children,
  }: Props = $props();

  let root = $state<HTMLDivElement>();
  let bw = $state(0);
  let bh = $state(0);
  let anim = $state(false);
  let animTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set by "100%": keep 100% when the stage is resized (the info panel opens, the window changes). */
  let lockActual = false;
  let press: { x: number; y: number; moved: boolean; panning: boolean } | null = $state(null);

  const rot = $derived(((rotate % 360) + 360) % 360);
  const img = $derived({ w: Math.max(1, w), h: Math.max(1, h) });
  const fit = $derived(fitScale({ w: bw, h: bh }, img, rot));
  const ctx = $derived<Ctx>({ box: { w: bw, h: bh }, img, rot, fit });
  const eff = $derived(clampView(view, ctx));
  const scale = $derived(fit * eff.z);
  const ready = $derived(w > 0 && h > 0 && bw > 0);
  const tx = $derived(eff.px * (rot % 180 ? img.h : img.w) * fit);
  const ty = $derived(eff.py * (rot % 180 ? img.w : img.h) * fit);

  $effect(() => {
    zoomed = canPan(eff, ctx);
  });

  // "100%" pinned: recompute the relative zoom when the fit size changes under it.
  $effect(() => {
    const f = fit;
    untrack(() => {
      if (!lockActual || !(f > 0)) return;
      const next = clampView({ ...view, z: 1 / f }, ctx);
      if (Math.abs(next.z - view.z) > 1e-9) view = next;
    });
  });

  function animate() {
    anim = true;
    clearTimeout(animTimer);
    animTimer = setTimeout(() => (anim = false), 170);
  }

  const api: StageApi = {
    zoomBy(f) {
      lockActual = false;
      animate();
      view = zoomAround(eff, eff.z * f, 0, 0, ctx, true);
    },
    fit() {
      lockActual = false;
      animate();
      view = FIT_VIEW;
    },
    actual() {
      api.toScale(1);
      lockActual = true;
    },
    toggle() {
      if (eff.z !== 1) return api.fit();
      // Fit -> real size; a picture already at real size (small) goes to 200%.
      api.toScale(fit < 0.99 ? 1 : 2);
    },
    toScale(s) {
      lockActual = false;
      animate();
      view = zoomAround(eff, s / fit, 0, 0, ctx);
    },
  };

  $effect(() => {
    if (!register) return;
    viewer.stages.add(api);
    return () => void viewer.stages.delete(api);
  });
  onDestroy(() => clearTimeout(animTimer));

  $effect(() => {
    if (register) viewer.zoom = { scale, atFit: eff.z === 1 };
  });

  // Wheel needs a non-passive listener: Ctrl+wheel would otherwise zoom the whole page.
  $effect(() => {
    const el = root;
    if (!el) return;
    const onwheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      // Trackpad pinch arrives as small Ctrl+wheel steps; a mouse wheel notch is about 100.
      const rate = e.ctrlKey && Math.abs(dy) < 20 ? 0.02 : 0.0015;
      lockActual = false;
      view = zoomAround(eff, eff.z * Math.exp(-dy * rate), cx, cy, ctx, true);
    };
    el.addEventListener('wheel', onwheel, { passive: false });
    return () => el.removeEventListener('wheel', onwheel);
  });

  function down(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    const panning = canPan(eff, ctx);
    press = { x: e.clientX, y: e.clientY, moved: false, panning };
    if (panning) root?.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!press || !press.panning) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 3) return;
    press.moved = true;
    press.x = e.clientX;
    press.y = e.clientY;
    lockActual = false;
    view = panBy(eff, dx, dy, ctx);
  }
  function up(e: PointerEvent) {
    const p = press;
    press = null;
    if (!p) return;
    if (p.panning) root?.releasePointerCapture(e.pointerId);
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) onclick?.();
  }
  function cancel() {
    press = null;
  }
</script>

<div
  class="stage"
  class:pan={zoomed}
  class:dragging={press?.moved}
  data-bg={bg}
  bind:this={root}
  bind:clientWidth={bw}
  bind:clientHeight={bh}
  role="presentation"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancel}
  ondblclick={() => (ondblclick ? ondblclick() : api.toggle())}
>
  <div
    class="content"
    class:anim
    class:ready
    style="width:{img.w}px;height:{img.h}px;margin:{-img.h / 2}px 0 0 {-img.w /
      2}px;opacity:{opacity};transform:translate({tx}px,{ty}px) scaleX({flip
      ? -1
      : 1}) rotate({rot}deg) scale({scale});{gray ? 'filter:grayscale(1)' : ''}"
  >
    {@render children()}
  </div>
</div>

<style>
  .stage {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  /* Backdrops behind the picture. They are image-viewing swatches (like a palette), not theme colors. */
  .stage[data-bg='dark'] {
    background: var(--thumb-bg);
  }
  .stage[data-bg='light'] {
    background: #e8e8ea;
  }
  .stage[data-bg='checker'] {
    background: repeating-conic-gradient(#7d7e83 0% 25%, #a9aaae 0% 50%) 0 0 / 24px 24px;
  }
  .stage.pan {
    cursor: grab;
  }
  .stage.dragging {
    cursor: grabbing;
  }
  .content {
    position: absolute;
    left: 50%;
    top: 50%;
    visibility: hidden;
    transition: filter 120ms ease-out;
  }
  .content.ready {
    visibility: visible;
  }
  .content.anim {
    transition:
      transform 150ms ease-out,
      filter 120ms ease-out;
  }
</style>
