<script lang="ts">
  // Detail view: a fixed overlay over the window, except the inspector column (App keeps drawing
  // the inspector there and it follows the selection, which Viewer.svelte keeps on this item) and
  // the status strip along the bottom, which stays whole under both.
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Contrast from '@lucide/svelte/icons/contrast';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal';
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
  import Moon from '@lucide/svelte/icons/moon';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Sun from '@lucide/svelte/icons/sun';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import { openMenuBelow } from '../../lib/contextMenu.svelte';
  import { items } from '../../lib/stores/items.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { openDefault } from '../../lib/files';
  import { openReferenceHere } from './actions';
  import { closeViewer } from './commands';
  import { openItemMenu } from './menu';
  import IconBtn from './IconBtn.svelte';
  import ItemView from './ItemView.svelte';
  import { viewKind } from '../../lib/fileKinds';
  import { currentId, step } from './nav';
  import { viewer } from './state.svelte';
  import { useItem } from './useItem.svelte';

  const id = $derived(currentId());
  const cur = useItem(() => id);
  const item = $derived(cur.value);
  const name = $derived(item?.name ?? (id ? items.brief(id)?.name : '') ?? '');
  // Fonts and audio have no picture to zoom, flip or gray; their buttons would do nothing.
  const stageless = $derived(!!item && ['font', 'audio'].includes(viewKind(item.ext)));
  const total = $derived(ui.viewer?.ids.length ?? 0);
  const index = $derived(ui.viewer?.index ?? 0);

  const zoomLabel = $derived.by(() => {
    const pct = Math.round(viewer.zoom.scale * 100);
    return viewer.zoom.atFit && viewer.zoom.scale < 0.995 ? `Fit · ${pct}%` : `${pct}%`;
  });

  function zoomMenu(e: MouseEvent) {
    const at = (s: number) => viewer.eachStage((st) => st.toScale(s));
    const cur = viewer.zoom.scale;
    const same = (s: number) => !viewer.zoom.atFit && Math.abs(cur - s) < 0.005;
    openMenuBelow(e.currentTarget as HTMLElement, [
      {
        label: 'Fit',
        keys: 'Ctrl+9',
        checked: viewer.zoom.atFit,
        run: () => viewer.eachStage((st) => st.fit()),
      },
      { separator: true },
      { label: '25%', checked: same(0.25), run: () => at(0.25) },
      { label: '50%', checked: same(0.5), run: () => at(0.5) },
      {
        label: '100%',
        keys: 'Ctrl+0',
        checked: same(1),
        run: () => viewer.eachStage((st) => st.actual()),
      },
      { label: '200%', checked: same(2), run: () => at(2) },
      { label: '400%', checked: same(4), run: () => at(4) },
    ]);
  }

  const bgTitle = $derived(
    `Background: ${viewer.bg === 'checker' ? 'checkerboard' : viewer.bg}. Click to change.`,
  );
</script>

<div
  class="detail"
  style:right={ui.inspectorVisible ? 'var(--inspector-w)' : '0'}
  role="dialog"
  aria-label="Detail view"
