<script lang="ts">
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Tag from '@lucide/svelte/icons/tag';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { openContextMenu } from '../../lib/contextMenu.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { emptyTrash } from '../../lib/appCommands';
  import { openRandom } from './actions';

  type Kind = 'all' | 'uncategorized' | 'untagged' | 'random' | 'trash';
  const entries: { kind: Kind; label: string; icon: typeof Tag }[] = [
    { kind: 'all', label: 'All', icon: LayoutGrid },
    { kind: 'uncategorized', label: 'Uncategorized', icon: Inbox },
    { kind: 'untagged', label: 'Untagged', icon: Tag },
    { kind: 'random', label: 'Random', icon: Shuffle },
    { kind: 'trash', label: 'Trash', icon: Trash2 },
  ];

  // Counts arrive after the names; Random has none.
  const count = (kind: Kind): number | null =>
    kind === 'random' ? null : (library.counts?.[kind] ?? null);

  // Like Eagle, the Trash row's right-click menu empties it.
  function menu(e: MouseEvent, kind: Kind) {
    if (kind !== 'trash') return;
    const lock = readOnlyTip();
    openContextMenu(e, [
      {
        label: 'Empty trash…',
        danger: true,
        disabled: !!lock || !library.counts?.trash,
        title: lock,
        run: emptyTrash,
      },
    ]);
  }

  function go(kind: Kind) {
    if (kind === 'random')
      openRandom(); // a fresh seed every click
    else view.setScope({ kind });
  }
</script>

<nav aria-label="Library views">
  {#each entries as { kind, label, icon: Icon } (kind)}
    {@const n = count(kind)}
    <button
      class="sb-row"
      class:sel={view.scope.kind === kind}
      aria-current={view.scope.kind === kind ? 'page' : undefined}
      onclick={() => go(kind)}
      oncontextmenu={(e) => menu(e, kind)}
    >
      <Icon size={16} class="ic" />
      <span class="fn">{label}</span>
      {#if n}<span class="sb-ct">{n.toLocaleString()}</span>{/if}
    </button>
  {/each}
</nav>
