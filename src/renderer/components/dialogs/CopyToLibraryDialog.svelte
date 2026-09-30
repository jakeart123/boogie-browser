<script lang="ts">
  // "Add to other library…": copy the selected items (files and details, with new ids) into
  // another library you know, optionally into one of its folders. Nothing here changes the open
  // library. The copy runs as a job in the status strip.
  import { onMount, untrack } from 'svelte';
  import Library from '@lucide/svelte/icons/library';
  import { api } from '../../lib/api';
  import { errorText } from '../../lib/edit';
  import { plural } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import type { FolderNode } from '../../../shared/types';
  import Modal from './Modal.svelte';

  let { props }: { props: Record<string, unknown> } = $props();
  // A plain copy: dialog props live in $state (proxies), and Electron's IPC can't clone a proxy.
  const ids = untrack(() => (Array.isArray(props.ids) ? [...(props.ids as string[])] : []));

  const others = $derived(
    library.known.filter((k) => k.exists && k.path !== library.state?.ref.path),
  );
  let target = $state<string | null>(null);
  let folders = $state.raw<{ id: string; path: string }[] | null>(null);
  let folderId = $state<string>('');
  let folderQuery = $state('');
  let foldersNote = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  onMount(() => {
    if (others.length === 1) void pick(others[0].path);
  });

  function flatten(nodes: FolderNode[], parents: string[] = []): { id: string; path: string }[] {
    return nodes.flatMap((n) => {
      const path = [...parents, n.name];
      return [{ id: n.id, path: path.join(' › ') }, ...flatten(n.children, path)];
    });
  }

  async function pick(path: string) {
    target = path;
    folderId = '';
    folders = null;
    foldersNote = null;
    try {
      const tree = await api.listLibraryFolders!(path);
      if (target === path) folders = flatten(tree);
    } catch {
      if (target === path) foldersNote = 'Its folders can’t be listed here, so they go in unfiled.';
    }
  }

  const shownFolders = $derived.by(() => {
    const q = folderQuery.trim().toLowerCase();
    const list = folders ?? [];
    return (q ? list.filter((f) => f.path.toLowerCase().includes(q)) : list).slice(0, 200);
  });

  async function copy() {
    if (!target || !ids.length || busy) return;
    busy = true;
    error = null;
    try {
      await api.copyToLibrary(ids, target, { folderId: folderId || null });
      const name = others.find((k) => k.path === target)?.name ?? 'the other library';
      ui.closeDialog();
      ui.toast(`Copying ${plural(ids.length, 'item')} to ${name}`, { ms: 3000 });
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Add to other library" subtitle={plural(ids.length, 'item')} width={520}>
  {#if !others.length}
    <p class="dg-hint">Boogie knows no other library yet. Add one in the Libraries dialog first.</p>
  {:else}
    <div class="dg-field">
      <span class="dg-label">Library</span>
      <div class="libs" role="radiogroup" aria-label="Library">
        {#each others as k (k.path)}
          <button
            class="lib"
            class:on={target === k.path}
            role="radio"
            aria-checked={target === k.path}
            onclick={() => pick(k.path)}
          >
            <Library size={14} />
            <span class="nm">{k.name}</span>
            {#if k.shared}<span class="dg-badge">Shared</span>{/if}
          </button>
        {/each}
      </div>
    </div>
    {#if target}
      <div class="dg-field">
        <span class="dg-label">Folder</span>
        {#if folders}
          <input
            class="dg-input"
            placeholder="Find a folder (or leave it unfiled)"
            bind:value={folderQuery}
          />
          <select class="dg-select" size="6" bind:value={folderId} aria-label="Folder">
            <option value="">No folder (unfiled)</option>
            {#each shownFolders as f (f.id)}<option value={f.id}>{f.path}</option>{/each}
          </select>
        {:else if foldersNote}
          <span class="dg-hint">{foldersNote}</span>
        {:else}
          <span class="dg-hint">Reading its folders…</span>
        {/if}
      </div>
    {/if}
    <p class="dg-hint">
      The files and their details are copied with new ids. Items that are already there are skipped.
    </p>
  {/if}
  {#if error}<p class="dg-err">{error}</p>{/if}
  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn" onclick={() => ui.closeDialog()}>Cancel</button>
    <button class="dg-btn pri" disabled={!target || busy} onclick={copy}>Copy</button>
  {/snippet}
</Modal>

<style>
  .libs {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lib {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid var(--line);
    font-size: 13px;
    text-align: left;
  }
  .lib:hover {
    background: var(--bls);
  }
  .lib.on {
    border-color: var(--bl);
    background: var(--bls);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  select[size] {
    margin-top: 6px;
    height: auto;
  }
</style>
