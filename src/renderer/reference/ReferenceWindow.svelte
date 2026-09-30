<script lang="ts">
  // The floating reference window: a frameless, transparent, always-on-top window with one
  // picture in it, for keeping a reference over Krita. The picture has an opacity, so the canvas
  // shows through; controls appear along the top when the mouse moves. Opened with a list (the
  // viewer's), it steps through it with Left/Right or A/D. Nothing here is written to the library.
  // (Always-on-top itself is the app's job: see src/app/windows.ts.)
  import { onMount, untrack } from 'svelte';
  import { readJSON, writeJSON } from '../lib/storage';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Contrast from '@lucide/svelte/icons/contrast';
  import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import X from '@lucide/svelte/icons/x';
  import type { Item } from '../../shared/types';
  import { api, on, windowKind } from '../lib/api';
  import { keyString } from '../lib/commands.svelte';
  import IconBtn from '../components/viewer/IconBtn.svelte';
  import ImageView from '../components/viewer/ImageView.svelte';
  import Slider from '../components/viewer/Slider.svelte';
  import { viewKind } from '../lib/fileKinds';
  import { FIT_VIEW, type StageView } from '../components/viewer/stageMath';
  import { viewer } from '../components/viewer/state.svelte';
  import { refAction, stepList } from './keys';

  const OPACITY_KEY = 'reference.opacity';
  const ids = stepList(
    windowKind.itemId,
    'itemIds' in windowKind ? windowKind.itemIds : undefined,
    location.search,
  );

  function savedOpacity(): number {
    const v = readJSON<unknown>(OPACITY_KEY, 1);
    return typeof v === 'number' && v >= 0.1 && v <= 1 ? v : 1;
  }

  let index = $state(Math.max(0, ids.indexOf(windowKind.itemId ?? '')));
  const id = $derived(ids[index] as string | undefined);
  let item = $state<Item | null | undefined>(undefined);
  let opacity = $state(savedOpacity());
  let flip = $state(false);
  let gray = $state(false);
  let rotate = $state(0);
  let view = $state<StageView>(FIT_VIEW);
  let error = $state('');

  function setOpacity(v: number) {
    opacity = Math.min(1, Math.max(0.1, Math.round(v * 100) / 100));
    writeJSON(OPACITY_KEY, opacity);
  }

  // The picture on screen stays until the next one has arrived, so stepping never flashes empty.
  let seq = 0;
  async function load(want: string | undefined) {
    const mine = ++seq;
    if (!want) return void (item = null);
    try {
      const got = await api.getItem(want);
      if (mine !== seq) return;
      item = got;
      error = '';
    } catch (e) {
      if (mine !== seq) return;
      error = e instanceof Error ? e.message : String(e);
      item = null;
    }
  }

  // Neighbours load ahead so stepping feels instant; kept referenced so the browser keeps them.
  let warm: HTMLImageElement[] = [];
  async function preload(at: number) {
    const near = [ids[at + 1], ids[at - 1]].filter((x): x is string => !!x);
    if (!near.length) return;
    const list = await api.getItems(near).catch(() => [] as Item[]);
    warm = list
      .filter((it) => viewKind(it.ext) === 'image')
      .map((it) => {
        const img = new Image();
        img.decoding = 'async';
        img.src = it.previewUrl;
        return img;
      });
  }

  $effect(() => {
    const want = id;
    const at = index;
    untrack(() => {
      rotate = 0; // like the detail view: rotation is per picture, flip and gray stay
      view = FIT_VIEW;
      void load(want);
      void preload(at);
    });
  });

  function stepTo(i: number) {
    const next = Math.min(ids.length - 1, Math.max(0, i));
    if (next !== index) index = next;
  }

  function close() {
    try {
      void Promise.resolve(api.windowControl('close')).catch(() => window.close());
    } catch {
      window.close();
    }
  }

  // Controls show while the mouse moves or rests on them, then fade. The top strip is a window
  // drag area in Electron, which swallows mouse events, so "recently moved" is what keeps it up.
  let awake = $state(false);
  let overControls = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function wake() {
    awake = true;
    clearTimeout(timer);
    timer = setTimeout(() => (awake = false), 2200);
  }
  const showControls = $derived(awake || overControls);

  const zoomLabel = $derived(viewer.zoom.atFit ? 'Fit' : `${Math.round(viewer.zoom.scale * 100)}%`);

  function onkey(e: KeyboardEvent) {
    const a = refAction(keyString(e));
    if (!a) return;
    e.preventDefault();
    // A held key keeps zooming or stepping; toggles (flip, gray, rotate) act once per press.
    if (e.repeat && !['zoomIn', 'zoomOut', 'prev', 'next'].includes(a as string)) return;
    const each = (fn: Parameters<typeof viewer.eachStage>[0]) => viewer.eachStage(fn);
    if (typeof a === 'object') setOpacity(a.opacity);
    else if (a === 'close') return close();
    else if (a === 'zoomIn') each((s) => s.zoomBy(1.25));
    else if (a === 'zoomOut') each((s) => s.zoomBy(0.8));
    else if (a === 'actual') each((s) => s.actual());
    else if (a === 'fit') each((s) => s.fit());
    else if (a === 'flip') flip = !flip;
    else if (a === 'gray') gray = !gray;
    else if (a === 'rotate') rotate = (rotate + 90) % 360;
    else if (a === 'prev') stepTo(index - 1);
    else if (a === 'next') stepTo(index + 1);
    else if (a === 'first') stepTo(0);
    else if (a === 'last') stepTo(ids.length - 1);
    // Stepping keeps the controls quiet (they'd cover the top of every picture); other keys show them.
    if (a !== 'prev' && a !== 'next' && a !== 'first' && a !== 'last') wake();
  }

  onMount(() => {
    const off = on(
      'itemsChanged',
      ({ ids: changed }) => id && changed.includes(id) && void load(id),
    );
    return () => {
      off();
      clearTimeout(timer);
    };
  });
