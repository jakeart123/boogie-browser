<script lang="ts">
  // "Add from URL…": one or many links, one per line, imported as one job into the folder you're
  // looking at. "Save as bookmarks" keeps web pages as bookmark items instead of downloading.
  import { currentFolderId, importUrls, linksIn } from '../../lib/files';
  import { plural, quoted } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import Modal from './Modal.svelte';

  let text = $state('');
  let bookmarks = $state(false);
  const links = $derived(linksIn(text));
  const folderId = currentFolderId();
  const folderName = folderId ? library.folder(folderId)?.node.name : null;

  async function add() {
    if (!links.length) return;
    ui.closeDialog();
    await importUrls(links, folderId, bookmarks);
  }
</script>

<Modal title="Add from URL" width={520} backdropClose={false}>
  <label class="dg-field">
    <span class="dg-label">Links, one per line</span>
    <textarea
      class="dg-textarea"
      rows="6"
      spellcheck="false"
      placeholder="https://example.com/picture.jpg"
      bind:value={text}
      onkeydown={(e) => e.key === 'Enter' && e.ctrlKey && (e.preventDefault(), add())}></textarea>
    <span class="dg-hint"
      >{links.length
        ? `${plural(links.length, 'link')} found`
        : 'Web (http, https) and data: links'}{folderName
        ? `, going into ${quoted(folderName)}`
        : ''}. Ctrl Enter adds them.</span
    >
  </label>
  <label class="dg-check">
    <input type="checkbox" bind:checked={bookmarks} />
    <span
      >Save as bookmarks<span class="dg-sub"
        >Keep web pages as links in the library instead of downloading the file they point to.</span
      ></span
    >
  </label>
  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn" onclick={() => ui.closeDialog()}>Cancel</button>
    <button class="dg-btn pri" disabled={!links.length || library.readOnly} onclick={add}
      >{links.length > 1 ? `Add ${links.length}` : 'Add'}</button
    >
  {/snippet}
</Modal>
