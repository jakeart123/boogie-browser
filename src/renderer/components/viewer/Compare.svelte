<script lang="ts">
  // Compare 2 to 4 items. Side by side panes (optionally sharing zoom and pan); for exactly two,
  // also a split view (drag a divider to reveal one over the other) and an opacity overlay.
  // Panes show the same part of the picture: the view is stored relative to fit (stageMath.ts).
  import Contrast from '@lucide/svelte/icons/contrast';
  import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal';
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
  import Moon from '@lucide/svelte/icons/moon';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Sun from '@lucide/svelte/icons/sun';
  import X from '@lucide/svelte/icons/x';
  import type { Item } from '../../../shared/types';
  import { fileSize } from '../../lib/format';
  import { items } from '../../lib/stores/items.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import IconBtn from './IconBtn.svelte';
  import ImageView from './ImageView.svelte';
  import Slider from './Slider.svelte';
  import { viewKind } from '../../lib/fileKinds';
  import { FIT_VIEW, type StageView } from './stageMath';
  import { viewer, type CompareMode } from './state.svelte';

  let panes = $state.raw<Item[]>([]);
  let shared = $state<StageView>(FIT_VIEW);
  let own = $state<StageView[]>([FIT_VIEW, FIT_VIEW, FIT_VIEW, FIT_VIEW]);
  let split = $state(50); // divider position, percent from the left
  let splitEl = $state<HTMLDivElement>();
  let dragging = $state(false);

  const two = $derived(panes.length === 2);
  const mode = $derived<CompareMode>(two ? viewer.compareMode : 'side');
  /** Split and overlay stack the two pictures, so they always share one view. */
  const linked = $derived(viewer.sync || mode !== 'side');

  $effect(() => {
    viewer.linked = linked;
    return () => void (viewer.linked = true);
  });

  $effect(() => {
    const ids = [...(ui.viewer?.ids ?? [])];
    void items.version;
    const cached = ids.map((id) => items.full(id));
    if (cached.every((x): x is Item => !!x)) {
      panes = cached;
      if (!ids.some((id) => items.stale(id))) return;
    }
    let live = true;
    void items.loadFulls(ids).then((l) => live && (panes = l));
    return () => {
      live = false;
    };
  });

  function setSync(on: boolean) {
    if (on) shared = own[0];
    else own = own.map(() => shared);
    viewer.sync = on;
  }

  const cols = $derived(panes.length <= 2 ? panes.length : panes.length === 3 ? 3 : 2);
  const kindOf = (it: Item) => viewKind(it.ext);
  const facts = (it: Item) =>
    [
      it.width && it.height ? `${it.width} × ${it.height}` : '',
      fileSize(it.size),
      it.ext.toUpperCase(),
    ]
      .filter(Boolean)
      .join(' · ');

  function divDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
  }
  function divMove(e: PointerEvent) {
    if (!dragging || !splitEl) return;
    const r = splitEl.getBoundingClientRect();
    split = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
  }
  function divKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') split = Math.max(0, split - 2);
    else if (e.key === 'ArrowRight') split = Math.min(100, split + 2);
    else return;
    e.preventDefault();
  }

  const modes: { id: CompareMode; label: string }[] = [
    { id: 'side', label: 'Side by side' },
    { id: 'split', label: 'Split' },
    { id: 'overlay', label: 'Overlay' },
  ];
</script>

