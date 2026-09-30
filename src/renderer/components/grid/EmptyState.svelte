<script lang="ts">
  // What the grid says when there is nothing to draw: no library, still indexing, an empty
  // folder, no matches for the filter, or a failed query.
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import ImagePlus from '@lucide/svelte/icons/image-plus';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Lock from '@lucide/svelte/icons/lock';
  import { isLocked } from '../../lib/folders';
  import SearchX from '@lucide/svelte/icons/search-x';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';

  const indexing = $derived(library.state?.indexing ?? null);
  const kind = $derived(view.scope.kind);
  // Eagle hides what's in a password-locked folder (and the folders under it) until it's unlocked.
  const locked = $derived(view.scope.kind === 'folder' && isLocked(view.scope.id));
</script>

<div class="empty" role="status">
  {#if !library.state}
    <HardDrive size={30} />
    <h3>No library open</h3>
    <p>Open an Eagle library to browse it here.</p>
    <button class="btn" onclick={() => ui.openDialog('libraries')}>Open a library</button>
  {:else if view.error}
    <CircleAlert size={30} />
    <h3>Could not load items</h3>
    <p>{view.error}</p>
    <button class="btn" onclick={() => view.run(0)}>Try again</button>
  {:else if indexing || view.partial}
    <!-- Items show up in the grid as the scan reads them (the view refreshes while it runs); the
         progress bar is the status banner's, above the grid. -->
    <HardDrive size={30} />
    <h3>Reading your library</h3>
    <p>
      {#if indexing && indexing.total > 0}{indexing.done.toLocaleString()} of {indexing.total.toLocaleString()}
        items so far.{:else if indexing}Reading the library folder first.{/if}
      Items show up here as they are read.
    </p>
  {:else if !view.result}
    <p class="soft">Loading…</p>
  {:else if locked}
    <Lock size={30} />
    <h3>Locked in Eagle</h3>
    <p>Boogie doesn’t unlock folders. Unlock it in Eagle to see what’s inside.</p>
  {:else if view.filtered}
    <SearchX size={30} />
    <h3>No matches</h3>
    <p>Nothing in here fits the current search and filters.</p>
    <button class="btn" onclick={() => view.clearFilter()}>Clear filters</button>
  {:else if kind === 'trash'}
    <Trash2 size={30} />
    <h3>Trash is empty</h3>
    <p>Items you delete wait here until you remove them for good.</p>
  {:else if kind === 'folder' || kind === 'all'}
    <ImagePlus size={30} />
    <h3>Drop images here</h3>
    <p>
      {kind === 'folder'
        ? 'This folder is empty. Drag files in from your file manager or a web page.'
        : 'This library is empty. Drag files in from your file manager or a web page.'}
    </p>
  {:else}
    <Inbox size={30} />
    <h3>Nothing here</h3>
    <p>No items match this view.</p>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 260px;
    padding: 40px 24px 90px;
    text-align: center;
    color: var(--fa);
  }
  h3 {
    margin: 6px 0 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--tx);
  }
  p {
    margin: 0;
    max-width: 380px;
    font-size: 12.5px;
    color: var(--mu);
  }
  .soft {
    color: var(--fa);
  }
  .btn {
    margin-top: 10px;
    height: 30px;
    padding: 0 14px;
    border-radius: 7px;
    background: var(--chip);
    border: 1px solid var(--chip-line);
    color: var(--tx);
    font-size: 12.5px;
  }
  .btn:hover {
    background: var(--hov);
  }
  .btn:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
  }
</style>
