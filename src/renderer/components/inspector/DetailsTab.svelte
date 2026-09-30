<script lang="ts">
  // Picks what the Details tab shows: the scope when nothing is selected, else the selected items.
  import { untrack } from 'svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import ItemDetails from './ItemDetails.svelte';
  import ScopeInfo from './ScopeInfo.svelte';
  import { selected } from './model.svelte';

  $effect(() => {
    const ids = selection.ids;
    untrack(() => void selected.load(ids));
  });

  // Has the model caught up with the selection?
  const ready = $derived(selected.forIds === selection.ids);
</script>

{#if selection.count === 0}
  <ScopeInfo />
{:else if !selected.list.length}
  <div class="note" aria-busy={!ready}>
    {#if ready}
      {selected.error
        ? `Could not load: ${selected.error}`
        : 'This item is no longer in the library.'}
    {/if}
  </div>
{:else}
  <!-- While the next selection loads (a frame or two when paging with the arrow keys) the panel
       stays as it was, built for the ids it shows, so it never blinks and an edit made in that
       moment still goes to the item on screen. Deselecting empties the model, so an old item
       never lingers behind a new pick. -->
  {#key selected.forIds}
    <ItemDetails items={selected.list} ids={selected.forIds ?? selection.ids} />
  {/key}
{/if}
