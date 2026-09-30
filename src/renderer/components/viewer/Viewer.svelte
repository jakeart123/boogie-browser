<script lang="ts">
  // Mounted once at the App root. Renders nothing unless `ui.viewer` is set, then one of the four
  // modes. Also owns what they share: the keys, keeping the selection on the item you are looking
  // at (the inspector follows it), warming the next pictures, and resetting view-only toggles.
  import { onMount, untrack } from 'svelte';
  import { enterMode, focus } from '../../lib/commands.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import Compare from './Compare.svelte';
  import Detail from './Detail.svelte';
  import Present from './Present.svelte';
  import QuickLook from './QuickLook.svelte';
  import { registerViewerCommands } from './commands';
  import { preloadAround } from './nav';
  import { viewer } from './state.svelte';

  onMount(() => registerViewerCommands());

  // The grid's keys stay quiet while the viewer has the keyboard.
  const open = $derived(!!ui.viewer);
  $effect(() => {
    if (!open) return;
    focus.region = 'viewer';
    return () => {
      if (focus.region === 'viewer') focus.region = 'grid';
    };
  });

  // What the viewer covers can't act on keys: the slideshow keeps only its own; the detail view,
  // quick look and compare keep the app's item keys (T, F, F2...) but not the sidebar's or the
  // filter bar's, which sit hidden behind them.
  const mode = $derived(ui.viewer?.mode);
  $effect(() => {
    if (!mode) return;
    return mode === 'present'
      ? enterMode('slideshow', (c) => c.id.startsWith('viewer.'))
      : enterMode('viewer', (c) => !c.mainWindow);
  });

  let lastId: string | undefined;
  let lastMode: string | undefined;
  $effect(() => {
    const v = ui.viewer;
    if (!v) {
      // Flip, grayscale and rotate last for one viewing only; quick look has no indicator for them.
      untrack(() => {
        lastId = lastMode = undefined;
        viewer.flip = false;
        viewer.gray = false;
        viewer.rotate = 0;
        viewer.paused = false;
      });
      return;
    }
    if (v.mode === 'compare') return;
    const id = v.ids[v.index];
    untrack(() => {
      if (!id || (id === lastId && v.mode === lastMode)) return;
      // Peeking with Space leaves a multi-selection alone (Esc goes back to it). Anything else
      // selects the item on screen, so the app's item keys (T, F, F2, Shift+D) act on it alone.
      const peek = lastId === undefined && v.mode === 'quicklook' && selection.primary === id;
      if (!peek && !(selection.count === 1 && selection.primary === id)) selection.select(id);
      if (id !== lastId) viewer.rotate = 0;
      lastId = id;
      lastMode = v.mode;
    });
    void preloadAround(v.index, v.ids);
  });
</script>

{#if ui.viewer}
  {#if ui.viewer.mode === 'detail'}
    <Detail />
  {:else if ui.viewer.mode === 'quicklook'}
    <QuickLook />
  {:else if ui.viewer.mode === 'compare'}
    <Compare />
  {:else if ui.viewer.mode === 'present'}
    <Present />
  {/if}
{/if}
