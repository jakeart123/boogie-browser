<script lang="ts">
  // Export: copy originals into a folder on disk (never moves them, never overwrites). Opened for a
  // selection (props.ids) or a whole folder (props.folderId, subfolders included). "Keep folder
  // structure" recreates the library folders below the exported folder (or from the top for a
  // selection). The job shows in the status strip; its done toast has "Show folder".
  import { onMount, untrack } from 'svelte';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import { api } from '../../lib/api';
  import { errorText } from '../../lib/edit';
  import { plural, quoted } from '../../lib/format';
  import { readJSON, writeJSON } from '../../lib/storage';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import Modal from './Modal.svelte';
  import { splitPath } from './names';

  let { props }: { props: Record<string, unknown> } = $props();
  const folderId = untrack(() => (typeof props.folderId === 'string' ? props.folderId : null));
  const folderName = folderId ? (library.folder(folderId)?.node.name ?? 'Folder') : null;

  // A plain copy: dialog props live in $state (proxies), and Electron's IPC can't clone a proxy.
  let ids = $state.raw<string[] | null>(
    untrack(() => (Array.isArray(props.ids) ? [...(props.ids as string[])] : null)),
  );
  let dir = $state(readJSON<string>('exportDir', ''));
  let keepFolders = $state(!!folderId);
  let error = $state<string | null>(null);
  let busy = $state(false);

  onMount(() => {
    if (ids || !folderId) return;
    api
      .query({
        scope: { kind: 'folder', id: folderId, includeSubfolders: true },
        filter: {},
        sort: null,
      })
      .then((r) => (ids = r.ids))
      .catch((e) => (error = errorText(e)));
  });

  async function choose() {
    try {
      const picked = await api.pickDirectory('Export to');
      if (picked) dir = picked;
    } catch (e) {
      error = errorText(e);
    }
  }

  async function start() {
    if (!ids?.length || !dir || busy) return;
    busy = true;
    error = null;
    try {
      await api.exportItems(ids, dir, { keepFolders, baseFolderId: folderId ?? undefined });
      writeJSON('exportDir', dir);
      ui.closeDialog();
      ui.toast(`Exporting ${plural(ids.length, 'item')}`, { ms: 2500 });
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  const title = folderName ? `Export ${quoted(folderName)}` : 'Export';
</script>

<Modal {title} width={480}>
  <p class="what">
    {#if ids}
      {plural(ids.length, 'item')}{folderName ? ', subfolders included' : ''}. The originals are
      copied; nothing in the library changes.
    {:else if !error}
      Counting the items…
    {/if}
  </p>
  <div class="dg-field">
    <span class="dg-label">To</span>
    <div class="dg-row">
      {#if dir}
        {@const sp = splitPath(dir, 36)}
        <span class="dest dg-mid" title={dir}
          ><span class="head">{sp.head}</span><span class="tail">{sp.tail}</span></span
        >
      {:else}
        <span class="dest none">No folder chosen yet</span>
      {/if}
      <button class="dg-btn" data-autofocus onclick={choose}><FolderOpen size={14} />Choose…</button
      >
    </div>
  </div>
  <label class="dg-check">
    <input type="checkbox" bind:checked={keepFolders} />
    <span
      >Keep folder structure<span class="dg-sub"
        >{folderName
          ? `Recreate the folders inside ${quoted(folderName)}.`
          : 'Recreate each item’s folder path from the library.'}</span
      ></span
    >
  </label>
  {#if error}<p class="dg-err">{error}</p>{/if}
  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn" onclick={() => ui.closeDialog()}>Cancel</button>
    <button class="dg-btn pri" disabled={!ids?.length || !dir || busy} onclick={start}
      >Export</button
    >
  {/snippet}
</Modal>

<style>
  .what {
    margin: 0 0 14px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--mu);
  }
  .dest {
    flex: 1;
    min-width: 0;
    font: 12px var(--mono);
    color: var(--tx);
  }
  .dest.none {
    color: var(--fa);
    font-family: inherit;
  }
</style>
