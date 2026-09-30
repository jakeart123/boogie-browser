<script lang="ts">
  // Details tab with nothing selected: what you are looking at. A folder gets its own editor;
  // every other view gets a short summary.
  import { fileSize } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import FolderInfo from './FolderInfo.svelte';

  const scope = $derived(view.scope);
  const counts = $derived(library.counts);

  const summary = $derived.by((): { title: string; count: number | null } => {
    switch (scope.kind) {
      case 'all':
        return { title: 'All items', count: counts?.all ?? null };
      case 'uncategorized':
        return { title: 'Uncategorized', count: counts?.uncategorized ?? null };
      case 'untagged':
        return { title: 'Untagged', count: counts?.untagged ?? null };
      case 'trash':
        return { title: 'Trash', count: counts?.trash ?? null };
      case 'random':
        return { title: 'Random', count: view.result?.total ?? null };
      case 'smartFolder':
        return {
          title: library.smartFolders.get(scope.id)?.name ?? 'Smart folder',
          count: counts?.smartFolders[scope.id] ?? null,
        };
      case 'tag':
        return {
          title: scope.name,
          count: library.tags.find((t) => t.name === scope.name)?.count ?? null,
        };
      case 'ids':
        return { title: 'Selected items', count: scope.ids.length };
      case 'folder':
        return { title: '', count: null };
    }
  });
</script>

{#if scope.kind === 'folder'}
  {#key scope.id}<FolderInfo id={scope.id} />{/key}
{:else}
  <h3>{summary.title}</h3>
  <dl class="props">
    <div>
      <dt>Library</dt>
      <dd title={library.state?.ref.path}>{library.state?.ref.name ?? ''}</dd>
    </div>
    {#if counts?.totalSize != null}<div>
        <dt>Library size</dt>
        <dd>{fileSize(counts.totalSize)}</dd>
      </div>{/if}
    {#if summary.count !== null}<div>
        <dt>Items</dt>
        <dd>{summary.count.toLocaleString()}</dd>
      </div>{/if}
    {#if view.filtered && view.result}<div>
        <dt>Shown with filters</dt>
        <dd>{view.result.total.toLocaleString()}</dd>
      </div>{/if}
  </dl>
  <div class="note tip">Select an item to see and edit its details.</div>
{/if}

<style>
  h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .props {
    margin: 0;
  }
  .props div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    min-height: 27px;
    font-size: 12px;
  }
  dt {
    color: var(--fa);
    flex: none;
  }
  dd {
    margin: 0;
    text-align: right;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .tip {
    margin-top: 14px;
  }
</style>
