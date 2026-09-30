<script lang="ts">
  // The thumbnail grid: one scroll container, layout math in layout.ts, and only the tiles near
  // the viewport in the DOM. Selection, keyboard, hover previews and the empty states live here;
  // the rubber band and drag and drop in their own modules, what happens to items in actions.ts.
  import { onMount, untrack } from 'svelte';
  import { on } from '../../lib/api';
  import { focus } from '../../lib/commands.svelte';
  import { canPlayVideo, fileKind } from '../../lib/fileKinds';
  import { setThumbSize } from '../../lib/prefs';
  import { items } from '../../lib/stores/items.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { ItemBrief } from '../../../shared/types';
  import * as act from './actions';
  import { registerGridCommands, type Move } from './commands';
  import EmptyState from './EmptyState.svelte';
  import { GridDrop } from './drop.svelte';
  import {
    captionHeight,
    computeLayout,
    moveVertical,
    movePage,
    tallScroll,
    toContent,
    toScrollTop,
    visibleRange,
    type Layout,
    type TallScroll,
  } from './layout';
  import ListHeader from './ListHeader.svelte';
  import ListRow from './ListRow.svelte';
  import { openTileMenu } from './menu';
  import { RubberBand } from './rubberBand.svelte';
  import SelectionBar from './SelectionBar.svelte';
  import Subfolders from './Subfolders.svelte';
  import Tile from './Tile.svelte';

  const LIST_HEAD = 30; // sticky column header height in the list layout
  // List columns by width: all of them, then without tags, then also without rating and
  // dimensions. Each set fits its width (the widest needs about 690 px), so nothing is cut off.
  const LIST_COLS = [
    '44px minmax(90px, 1fr) 48px 96px 72px 84px minmax(50px, 150px) 118px',
    '44px minmax(90px, 1fr) 48px 96px 72px 84px 118px',
    '44px minmax(90px, 1fr) 48px 72px 118px',
  ];
  const EMPTY_IDS: string[] = [];
  const NO_ASPECTS: number[] = [];

  let root = $state<HTMLDivElement>();
  let scroller = $state<HTMLDivElement>();
  let spacer = $state<HTMLDivElement>();
  let width = $state(0);
  let viewH = $state(0);
  let scrollTop = $state(0);
  let stripH = $state(0);

  const kind = $derived(view.layout);
  const isList = $derived(kind === 'list');
  const listLevel = $derived(width >= 700 ? 0 : width >= 640 ? 1 : 2);
  const ids = $derived(view.result?.ids ?? EMPTY_IDS);
  const folderChildren = $derived(
    view.scope.kind === 'folder' ? (library.folder(view.scope.id)?.node.children ?? []) : [],
  );
  const hasStrip = $derived(folderChildren.length > 0);
  const empty = $derived(!library.state || ids.length === 0);
  /** Distance from the top of the scroller to the first tile row. */
  const origin = $derived((hasStrip ? stripH : 0) + (isList ? LIST_HEAD : 0));

  const layout = $derived.by(() =>
    computeLayout(width > 0 && view.result ? view.result.aspects : NO_ASPECTS, {
      kind,
      width,
      thumbSize: view.thumbSize,
      captionH: captionHeight(view.showNames, view.showMeta),
      gap: 12,
      rowGap: isList ? 0 : 16,
      padX: isList ? 0 : 18,
      padTop: isList ? 0 : 14,
      padBottom: isList ? 16 : 64, // room for the selection bar
      listRowH: 44,
    }),
  );

  // A layout taller than Chromium allows gets a shorter spacer and a scaled scroll (layout.ts).
  const scale = $derived(tallScroll(layout.total, origin, viewH));
  /** Content position at the top of the view: scrollTop, unless the layout is scaled. */
  const viewTop = $derived(toContent(scale, scrollTop));
  /** How far tiles sit above their layout position in the spacer (0 unless scaled). Whole px, so
   * tiles never land between pixels. */
  const shift = $derived(Math.round(viewTop - scrollTop));

  // The DOM window: everything within one screen above and below the viewport.
  const range = $derived(
    visibleRange(layout, viewTop - origin - viewH, viewTop - origin + 2 * viewH),
  );
  const lo = $derived(range.lo);
  const hi = $derived(range.hi);
  const windowIdx = $derived.by(() => {
    const out: number[] = [];
    for (let i = lo; i < hi; i++) out.push(i);
    return out;
  });

  $effect(() => {
    const a = lo;
    const b = hi;
    items.ensure(ids.slice(a, b));
  });

  // The list layout also shows tags and date added, which only the full record has.
  let fullTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!isList) return;
    void items.version;
    const win = ids.slice(lo, hi);
    clearTimeout(fullTimer);
    fullTimer = setTimeout(() => void items.loadFulls(win).catch(() => {}), 120);
    return () => clearTimeout(fullTimer);
  });

  // ── Keep the scroll position when the layout changes ──
  // Zooming, resizing or a refreshed result should not throw you somewhere else: anchor on the
  // primary selected item if it is on screen, else on the first visible tiles. A new scope,
  // filter or sort starts at the top instead.
  let prev: { layout: Layout; ids: string[]; origin: number; scale: TallScroll } | null = null;
  let pendingScroll: number | null = null;
  let lastSig = '';
  let freshView = false;

  $effect.pre(() => {
    const sig = JSON.stringify([view.scope, view.filter, view.sort]);
    untrack(() => {
      if (sig !== lastSig) {
        lastSig = sig;
        freshView = true;
      }
    });
  });

  $effect.pre(() => {
    const L = layout;
    const idsNow = ids;
    const originNow = origin;
    const sc = scale;
    untrack(() => {
      const old = prev;
      prev = { layout: L, ids: idsNow, origin: originNow, scale: sc };
      if (!old || old.layout === L || !scroller) return;
      pendingScroll = anchoredScroll(old, L, idsNow, originNow, sc);
      if (pendingScroll !== null) scrollTop = pendingScroll;
    });
  });

  // After the DOM has the new content height, apply the scroll.
  $effect(() => {
    void layout;
    if (pendingScroll !== null && scroller) {
      scroller.scrollTop = pendingScroll;
      pendingScroll = null;
    }
  });

  function anchoredScroll(
    old: NonNullable<typeof prev>,
    L: Layout,
    idsNow: string[],
    originNow: number,
    sc: TallScroll,
  ): number | null {
    if (freshView && old.ids !== idsNow) {
      freshView = false;
      return 0;
    }
    const st = scroller!.scrollTop;
    if (st === 0) return null;
    const O = old.layout;
    const top = toContent(old.scale, st) - old.origin;
    const cands: number[] = [];
    const p = selection.primary ? old.ids.indexOf(selection.primary) : -1;
    if (p >= 0 && O.y[p] + O.h[p] + O.captionH > top && O.y[p] < top + viewH) cands.push(p);
    const { lo: a, hi: b } = visibleRange(O, top, top + viewH);
    for (let i = a; i < b && cands.length < 6; i++)
      if (O.y[i] + O.h[i] + O.captionH > top) cands.push(i);
    for (const i of cands) {
      const ni = old.ids === idsNow ? i : idsNow.indexOf(old.ids[i]);
      if (ni >= 0) return toScrollTop(sc, Math.max(0, originNow + L.y[ni] - (O.y[i] - top)));
    }
    // Nothing we were looking at is in the new list.
    return cands.length ? 0 : null;
  }

  function onScroll() {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    endHover();
  }

  // ── Selection by mouse ──
  let newIds = $state.raw(new Set<string>());

  function tileId(t: EventTarget | null): string | null {
    return (t as Element | null)?.closest?.('[data-id]')?.getAttribute('data-id') ?? null;
  }

  function onClick(e: MouseEvent) {
    const id = tileId(e.target);
    if (!id) return;
    focus.region = 'grid';
    if (e.shiftKey) selection.select(id, 'range', ids);
    else if (e.ctrlKey || e.metaKey) selection.select(id, 'toggle');
    else selection.select(id, 'replace');
    if (newIds.has(id)) {
      const next = new Set(newIds);
      next.delete(id);
      newIds = next; // seen it: the orange dot has done its job
    }
  }

  function onDblClick(e: MouseEvent) {
    const id = tileId(e.target);
    if (id) act.activate(id, e.ctrlKey || e.metaKey);
  }

  function onContextMenu(e: MouseEvent) {
    const id = tileId(e.target);
    if (id) openTileMenu(e, id);
    else e.preventDefault();
  }

  // ── Rubber band and drag and drop (rubberBand.svelte.ts, drop.svelte.ts) ──
  const parts = {
    scroller: () => scroller,
    spacer: () => spacer,
    shift: () => shift,
    layout: () => layout,
    ids: () => ids,
    hasSubfolders: () => folderChildren.length > 0,
  };
  const band = new RubberBand(parts);
  const dnd = new GridDrop(parts);

  function onPointerMove(e: PointerEvent) {
    // Pointer events only come back once a drag is over: clear a highlight a drag left behind.
    dnd.clear();
    band.move(e);
  }

  function onDragStart(e: DragEvent) {
    const id = tileId(e.target);
    if (!id) return;
    endHover();
    dnd.start(e, id);
  }

  // ── Keyboard movement (the shortcuts themselves are registered in commands.ts) ──
  function firstVisibleIndex(): number {
    const top = toContent(scale, scroller?.scrollTop ?? 0) - origin;
    const { lo: a, hi: b } = visibleRange(layout, top, top + viewH);
    for (let i = a; i < b; i++) if (layout.y[i] + layout.h[i] + layout.captionH > top) return i;
    return Math.min(a, Math.max(0, ids.length - 1));
  }

  function reveal(i: number) {
    const el = scroller;
    if (!el) return;
    const head = isList ? LIST_HEAD : 0;
    const y = origin + layout.y[i];
    const tileH = layout.h[i] + layout.captionH;
    const bottomRoom = selection.count >= 2 ? 72 : 12; // keep clear of the selection bar
    const top = toContent(scale, el.scrollTop);
    // Rounded outwards: in a scaled layout one scrolled px is more than one layout px.
    if (y - 12 < top + head)
      el.scrollTop = Math.floor(toScrollTop(scale, Math.max(0, y - 12 - head)));
    else if (y + tileH + bottomRoom > top + viewH)
      el.scrollTop = Math.ceil(toScrollTop(scale, y + tileH + bottomRoom - viewH));
  }

  function move(dir: Move, extend: boolean) {
    const n = ids.length;
    if (!n) return;
    const cur = selection.primary ? ids.indexOf(selection.primary) : -1;
    let next: number;
    if (cur < 0) next = firstVisibleIndex();
    else if (dir === 'left') next = Math.max(0, cur - 1);
    else if (dir === 'right') next = Math.min(n - 1, cur + 1);
    else if (dir === 'up') next = moveVertical(layout, cur, -1);
    else if (dir === 'down') next = moveVertical(layout, cur, 1);
    else if (dir === 'home') next = 0;
    else if (dir === 'end') next = n - 1;
    else next = movePage(layout, cur, dir === 'pageUp' ? -1 : 1, viewH);
    if (extend && selection.anchor) selection.select(ids[next], 'range', ids);
    else selection.select(ids[next], 'replace');
    reveal(next);
  }

  // A link asked to show an item: select it and scroll to it once it's in the result.
  $effect(() => {
    const id = ui.revealId;
    const i = id ? ids.indexOf(id) : -1;
    if (i < 0 || !scroller) return;
    untrack(() => {
      ui.revealId = null;
      selection.select(id!, 'replace');
      reveal(i);
    });
  });

  function selectAll() {
    if (ids.length) selection.setMany(ids, selection.primary ?? ids[0]);
  }

  function reshuffle() {
    // Assign directly: view.setScope would push every shuffle onto the back button history.
    view.scope = { kind: 'random', seed: Math.floor(Math.random() * 2 ** 31) };
    view.run(0);
  }

  // ── Thumbnail zoom with Ctrl+wheel (pinch on a trackpad sends the same) ──
  // Small wheel steps add up in thumbFloat so a slow pinch still zooms.
  let thumbFloat = 0;
  function zoom(deltaY: number) {
    if (Math.abs(thumbFloat - view.thumbSize) > 1) thumbFloat = view.thumbSize;
    thumbFloat = Math.min(
      400,
      Math.max(80, thumbFloat - Math.max(-20, Math.min(20, deltaY * 0.15))),
    );
    setThumbSize(thumbFloat);
  }

  $effect(() => {
    const el = scroller;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); // otherwise the browser zooms the whole page
      if (!isList) zoom(e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ── Hover preview: videos scrub with the mouse, GIFs play. One at a time. ──
  let hover = $state<{ id: string; kind: 'video' | 'gif' | 'audio'; src: string } | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverId: string | null = null;

  function endHover() {
    clearTimeout(hoverTimer);
    hoverId = null;
    if (hover) hover = null;
  }

  function onPointerOver(e: PointerEvent) {
    const id = tileId(e.target);
    if (id === hoverId) return;
    endHover();
    if (!id || band.active) return;
    hoverId = id;
    const b = items.brief(id);
    if (!b) return;
    const kind = hoverKind(b);
    if (!kind) return;
    hoverTimer = setTimeout(async () => {
      const full = await items.loadFull(id).catch(() => null);
      if (hoverId === id && full) hover = { id, kind, src: full.fileUrl };
    }, 300);
  }

  /** GIFs and animated WebP/AVIF play, videos scrub with the mouse, audio plays (as in Eagle). */
  function hoverKind(b: ItemBrief): 'video' | 'gif' | 'audio' | null {
    const ext = b.ext.toLowerCase();
    if (ext === 'gif' || (b.animated && ['webp', 'avif', 'png', 'apng'].includes(ext)))
      return 'gif';
    const k = fileKind(ext);
    if (k === 'video' && canPlayVideo(ext)) return 'video';
    if (k === 'audio') return 'audio';
    return null;
  }

  onMount(() => {
    const offs = [
      registerGridCommands({ move, selectAll, reshuffle }),
      on('itemsAdded', ({ ids: added, source }) => {
        if (source === 'external') newIds = new Set([...newIds, ...added]);
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      clearTimeout(hoverTimer);
      band.stop();
    };
  });
</script>

<div
  class="grid"
  class:drop={dnd.active}
  class:gray={view.grayscale}
  class:checker={view.checker}
  bind:this={root}
  role="presentation"
  ondragover={(e) => dnd.over(e)}
  ondragleave={(e) => dnd.leave(e, root)}
  ondrop={(e) => dnd.drop(e)}
  ondragend={() => dnd.clear()}
>
  <!-- Keys are handled by the global command registry (commands.ts), not on this element. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="scroller"
    bind:this={scroller}
    bind:clientWidth={width}
    bind:clientHeight={viewH}
    tabindex="0"
    role="listbox"
    aria-label="Items"
    aria-multiselectable="true"
    class:l1={listLevel === 1}
    class:l2={listLevel === 2}
    style="--list-cols: {LIST_COLS[listLevel]}"
    onscroll={onScroll}
    onclick={onClick}
    ondblclick={onDblClick}
    oncontextmenu={onContextMenu}
    onpointerdown={(e) => band.down(e)}
    onpointermove={onPointerMove}
    onpointerup={(e) => band.up(e)}
    onpointercancel={(e) => band.up(e)}
    onpointerover={onPointerOver}
    onpointerleave={endHover}
    ondragstart={onDragStart}
    onfocusin={() => (focus.region = 'grid')}
  >
    {#if hasStrip}
      <div bind:offsetHeight={stripH}><Subfolders folders={folderChildren} /></div>
    {/if}
    {#if isList && !empty}<ListHeader />{/if}
    {#if empty}
      <EmptyState />
    {:else}
      <div
        class="spacer"
        class:tall={scale.k > 1}
        bind:this={spacer}
        style="height: {scale.spacerH}px"
      >
        {#each windowIdx as i (ids[i])}
          {#if isList}
            <ListRow
              id={ids[i]}
              x={layout.x[i]}
              y={layout.y[i] - shift}
              w={layout.w[i]}
              h={layout.h[i]}
              isNew={newIds.has(ids[i])}
            />
          {:else}
            <Tile
              id={ids[i]}
              x={layout.x[i]}
              y={layout.y[i] - shift}
              w={layout.w[i]}
              h={layout.h[i]}
              {kind}
              showNames={view.showNames}
              showMeta={view.showMeta}
              isNew={newIds.has(ids[i])}
              hover={hover?.id === ids[i] ? hover : null}
            />
          {/if}
        {/each}
        {#if band.rect}<div
            class="band"
            style="left: {band.rect.x}px; top: {band.rect.y - shift}px; width: {band.rect
              .w}px; height: {band.rect.h}px"
          ></div>{/if}
        {#if dnd.bar}<div
            class="dropbar"
            style="left: {dnd.bar.bar.x}px; top: {dnd.bar.bar.y - shift}px; width: {dnd.bar.bar
              .w}px; height: {dnd.bar.bar.h}px"
          ></div>{/if}
      </div>
    {/if}
  </div>
  {#if view.error && !empty}<div class="err" role="alert">Could not refresh: {view.error}</div>{/if}
  {#if selection.count >= 2}<SelectionBar />{/if}
</div>

<style>
  .grid {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }
  .scroller {
    position: absolute;
    inset: 0;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-gutter: stable; /* the width must not change when the scrollbar appears */
    outline: none;
    user-select: none;
    display: flex;
    flex-direction: column;
  }
  .scroller > :global(*) {
    flex: none;
  }
  .scroller.l1 :global(.c-tags),
  .scroller.l2 :global(.c-tags),
  .scroller.l2 :global(.c-rate),
  .scroller.l2 :global(.c-dim) {
    display: none;
  }
  .scroller > :global(.empty) {
    flex: 1 0 auto; /* fill what is left under the subfolder strip and center the message */
  }
  .spacer {
    position: relative;
    width: 100%;
  }
  /* Scaled: the window's overscan rows can land past the shortened spacer; they must not
     lengthen the scroll range. Nothing on screen is ever outside it. */
  .spacer.tall {
    overflow: clip;
  }
  .band {
    position: absolute;
    z-index: 1;
    pointer-events: none;
    background: var(--bls);
    border: 1px solid var(--bl);
    border-radius: 2px;
  }
  .dropbar {
    position: absolute;
    z-index: 1;
    pointer-events: none;
    border-radius: 2px;
    background: var(--bl);
    box-shadow: 0 0 0 1px var(--bg);
  }
  .grid.gray .spacer,
  .grid.gray :global(.subfolders) {
    filter: grayscale(1);
  }
  .grid.drop::after {
    content: '';
    position: absolute;
    inset: 6px;
    z-index: 4;
    border: 2px dashed var(--bl);
    border-radius: 10px;
    background: var(--bls);
    pointer-events: none;
  }
  .err {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    padding: 6px 12px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--err);
    color: var(--tx);
    font-size: 12px;
  }
</style>
