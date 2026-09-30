<script lang="ts">
  // The right column: Details (one item, several, or the current folder) and History tabs.
  // The tabs stay put; the panel under them scrolls. Owned by ui-inspector.
  import { onMount } from 'svelte';
  import Lock from '@lucide/svelte/icons/lock';
  import { focus, registerCommands } from '../../lib/commands.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import DetailsTab from './DetailsTab.svelte';
  import HistoryTab from './HistoryTab.svelte';
  import { history } from './history.svelte';
  import { selected } from './model.svelte';
  import './inspector.css';

  function show(tab: 'details' | 'history') {
    ui.inspectorVisible = true;
    ui.inspectorTab = tab;
  }

  onMount(() => {
    const stops = [history.start(), selected.start()];
    const unregister = registerCommands([
      {
        id: 'inspector.details',
        title: 'Show item details',
        group: 'View',
        icon: 'info',
        run: () => show('details'),
      },
      {
        id: 'inspector.history',
        title: 'Show history',
        group: 'View',
        icon: 'history',
        run: () => show('history'),
      },
    ]);
    return () => {
      stops.forEach((stop) => stop());
      unregister();
    };
  });

  $effect(() => history.ensure(library.state?.ref.id ?? null));

  // A hairline under the tabs once the panel has scrolled, so content doesn't just stop at them.
  let scrolled = $state(false);

  const isField = (t: EventTarget | null) =>
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  // The keyboard belongs to the inspector while a text field has focus; buttons don't count.
  const onfocusin = (e: FocusEvent) => isField(e.target) && (focus.region = 'inspector');
  const onfocusout = (e: FocusEvent) =>
    isField(e.target) && focus.region === 'inspector' && (focus.region = 'grid');
</script>

<div class="inspector" {onfocusin} {onfocusout}>
  <div class="head" class:scrolled>
    <div class="tabs" role="tablist" aria-label="Inspector">
      <button
        type="button"
        role="tab"
        aria-selected={ui.inspectorTab === 'details'}
        class:on={ui.inspectorTab === 'details'}
        onclick={() => (ui.inspectorTab = 'details')}>Details</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={ui.inspectorTab === 'history'}
        class:on={ui.inspectorTab === 'history'}
        onclick={() => (ui.inspectorTab = 'history')}
      >
        History{#if history.today > 0}<span class="badge">{history.today} today</span>{/if}
      </button>
    </div>
    {#if library.state && library.readOnly}
      <div class="lock">
        <Lock size={12} />{readOnlyTip()}
      </div>
    {/if}
  </div>
  <div class="body" role="tabpanel" onscroll={(e) => (scrolled = e.currentTarget.scrollTop > 2)}>
    {#if !library.state}
      <p class="note">Open a library to see its details and history here.</p>
    {:else if ui.inspectorTab === 'details'}<DetailsTab />{:else}<HistoryTab />{/if}
  </div>
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .head {
    flex: none;
    padding: 14px 14px 12px;
    border-bottom: 1px solid transparent;
  }
  .head.scrolled {
    border-bottom-color: var(--line);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 8px;
    background: var(--fld);
  }
  .tabs button {
    flex: 1;
    height: 28px;
    border-radius: 6px;
    color: var(--mu);
    font-size: 12.5px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
  }
  .tabs button.on {
    background: var(--chip);
    color: var(--tx);
  }
  .badge {
    font-size: 10.5px;
    color: var(--fa);
  }
  .lock {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 0 0;
    font-size: 11.5px;
    color: var(--warn);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 14px 30px;
  }
</style>
