<script lang="ts">
  // Floating bar at the bottom of the grid while two or more items are selected.
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Tag from '@lucide/svelte/icons/tag';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import X from '@lucide/svelte/icons/x';
  import { readOnlyTip } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import * as act from './actions';

  const canCompare = $derived(selection.count >= 2 && selection.count <= 4);
  const ro = $derived(library.readOnly);
  const lock = $derived(ro ? readOnlyTip() : undefined);
  const inTrash = $derived(view.scope.kind === 'trash');
</script>

<div class="selbar" role="toolbar" aria-label="Selection">
  <span class="n">{selection.count.toLocaleString()} selected</span>
  {#if inTrash}
    <button class="pri" disabled={ro} title={lock} onclick={() => act.restore([...selection.ids])}
      ><Undo2 size={15} />Restore</button
    >
    <button disabled={ro} title={lock} onclick={() => act.deleteForever([...selection.ids])}
      ><Trash2 size={15} />Delete permanently<kbd>Del</kbd></button
    >
  {:else}
    <button
      class="pri"
      disabled={!canCompare}
      title={canCompare ? undefined : 'Pick 2 to 4 items to compare'}
      onclick={() => act.compare()}
    >
      <Columns2 size={15} />Compare side by side<kbd>C</kbd>
    </button>
    <button disabled={ro} title={lock} onclick={() => act.openTags()}
      ><Tag size={15} />Tag<kbd>T</kbd></button
    >
    <button disabled={ro} title={lock} onclick={() => act.openMoveTo()}
      ><FolderOpen size={15} />Move to…<kbd>M</kbd></button
    >
  {/if}
  <span class="sep"></span>
  <button aria-label="Clear selection" title="Clear selection" onclick={() => selection.clear()}
    ><X size={15} /><kbd>Esc</kbd></button
  >
</div>

<style>
  .selbar {
    position: absolute;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 4px;
    width: max-content;
    max-width: calc(100% - 24px);
    padding: 6px 6px 6px 14px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    border: 1px solid var(--panel-line);
    box-shadow: 0 12px 30px color-mix(in srgb, black 45%, transparent);
    backdrop-filter: blur(10px);
    font-size: 12.5px;
  }
  .n {
    color: var(--tx);
    font-weight: 600;
    margin-right: 8px;
    white-space: nowrap;
  }
  button {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 10px;
    border-radius: 7px;
    color: var(--tx);
    white-space: nowrap;
  }
  button:hover:not(:disabled) {
    background: var(--chip);
  }
  button:disabled {
    color: var(--fa);
  }
  button.pri:not(:disabled) {
    background: var(--bl);
    color: var(--tx);
  }
  button.pri:not(:disabled) kbd {
    background: color-mix(in srgb, var(--tx) 14%, transparent);
    border-color: color-mix(in srgb, var(--tx) 30%, transparent);
    color: var(--tx);
  }
  button:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--chip-line);
    margin: 0 4px;
  }
</style>
