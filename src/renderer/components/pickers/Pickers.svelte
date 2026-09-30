<script lang="ts">
  // Renders whichever picker overlay is open (ui.overlay): the tag window, the folder picker,
  // go-to-folder and rename. The command palette is its own component.
  import { untrack } from 'svelte';
  import { library } from '../../lib/stores/library.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import RenameOverlay from './RenameOverlay.svelte';
  import TagWindow from './TagWindow.svelte';

  const overlay = $derived(ui.overlay);

  // Callers may hand over explicit item ids ({ ids }); otherwise the overlay acts on the selection as
  // it was when the overlay opened (untracked: a modal's items must not shift under it).
  const ids = $derived.by<string[]>(() => {
    const o = ui.overlay;
    if (!o) return [];
    return untrack(() => {
      const given = (o.arg as { ids?: unknown } | undefined)?.ids;
      if (Array.isArray(given)) return given.filter((x): x is string => typeof x === 'string');
      return selection.inOrder(view.result?.ids);
    });
  });
</script>

{#if overlay && library.state}
  {#key overlay}
    {#if overlay.kind === 'tags'}
      <TagWindow {ids} onclose={() => ui.closeOverlay()} />
    {:else if overlay.kind === 'folderPicker'}
      <FolderPicker
        mode={(overlay.arg as { move?: boolean } | undefined)?.move ? 'move' : 'add'}
        {ids}
        onclose={() => ui.closeOverlay()}
      />
    {:else if overlay.kind === 'goToFolder'}
      <FolderPicker mode="goto" ids={[]} onclose={() => ui.closeOverlay()} />
    {:else if overlay.kind === 'rename'}
      <RenameOverlay {ids} onclose={() => ui.closeOverlay()} />
    {/if}
  {/key}
{/if}
