<script lang="ts">
  // One triage session on screen (mockup #4): the queue on the left, one big item in the middle,
  // clues on the right, the keys along the bottom. Covers the whole window; Esc goes back.
  import { onMount, untrack } from 'svelte';
  import Inbox from '@lucide/svelte/icons/inbox';
  import X from '@lucide/svelte/icons/x';
  import { enterMode } from '../../lib/commands.svelte';
  import { dateTime, fileSize, plural } from '../../lib/format';
  import { items } from '../../lib/stores/items.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { triage, type TriageSession } from '../../lib/stores/triage.svelte';
  import ItemView from '../viewer/ItemView.svelte';
  import { preloadAround } from '../viewer/nav';
  import { viewer } from '../viewer/state.svelte';
  import { useItem } from '../viewer/useItem.svelte';
  import { revisitSkipped } from './actions';
  import Chooser from './Chooser.svelte';
  import Clues from './Clues.svelte';
  import Keys from './Keys.svelte';
  import Queue from './Queue.svelte';
  import { queueTokens } from './queue';

  let { session: s }: { session: TriageSession } = $props();

  const KEEP = new Set([
    'app.commandBar',
    'app.shortcuts',
    'edit.undo',
    'edit.redo',
    'item.rename',
    'item.folderPicker',
  ]);

  const id = $derived(s.current);
  const cur = useItem(() => id);
  const item = $derived(cur.value);
  const brief = $derived(id ? items.brief(id) : undefined);
  const total = $derived(s.ids.length);
  const finished = $derived(s.finished);
  // "2 filed, 1 tagged, 1 skipped.": only what happened, no row of zeros.
  const summary = $derived.by(() => {
    const st = s.stats;
    const parts = [
      [st.filed, 'filed'],
      [st.tagged, 'tagged'],
      [st.trashed, 'trashed'],
      [st.skipped, 'skipped'],
      [st.done, 'kept as they were'],
    ].filter(([n]) => n) as [number, string][];
    return parts.length ? `${parts.map(([n, w]) => `${n.toLocaleString()} ${w}`).join(', ')}.` : '';
  });

  const tokens = $derived(
    queueTokens(s, (kind, fid) =>
      kind === 'folder' ? library.folder(fid)?.node.name : library.smartFolders.get(fid)?.name,
    ),
  );

  // Triage owns the keyboard: its own keys, plus the palette, the shortcut sheet, undo and the
  // item keys it means to keep (F2 rename, Ctrl+Shift+J folders), not while the chooser is up.
  // The app behind is inert (App.svelte), so nothing there can take focus either.
  let root = $state<HTMLDivElement>();
  onMount(() => {
    root?.focus(); // the keyboard starts here, not on something behind
    return enterMode(
      'triage',
      (c) => c.id.startsWith('triage.') || (KEEP.has(c.id) && !s.choosing),
    );
  });

  // Keyboard-only: once everything is sorted, the first button of the summary takes focus, so
  // Enter presses it (Enter and Space on a button press the button, not Done or Skip).
  let btns = $state<HTMLDivElement>();
  $effect(() => {
    if (finished && btns) untrack(() => btns?.querySelector('button')?.focus());
  });

  /** Said aloud by screen readers: what the last key did. */
  const said = $derived(s.steps.at(-1)?.label ?? '');

  // The selection follows the item on screen, so the app's own keys (F2 rename, Shift+D, copy
  // tags...) act on it. close() puts the old selection back. Only a new item selects: App drops
  // an item from the selection once it leaves the view (tagged in Untagged), and fighting that
  // would loop.
  $effect(() => {
    const x = id;
    untrack(() => {
      if (x && selection.primary !== x) selection.select(x);
    });
  });

  // The next items load while you look at this one. Rotation is per item, as in the viewer.
  $effect(() => {
    const i = s.index;
    untrack(() => {
      viewer.rotate = 0;
      void preloadAround(i, s.ids, 3);
    });
  });

  const facts = $derived.by(() => {
    if (!item) return '';
    return [
      item.width && item.height ? `${item.width} × ${item.height}` : '',
      item.ext.toUpperCase(),
      fileSize(item.size),
      item.importedAt ? `added ${dateTime(item.importedAt).slice(0, 10)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
  const zoomLabel = $derived(viewer.zoom.atFit ? 'Fit' : `${Math.round(viewer.zoom.scale * 100)}%`);
</script>

<div class="tri" role="dialog" aria-modal="true" aria-label="Triage" tabindex="-1" bind:this={root}>
  <div class="sr" aria-live="polite">{said}</div>
  <header class="top">
    <div class="mark"><Inbox size={16} />Triage</div>
    <div class="q" title="The queue: a snapshot of the view you started from">
      {#each tokens as t, i (i)}<span class="tok"
          >{#if t.key}<b>{t.key}</b>{/if}{t.value}</span
        >{/each}
    </div>
    <div class="stat">
      <span class="big">{(total - s.sorted).toLocaleString()}</span><small>left in this queue</small
      >
    </div>
    <div class="stat">
      <span class="big hi">{s.sorted.toLocaleString()}</span><small>sorted this session</small>
    </div>
    <button type="button" class="exit" title="Leave triage (Esc)" onclick={() => triage.close()}
      ><X size={16} /><span>Done</span></button
    >
    <div class="prog" aria-hidden="true"><i style:width="{(s.sorted / total) * 100}%"></i></div>
  </header>

  <Queue session={s} />

  <section class="stage">
    <div class="info">
      <span class="nm" title={item?.name ?? brief?.name}>{item?.name ?? brief?.name ?? ''}</span>
      <span class="facts">{facts}</span>
      {#if (item?.star ?? 0) > 0}<span class="stars" title="Rating (Shift+1 to 5, Shift+0 clears)"
          >{'★'.repeat(item!.star)}</span
        >{/if}
      <span class="sp"></span>
      <span class="pos">{(s.index + 1).toLocaleString()} of {total.toLocaleString()}</span>
      <button
        type="button"
        class="pill"
        class:on={viewer.zoom.atFit}
        title="Fit (Ctrl+9)"
        onclick={() => viewer.eachStage((st) => st.fit())}>Fit</button
      >
      <button
        type="button"
        class="pill"
        class:on={!viewer.zoom.atFit && Math.abs(viewer.zoom.scale - 1) < 0.005}
        title="Actual size (Ctrl+0)"
        onclick={() => viewer.eachStage((st) => st.actual())}
        >{viewer.zoom.atFit ? '100%' : zoomLabel}</button
      >
    </div>
    <div class="view">
      {#key id}
        {#if item}
          <ItemView {item} variant="detail" />
        {:else if item === null}
          <p class="gone">This item isn’t in the library any more. Press S to skip it.</p>
        {/if}
      {/key}
      {#if finished}
        <div class="finished">
          <h2>{s.stats.skipped ? 'End of the queue' : `All ${plural(total, 'item')} sorted`}</h2>
          <p>{summary}</p>
          <div class="btns" bind:this={btns}>
            {#if s.stats.skipped}<button type="button" class="btn" onclick={revisitSkipped}
                >Go through the skipped ones</button
              >{/if}
            <button type="button" class="btn primary" onclick={() => triage.close()}
              >Back to the library</button
            >
          </div>
        </div>
      {/if}
    </div>
  </section>

  <Clues session={s} {item} />
  <Keys session={s} {item} />
  {#if s.choosing}<Chooser session={s} />{/if}
</div>

<style>
  .tri:focus {
    outline: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tri {
    position: fixed;
    inset: 0;
    z-index: 65;
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr) 320px;
    grid-template-rows: 54px minmax(0, 1fr) auto;
    grid-template-areas: 'top top top' 'queue stage clues' 'keys keys keys';
    background: var(--bg);
    color: var(--tx);
    animation: fade 120ms ease-out;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .top {
    grid-area: top;
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 12px 0 18px;
    background: var(--side);
    border-bottom: 1px solid var(--line);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding-right: 16px;
    border-right: 1px solid var(--line);
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tx);
  }
  .mark :global(svg) {
    color: var(--bl-soft);
  }
  .q {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    overflow: hidden;
    border-radius: var(--radius);
    background: var(--fld);
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
  }
  .tok {
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--chip);
    color: var(--tx);
  }
  .tok b {
    font-weight: 400;
    color: var(--bl-soft);
  }
  .stat {
    display: flex;
    align-items: baseline;
    gap: 7px;
    white-space: nowrap;
  }
  .big {
    font-family: var(--mono);
    font-size: 20px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .big.hi {
    color: var(--bl-soft);
  }
  .stat small {
    color: var(--mu);
    font-size: 12px;
  }
  .exit {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius);
    color: var(--mu);
  }
  .exit:hover {
    background: var(--hov);
    color: var(--tx);
  }
  .prog {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
  }
  .prog i {
    display: block;
    height: 100%;
    background: var(--bl);
    transition: width 200ms ease-out;
  }
  .stage {
    grid-area: stage;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--thumb-bg);
  }
  .info {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 40px;
    padding: 0 12px 0 16px;
    font-size: 12px;
    color: var(--mu);
    white-space: nowrap;
  }
  .nm {
    min-width: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
    color: var(--tx);
  }
  .facts {
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .stars {
    color: var(--star);
    letter-spacing: 1px;
  }
  .sp {
    flex: 1;
  }
  .pos {
    font-variant-numeric: tabular-nums;
    color: var(--fa);
  }
  .pill {
    height: 24px;
    min-width: 38px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--line);
    color: var(--mu);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .pill.on {
    color: var(--tx);
    border-color: var(--chip-line);
  }
  .pill:hover {
    background: var(--hov);
  }
  .view {
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
  .finished {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    text-align: center;
  }
  .finished h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }
  .finished p {
    margin: 0 0 12px;
    color: var(--mu);
  }
  .btns {
    display: flex;
    gap: 8px;
  }
  .btn {
    height: 32px;
    padding: 0 14px;
    border-radius: var(--radius);
    background: var(--chip);
    border: 1px solid var(--chip-line);
    color: var(--tx);
  }
  .btn:hover {
    background: var(--hov);
  }
  .btn.primary {
    background: var(--bl);
    border-color: var(--bl);
  }
  .exit:focus-visible,
  .pill:focus-visible,
  .btn:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
</style>
