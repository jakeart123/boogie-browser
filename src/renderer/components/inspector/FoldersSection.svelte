<script lang="ts">
  // Folders of one item, or the union over a multi-selection. Click a chip to open that folder.
  import Folder from '@lucide/svelte/icons/folder';
  import Plus from '@lucide/svelte/icons/plus';
  import type { Item } from '../../../shared/types';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { plural, quoted } from '../../lib/format';
  import Chip from './Chip.svelte';
  import { editSelected } from './edit';
  import { folderColor, unionCounts } from './logic';

  let { items, ids, readonly }: { items: Item[]; ids: string[]; readonly: boolean } = $props();

  const n = $derived(items.length);
  // An id that is not in the tree (Eagle leaves these behind) has nothing to show or open.
  const counted = $derived(
    unionCounts(items.map((i) => i.folders)).filter((c) => library.folder(c.key)),
  );

  function open(id: string) {
    view.setScope({ kind: 'folder', id, includeSubfolders: view.showSubfolderContents });
  }

  function addTo(id: string, name: string) {
    return editSelected(
      ids,
      { addFolders: [id] },
      { what: `add ${plural(ids.length, 'item')} to ${quoted(name)}` },
    );
  }

  function removeFrom(id: string, name: string) {
    const done =
      ids.length > 1
        ? `Removed ${plural(ids.length, 'item')} from ${quoted(name)}`
        : `Removed from ${quoted(name)}`;
    return editSelected(
      ids,
      { removeFolders: [id] },
      { what: `remove ${plural(ids.length, 'item')} from ${quoted(name)}`, done },
    );
  }
</script>

<div class="lbl">Folders</div>
<div class="chips">
  {#each counted as f (f.key)}
    {@const info = library.folder(f.key)!}
    {@const partial = f.count < n}
    {@const path = info.path.join(' › ')}
    <Chip
      label={info.node.name}
      dim={partial}
      sub={partial ? `${f.count} of ${n}` : undefined}
      title={partial
        ? `${path}\nIn ${f.count} of ${n} items. Click to add it to all.`
        : `${path}\nClick to open`}
      onclick={partial
        ? readonly
          ? undefined
          : () => addTo(f.key, info.node.name)
        : () => open(f.key)}
      onremove={readonly ? undefined : () => removeFrom(f.key, info.node.name)}
    >
      {#snippet lead()}<span class="fd" style:color={folderColor(info.node.iconColor)}
          ><Folder size={13} fill="currentColor" strokeWidth={1.5} /></span
        >{/snippet}
    </Chip>
  {/each}
  {#if !readonly}
    <Chip label="Add" ghost title="Add to a folder" onclick={() => ui.openOverlay('folderPicker')}>
      {#snippet lead()}<Plus size={13} />{/snippet}
    </Chip>
  {/if}
</div>
{#if !counted.length && readonly}<div class="note">Not in a folder</div>{/if}
{#if ids.length > n}<div class="note trunc">
    Folders shown are from the first {n.toLocaleString()} of {ids.length.toLocaleString()} items.
  </div>{/if}

<style>
  .trunc {
    margin-top: 6px;
  }
  .fd {
    display: inline-grid;
    color: var(--mu);
    flex: none;
  }
</style>
