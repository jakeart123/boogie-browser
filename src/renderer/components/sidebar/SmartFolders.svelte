<script lang="ts">
  import { untrack } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Plus from '@lucide/svelte/icons/plus';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { openContextMenu, type MenuItem } from '../../lib/contextMenu.svelte';
  import { api } from '../../lib/api';
  import { canEdit, fail, mutate, readOnlyTip, toastWithUndo } from '../../lib/edit';
  import { SORTS } from '../../lib/sorts';
  import type { SmartCondition, SmartFolderNode } from '../../../shared/types';
  import FolderGlyph from './FolderGlyph.svelte';
  import Section from './Section.svelte';
  import { deleteSmartFolder, inQuickAccess, openSmartFolder, toggleQuickAccess } from './actions';
  import { expanded } from './expanded.svelte';
  import { ancestorsInTree, flatten } from './tree';
  import { quoted } from '../../lib/format';

  const rows = $derived(flatten(library.state?.smartFolders ?? [], expanded.set));
  const total = $derived(library.smartFolders.size);
  const ro = $derived(library.readOnly);

  // Open the parents of the smart folder being viewed, once per folder.
  let revealed = '';
  $effect(() => {
    const libraryId = library.state?.ref.id ?? '';
    untrack(() => expanded.load(libraryId));
    const s = view.scope;
    const id = s.kind === 'smartFolder' ? s.id : '';
    if (!id) return void (revealed = '');
    const parents = ancestorsInTree(library.state?.smartFolders ?? [], id);
    if (id === revealed || !parents) return;
    revealed = id;
    untrack(() => expanded.add(parents));
  });

  const newOne = (parentId?: string) =>
    ui.openDialog('smartFolderEdit', parentId ? { parentId } : {});

  /** A copy next to it, with the same rules ("Hands copy"). */
  async function duplicate(node: SmartFolderNode) {
    if (!canEdit()) return;
    const parentId = ancestorsInTree(library.state?.smartFolders ?? [], node.id)?.at(-1) ?? null;
    try {
      const name = `${node.name} copy`;
      const { id, groupId } = await api.createSmartFolder(
        name,
        $state.snapshot(node.conditions) as SmartCondition[],
        parentId,
        node.iconColor ? { iconColor: node.iconColor } : undefined,
      );
      openSmartFolder(id);
      toastWithUndo(`Made ${quoted(name)}`, groupId);
    } catch (e) {
      fail(e);
    }
  }

  function menu(e: MouseEvent, node: SmartFolderNode) {
    const lock = readOnlyTip();
    const edit = (item: MenuItem): MenuItem => ({ ...item, disabled: !!lock, title: lock });
    openContextMenu(e, [
      edit({ label: 'New smart folder…', run: () => newOne() }),
      edit({ label: 'New smart folder inside…', run: () => newOne(node.id) }),
      edit({ label: 'Edit…', run: () => ui.openDialog('smartFolderEdit', { id: node.id }) }),
      edit({ label: 'Duplicate', run: () => duplicate(node) }),
      edit({
        label: 'Sort by',
        submenu: SORTS.filter((o) => !o.folderOnly).map((o) => ({
          label: o.label,
          checked: node.orderBy === o.by,
          run: () => void mutate(() => api.updateSmartFolder(node.id, { orderBy: o.by })),
        })),
      }),
      edit({
        label: inQuickAccess('smartFolder', node.id)
          ? 'Remove from Quick Access'
          : 'Add to Quick Access',
        run: () => toggleQuickAccess('smartFolder', node.id),
      }),
      { separator: true },
      edit({ label: 'Delete…', danger: true, run: () => deleteSmartFolder(node.id) }),
    ]);
  }
</script>

{#if total}
  <Section id="smart" title="Smart Folders" count={total}>
    {#snippet actions()}
      <button
        class="sb-ib"
        aria-label="New smart folder"
        title={readOnlyTip() ?? 'New smart folder…'}
        disabled={ro}
        onclick={() => newOne()}><Plus size={14} /></button
      >
    {/snippet}
    {#each rows as row (row.node.id)}
      {@const node = row.node}
      {@const n = library.counts?.smartFolders[node.id]}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="sb-row tree"
        class:open={row.open}
        class:sel={view.scope.kind === 'smartFolder' && view.scope.id === node.id}
        style:--d={row.depth}
        role="button"
        tabindex="0"
        title={node.name}
        onclick={() => openSmartFolder(node.id)}
        onkeydown={(e) => e.key === 'Enter' && openSmartFolder(node.id)}
        oncontextmenu={(e) => menu(e, node)}
      >
        {#if row.hasChildren}
          <button
            class="sb-car"
            tabindex="-1"
            aria-label={row.open ? 'Collapse' : 'Expand'}
            onclick={(e) => (e.stopPropagation(), expanded.toggle(node.id))}
            ><ChevronRight size={12} /></button
          >
        {:else}
          <span class="sb-car"></span>
        {/if}
        <FolderGlyph smart color={node.iconColor} icon={node.icon} />
        <span class="fn">{node.name}</span>
        {#if n}<span class="sb-ct">{n.toLocaleString()}</span>{/if}
      </div>
    {/each}
  </Section>
{/if}