</script>

<!-- mouseout with no relatedTarget means the pointer left the window -->
<svelte:window
  onkeydown={onkey}
  onpointermove={wake}
  onmouseout={(e) => !e.relatedTarget && ((awake = false), clearTimeout(timer))}
/>

<div class="ref" role="presentation">
  {#if item}
    {#key item.id}
      <ImageView
        {item}
        bind:view
        {flip}
        {gray}
        {rotate}
        bg="none"
        {opacity}
        register
        dragOut
        thumbOnly={viewKind(item.ext) !== 'image'}
      />
    {/key}
  {:else if item === null}
    <p class="msg">{error || 'This item isn’t in the library any more.'}</p>
  {/if}
  <!-- Trashed since the list was made: still shown (it's a reference), but never passed off as normal. -->
  {#if item?.isDeleted}<span class="trashed">In the trash</span>{/if}

  <div class="strip" class:show={showControls}>
    <div class="grab" title={item?.name ?? ''}>
      <span class="name">{item?.name ?? ''}</span>
    </div>
    {#if ids.length > 1}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="steps"
        onpointerenter={() => (overControls = true)}
        onpointerleave={() => (overControls = false)}
      >
        <IconBtn label="Previous" title="Previous (Left or A)" onclick={() => stepTo(index - 1)}
          ><ChevronLeft size={16} /></IconBtn
        >
        <span class="pos">{index + 1} / {ids.length.toLocaleString()}</span>
        <IconBtn label="Next" title="Next (Right or D)" onclick={() => stepTo(index + 1)}
          ><ChevronRight size={16} /></IconBtn
        >
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="controls"
      onpointerenter={() => (overControls = true)}
      onpointerleave={() => (overControls = false)}
    >
      <span class="op" title="Opacity (keys 1 to 9, 0 for 100%)">
        <Slider
          label="Opacity"
          min={0.1}
          max={1}
          value={opacity}
          tip={(v) => `${Math.round(v * 100)}%`}
          onchange={setOpacity}
        />
      </span>
      <span class="pct">{Math.round(opacity * 100)}%</span>
      <IconBtn
        label="Flip horizontally"
        title="Flip (Shift+H or H)"
        toggle
        on={flip}
        onclick={() => (flip = !flip)}><FlipHorizontal size={15} /></IconBtn
      >
      <IconBtn
        label="Grayscale"
        title="Grayscale (Ctrl+Alt+G or G)"
        toggle
        on={gray}
        onclick={() => (gray = !gray)}><Contrast size={15} /></IconBtn
      >
      <IconBtn
        label="Rotate 90 degrees"
        title="Rotate (Shift+R or R)"
        on={rotate !== 0}
        onclick={() => (rotate = (rotate + 90) % 360)}><RotateCw size={15} /></IconBtn
      >
      <IconBtn
        label="Zoom out"
        title="Zoom out (Ctrl+-)"
        onclick={() => viewer.eachStage((s) => s.zoomBy(0.8))}><Minus size={15} /></IconBtn
      >
      <button
        type="button"
        class="zoom"
        title="Back to fit (Ctrl+9)"
        onclick={() => viewer.eachStage((s) => s.fit())}>{zoomLabel}</button
      >
      <IconBtn
        label="Zoom in"
        title="Zoom in (Ctrl+=)"
        onclick={() => viewer.eachStage((s) => s.zoomBy(1.25))}><Plus size={15} /></IconBtn
      >
      <IconBtn label="Close" title="Close (Esc)" onclick={close}><X size={16} /></IconBtn>
    </div>
  </div>
</div>

<style>
  /* The window is transparent: the page must be too, or the opacity slider would show a gray sheet.
     tokens.css asks for a dark color scheme, whose default page color is an opaque dark canvas that
     could show through, so this page opts out of it. */
  :global(:root) {
    color-scheme: normal;
  }
  :global(html),
  :global(body) {
    background: transparent !important;
  }
  .ref {
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
  .msg {
    display: grid;
    place-items: center;
    height: 100%;
    margin: 0;
    padding: 20px;
    text-align: center;
    color: var(--tx);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  }
  .strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    min-height: 38px;
    display: flex;
    /* A small reference window wraps the controls onto more rows instead of pushing Close off screen. */
    flex-wrap: wrap;
    align-items: center;
    background: rgba(24, 25, 28, 0.88);
    border-bottom: 1px solid var(--line);
    opacity: 0;
    transition: opacity 120ms ease-out;
    /* While hidden it must not eat clicks or start window drags. */
    pointer-events: none;
    -webkit-app-region: no-drag;
  }
  .strip.show {
    opacity: 1;
    pointer-events: auto;
    -webkit-app-region: drag;
  }
  .grab {
    flex: 1 1 120px;
    min-width: 0;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 12px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--mu);
    font-size: 12px;
  }
  .steps {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    -webkit-app-region: no-drag;
  }
  .trashed {
    position: absolute;
    left: 10px;
    bottom: 10px;
    padding: 3px 8px;
    border-radius: var(--radius);
    background: var(--panel);
    border: 1px solid var(--panel-line);
    color: var(--warn);
    font-size: 11.5px;
    pointer-events: none;
  }
  .pos {
    min-width: 44px;
    color: var(--mu);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .controls {
    flex: 0 1 auto;
    max-width: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding: 0 6px;
    margin-left: auto;
    -webkit-app-region: no-drag;
  }
  .op {
    display: flex;
    width: 96px;
    margin-right: 4px;
  }
  .pct {
    width: 34px;
    margin-right: 6px;
    color: var(--mu);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .zoom {
    min-width: 42px;
    height: 30px;
    padding: 0 6px;
    border-radius: var(--radius);
    color: var(--mu);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .zoom:hover {
    background: var(--hov);
    color: var(--tx);
  }
</style>