{#snippet pane(it: Item, i: number, bg: 'dark' | 'checker' | 'light' | 'none', opacity: number)}
  <ImageView
    item={it}
    bind:view={() => (linked ? shared : own[i]), (v) => (linked ? (shared = v) : (own[i] = v))}
    flip={viewer.flip}
    gray={viewer.gray}
    rotate={viewer.rotate}
    {bg}
    {opacity}
    register
    thumbOnly={kindOf(it) !== 'image'}
  />
{/snippet}

<div class="cmp" role="dialog" aria-label="Compare">
  <header class="bar">
    <IconBtn label="Close compare" title="Close (Esc)" onclick={() => (ui.viewer = null)}
      ><X size={17} /></IconBtn
    >
    <span class="ttl">Compare {panes.length || (ui.viewer?.ids.length ?? 0)} items</span>
    <span class="sp"></span>
    {#if two}
      <div class="seg" role="group" aria-label="Compare mode">
        {#each modes as m (m.id)}
          <button
            type="button"
            class:on={viewer.compareMode === m.id}
            aria-pressed={viewer.compareMode === m.id}
            onclick={() => (viewer.compareMode = m.id)}>{m.label}</button
          >
        {/each}
      </div>
      {#if mode === 'overlay'}
        <span class="ov"
          ><Slider
            label="Overlay opacity"
            value={viewer.overlay}
            tip={(v) => `${Math.round(v * 100)}%`}
            onchange={(v) => (viewer.overlay = v)}
          /></span
        >
      {/if}
    {/if}
    {#if mode === 'side'}
      <!-- A button, not a checkbox: the key handler ignores typing in inputs, and a checkbox that
           keeps focus after a click would silence Esc and the arrows. -->
      <button
        type="button"
        class="sync"
        role="switch"
        aria-checked={viewer.sync}
        title="When on, all panes zoom and pan together"
        onclick={() => setSync(!viewer.sync)}
      >
        <span class="sw" class:on={viewer.sync}></span>
        Sync zoom and pan
      </button>
    {/if}
    <span class="rule"></span>
    <button type="button" class="txt" onclick={() => viewer.eachStage((s) => s.fit())}>Fit</button>
    <button type="button" class="txt" onclick={() => viewer.eachStage((s) => s.actual())}
      >100%</button
    >
    <IconBtn
      label="Flip horizontally"
      title="Flip horizontally (Shift+H)"
      toggle
      on={viewer.flip}
      onclick={() => (viewer.flip = !viewer.flip)}><FlipHorizontal size={16} /></IconBtn
    >
    <IconBtn
      label="Grayscale"
      title="Grayscale (Ctrl+Alt+G)"
      toggle
      on={viewer.gray}
      onclick={() => (viewer.gray = !viewer.gray)}><Contrast size={16} /></IconBtn
    >
    <IconBtn
      label="Rotate 90 degrees"
      title="Rotate the view (Shift+R)"
      on={viewer.rotate !== 0}
      onclick={() => viewer.turn()}><RotateCw size={16} /></IconBtn
    >
    <IconBtn label="Background" title="Change the background" onclick={() => viewer.cycleBg()}>
      {#if viewer.bg === 'dark'}<Moon size={16} />{:else if viewer.bg === 'checker'}<Grid3x3
          size={16}
        />{:else}<Sun size={16} />{/if}
    </IconBtn>
  </header>

  <div class="body">
    {#if panes.length === 0}
      <p class="wait">Loading…</p>
    {:else if mode === 'side'}
      <div class="grid" style="grid-template-columns:repeat({cols}, minmax(0, 1fr))">
        {#each panes as it, i (it.id)}
          <section class="cell">
            <div class="lab" title={it.name}>
              <span class="n">{it.name}</span>
              <span class="m">{facts(it)}</span>
            </div>
            <div class="stage">{@render pane(it, i, viewer.bg, 1)}</div>
          </section>
        {/each}
      </div>
    {:else}
      <div class="stack" bind:this={splitEl}>
        <div class="layer">{@render pane(panes[0], 0, viewer.bg, 1)}</div>
        <div
          class="layer top"
          style:clip-path={mode === 'split' ? `inset(0 0 0 ${split}%)` : undefined}
        >
          {@render pane(panes[1], 1, 'none', mode === 'overlay' ? viewer.overlay : 1)}
        </div>
        {#if mode === 'split'}
          <div
            class="divider"
            style:left="{split}%"
            role="slider"
            tabindex="0"
            aria-label="Split position"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(split)}
            onpointerdown={divDown}
            onpointermove={divMove}
            onpointerup={() => (dragging = false)}
            onpointercancel={() => (dragging = false)}
            onkeydown={divKey}
          >
            <span class="grip"></span>
          </div>
        {/if}
        <div class="tag a" title={panes[0].name}>
          <b>A</b>
          {panes[0].name}<small>{facts(panes[0])}</small>
        </div>
        <div class="tag b" title={panes[1].name}>
          <b>B</b>
          {panes[1].name}<small>{facts(panes[1])}</small>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .cmp {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    animation: fade 120ms ease-out;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--toolbar-h);
    padding: 0 10px;
    border-bottom: 1px solid var(--line);
  }
  .ttl {
    margin-left: 6px;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  .sp {
    flex: 1;
  }
  .rule {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--line);
  }
  .seg {
    display: flex;
    padding: 2px;
    border-radius: 7px;
    background: var(--fld);
    border: 1px solid var(--line);
  }
  .seg button {
    height: 24px;
    padding: 0 10px;
    border-radius: 5px;
    color: var(--mu);
    font-size: 12px;
  }
  .seg button.on {
    background: var(--chip);
    color: var(--tx);
  }
  .seg button:hover:not(.on) {
    color: var(--tx);
  }
  .ov {
    display: flex;
    width: 130px;
  }
  .txt {
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius);
    color: var(--mu);
    font-size: 12.5px;
  }
  .txt:hover {
    background: var(--hov);
    color: var(--tx);
  }
  .sync {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 6px;
    border-radius: var(--radius);
    color: var(--mu);
    font-size: 12.5px;
    white-space: nowrap;
  }
  .sync:hover {
    color: var(--tx);
  }
  .sw {
    position: relative;
    width: 28px;
    height: 16px;
    border-radius: 8px;
    background: var(--chip-line);
    transition: background 120ms ease-out;
  }
  .sw::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--tx);
    transition: transform 120ms ease-out;
  }
  .sw.on {
    background: var(--bl);
  }
  .sw.on::after {
    transform: translateX(12px);
  }
  .sync:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
  .txt:focus-visible,
  .seg button:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .wait {
    display: grid;
    place-items: center;
    height: 100%;
    margin: 0;
    color: var(--fa);
  }
  .grid {
    display: grid;
    grid-auto-rows: minmax(0, 1fr);
    gap: 2px;
    width: 100%;
    height: 100%;
    background: var(--line);
  }
  .cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--thumb-bg);
  }
  .lab {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 10px;
    height: 30px;
    padding: 0 12px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
  }
  .lab .n {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    align-self: center;
  }
  .lab .m {
    flex: none;
    margin-left: auto;
    align-self: center;
    color: var(--fa);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .stage {
    flex: 1;
    min-height: 0;
  }
  .stack {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .layer {
    position: absolute;
    inset: 0;
  }
  .divider {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 24px;
    margin-left: -12px;
    display: grid;
    place-items: center;
    cursor: ew-resize;
    touch-action: none;
    outline: none;
  }
  .divider::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 11px;
    width: 2px;
    background: var(--tx);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .grip {
    position: relative;
    width: 12px;
    height: 36px;
    border-radius: 6px;
    background: var(--tx);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.6);
  }
  .divider:focus-visible .grip {
    outline: 2px solid var(--bl);
    outline-offset: 2px;
  }
  .tag {
    position: absolute;
    top: 10px;
    max-width: 44%;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 6px;
    background: rgba(20, 21, 24, 0.78);
    color: var(--tx);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .tag.a {
    left: 10px;
  }
  .tag.b {
    right: 10px;
  }
  .tag small {
    color: var(--mu);
    font-size: 11px;
  }
</style>