>
  <header class="bar">
    <IconBtn label="Back to the grid" title="Back (Esc)" onclick={() => (ui.viewer = null)}
      ><ArrowLeft size={17} /></IconBtn
    >
    <div class="title">
      <span class="name" title={name}>{name}</span>
      <span class="idx">{index + 1} / {total.toLocaleString()}</span>
    </div>
    <span class="sp"></span>
    <button
      type="button"
      class="zoom"
      title="Zoom (Ctrl+= and Ctrl+-, wheel). Fit: Ctrl+9, 100%: Ctrl+0"
      disabled={stageless}
      onclick={zoomMenu}>{stageless ? '' : zoomLabel}</button
    >
    <IconBtn
      label="Flip horizontally"
      title="Flip horizontally (Shift+H)"
      toggle
      disabled={stageless}
      on={viewer.flip}
      onclick={() => (viewer.flip = !viewer.flip)}><FlipHorizontal size={16} /></IconBtn
    >
    <IconBtn
      label="Grayscale"
      title="Grayscale (Ctrl+Alt+G)"
      toggle
      disabled={stageless}
      on={viewer.gray}
      onclick={() => (viewer.gray = !viewer.gray)}><Contrast size={16} /></IconBtn
    >
    <IconBtn
      label="Rotate 90 degrees"
      title="Rotate the view (Shift+R)"
      disabled={stageless}
      on={viewer.rotate !== 0}
      onclick={() => viewer.turn()}><RotateCw size={16} /></IconBtn
    >
    <IconBtn
      label="Background"
      title={bgTitle}
      disabled={stageless}
      onclick={() => viewer.cycleBg()}
    >
      {#if viewer.bg === 'dark'}<Moon size={16} />{:else if viewer.bg === 'checker'}<Grid3x3
          size={16}
        />{:else}<Sun size={16} />{/if}
    </IconBtn>
    <span class="rule"></span>
    <IconBtn
      label="Open in reference window"
      title="Open in reference window (Ctrl+O)"
      disabled={!id}
      onclick={() => id && void openReferenceHere(id)}><SquareArrowOutUpRight size={16} /></IconBtn
    >
    <IconBtn
      label="Open with default app"
      title="Open with default app (Shift+Enter)"
      disabled={!id}
      onclick={() => id && void openDefault(id)}><ExternalLink size={16} /></IconBtn
    >
    <IconBtn
      label="Info panel"
      title="Show or hide the info panel"
      toggle
      on={ui.inspectorVisible}
      onclick={() => (ui.inspectorVisible = !ui.inspectorVisible)}><PanelRight size={16} /></IconBtn
    >
  </header>

  <!-- Double-click on the picture closes the view, as in Eagle (Ctrl+0 / Ctrl+9 and the zoom menu
       do 100% and fit). -->
  <div class="body" role="presentation" oncontextmenu={(e) => id && openItemMenu(e, id)}>
    {#key id}
      {#if item}
        <ItemView {item} variant="detail" ondblclick={closeViewer} />
      {:else if item === null}
        <p class="gone">This item isn’t available any more.</p>
      {/if}
    {/key}
    {#if index > 0}
      <button
        type="button"
        class="nav prev"
        aria-label="Previous item"
        title="Previous (Left or A)"
        onclick={() => step(-1)}><ChevronLeft size={22} /></button
      >
    {/if}
    {#if index < total - 1}
      <button
        type="button"
        class="nav next"
        aria-label="Next item"
        title="Next (Right or D)"
        onclick={() => step(1)}><ChevronRight size={22} /></button
      >
    {/if}
  </div>
</div>

<style>
  .detail {
    position: fixed;
    z-index: 60;
    top: 0;
    left: 0;
    bottom: var(--strip-h);
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
    gap: 2px;
    height: var(--toolbar-h);
    padding: 0 10px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    margin-left: 6px;
  }
  .name {
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .idx {
    flex: none;
    color: var(--fa);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  .sp {
    flex: 1;
  }
  .rule {
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: var(--line);
  }
  .zoom {
    height: 30px;
    border-radius: var(--radius);
    color: var(--mu);
  }
  .zoom {
    padding: 0 10px;
    margin-right: 4px;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .zoom:hover:not(:disabled) {
    background: var(--hov);
    color: var(--tx);
  }
  .zoom:disabled {
    opacity: 0.5;
  }
  .zoom:focus-visible,
  .nav:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .gone {
    display: grid;
    place-items: center;
    height: 100%;
    margin: 0;
    color: var(--fa);
  }
  .nav {
    position: absolute;
    top: 50%;
    width: 40px;
    height: 56px;
    margin-top: -28px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.45);
    color: var(--tx);
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .nav.prev {
    left: 12px;
  }
  .nav.next {
    right: 12px;
  }
  .body:hover .nav,
  .nav:focus-visible {
    opacity: 0.9;
  }
  .nav:hover {
    background: rgba(0, 0, 0, 0.7);
  }
</style>
