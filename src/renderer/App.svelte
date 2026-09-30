<script lang="ts">
  // App shell: layout regions + startup. Owned by the orchestrator. Each region component is
  // owned by one UI agent (see PLAN.md). Keep this file thin.
  import { onMount, untrack } from 'svelte';
  import { api, on } from './lib/api';
  import { revealThing } from './lib/reveal';
  import { library } from './lib/stores/library.svelte';
  import { view } from './lib/stores/view.svelte';
  import { items } from './lib/stores/items.svelte';
  import { selection } from './lib/stores/selection.svelte';
  import { ui } from './lib/stores/ui.svelte';
  import { triage } from './lib/stores/triage.svelte';
  import { installKeyHandler } from './lib/commands.svelte';
  import { registerAppCommands } from './lib/appCommands';
  import Sidebar from './components/sidebar/Sidebar.svelte';
  import Toolbar from './components/toolbar/Toolbar.svelte';
  import FilterBar from './components/filters/FilterBar.svelte';
  import Grid from './components/grid/Grid.svelte';
  import Inspector from './components/inspector/Inspector.svelte';
  import StatusStrip from './components/status/StatusStrip.svelte';
  import Banner from './components/status/Banner.svelte';
  import Toasts from './components/status/Toasts.svelte';
  import Viewer from './components/viewer/Viewer.svelte';
  import CommandPalette from './components/command/CommandPalette.svelte';
  import Pickers from './components/pickers/Pickers.svelte';
  import Dialogs from './components/dialogs/Dialogs.svelte';
  import ContextMenu from './lib/ui/ContextMenu.svelte';

  onMount(() => {
    const uninstall = installKeyHandler(window);
    const offCommands = registerAppCommands();
    const offReveal = on('reveal', (r) => void revealThing(r));
    view.subscribe();
    items.subscribe();
    void (async () => {
      await library.init();
      if (!library.state) ui.openDialog('libraries');
    })();
    return () => (uninstall(), offCommands(), offReveal());
  });

  // Coming back to the window: check the library for outside changes (the partner's Eagle, Dropbox).
  // Cheap in the core, and at most once every 5 s.
  let lastRefresh = 0;
  function onWindowFocus() {
    if (!library.state || Date.now() - lastRefresh < 5000) return;
    lastRefresh = Date.now();
    void api.refresh().catch(() => {});
  }

  // Whatever a full-window mode covers is inert: no click, Tab or hidden field behind Triage or the
  // viewer can take focus. The detail view leaves the inspector and the status strip usable.
  const covered = $derived(!!triage.session || !!ui.viewer);
  const allCovered = $derived(!!triage.session || (!!ui.viewer && ui.viewer.mode !== 'detail'));

  // Keep the selection valid when the result changes (no 85k-entry Set when nothing is selected).
  $effect(() => {
    const r = view.result;
    if (r && untrack(() => selection.count)) selection.retain(new Set(r.ids));
  });
</script>

<svelte:window onfocus={onWindowFocus} />

<div class="shell" class:no-side={!ui.sidebarVisible} class:no-insp={!ui.inspectorVisible}>
  {#if ui.sidebarVisible}<aside class="side" inert={covered}><Sidebar /></aside>{/if}
  <main class="main" inert={covered}>
    <Toolbar />
    <Banner />
    <FilterBar />
    <div class="gridwrap"><Grid /></div>
  </main>
  {#if ui.inspectorVisible}<aside class="insp" inert={allCovered}><Inspector /></aside>{/if}
  <footer class="strip" inert={allCovered}><StatusStrip /></footer>
</div>

<Viewer />
{#await import('./components/triage/Triage.svelte') then { default: Triage }}<Triage />{/await}
<CommandPalette />
<Pickers />
<Dialogs />
<Toasts />
<ContextMenu />

<style>
  .shell {
    display: grid;
    height: 100vh;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--inspector-w);
    grid-template-rows: minmax(0, 1fr) var(--strip-h);
    grid-template-areas: 'side main insp' 'strip strip strip';
  }
  .shell.no-side {
    grid-template-columns: 0 minmax(0, 1fr) var(--inspector-w);
  }
  .shell.no-insp {
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr) 0;
  }
  .shell.no-side.no-insp {
    grid-template-columns: 0 minmax(0, 1fr) 0;
  }
  .side {
    grid-area: side;
    background: var(--side);
    border-right: 1px solid var(--line);
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .main {
    grid-area: main;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .gridwrap {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .insp {
    grid-area: insp;
    background: var(--side);
    border-left: 1px solid var(--line);
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .strip {
    grid-area: strip;
    background: var(--strip);
    border-top: 1px solid var(--line);
    min-width: 0;
  }
</style>
