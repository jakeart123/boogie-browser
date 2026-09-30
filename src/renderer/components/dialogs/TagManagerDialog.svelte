<script lang="ts">
  // Every tag with its count (search, star, rename or merge, delete) next to the tag groups you can
  // drag tags into. Each side is its own component; a failed change shows here, under both.
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import Modal from './Modal.svelte';
  import TagGroups from './TagGroups.svelte';
  import TagList from './TagList.svelte';
  import { tagEdits } from './tagEdits';

  let error = $state<string | null>(null);
  const edits = tagEdits((message) => (error = message));
  const lockTip = $derived(library.readOnly ? readOnlyTip() : undefined);
</script>

<Modal title="Tags" subtitle="Rename, merge or delete tags, and sort them into groups." width={860}>
  <div class="cols">
    <section class="pane" aria-label="All tags"><TagList {edits} /></section>
    <section class="pane" aria-label="Tag groups"><TagGroups {edits} /></section>
  </div>
  {#if error}<p class="dg-err" style="margin-top:10px">{error}</p>{/if}

  {#snippet footer()}
    {#if lockTip}<span class="dg-note">{lockTip}</span>{/if}
    <span class="dg-sp"></span>
    <button class="dg-btn pri" onclick={() => ui.closeDialog()}>Done</button>
  {/snippet}
</Modal>

<style>
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 20px;
    height: min(520px, calc(100vh - 250px));
    min-height: 260px;
    padding-top: 4px;
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    /* The tag list pulls its scrollbar 6px into the gutter; that must not add a sideways scrollbar. */
    overflow-x: hidden;
  }
</style>
