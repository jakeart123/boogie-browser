<script lang="ts">
  // The library manager. Also the first thing you see when no library is open, and then it
  // can't be closed until one opens.
  import { onMount, untrack } from 'svelte';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Plus from '@lucide/svelte/icons/plus';
  import { api } from '../../lib/api';
  import { openContextMenu, type MenuItem } from '../../lib/contextMenu.svelte';
  import { relativeTime } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import type { KnownLibrary } from '../../../shared/types';
  import { onEscape } from './escape';
  import { errorText } from '../../lib/edit';
  import { libraryNameProblem, splitPath } from './names';
  import Modal from './Modal.svelte';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  // Read once: Dialogs.svelte mounts a fresh component for every openDialog call.
  const args = untrack(() => incoming);

  const startup = $derived(!library.state);
  const currentPath = $derived(library.state?.ref.path ?? null);

  let busyPath = $state<string | null>(null);
  let errors = $state<Record<string, string>>({});
  let topError = $state<string | null>(null);
  let partner = $state<{ path: string; value: string } | null>(null);
  let creating = $state(args.mode === 'create');
  let newName = $state('');
  let newDir = $state('');
  let createError = $state<string | null>(null);

  onMount(() => {
    void refresh();
    // Default the new library's location to next to the one that's open.
    if (currentPath) newDir = currentPath.replace(/\/[^/]+$/, '');
  });

  async function refresh() {
    try {
      library.known = await api.listLibraries();
    } catch (e) {
      topError = errorText(e);
    }
  }

  $effect(() => {
    if (!partner && !creating) return;
    return onEscape(() => {
      if (partner) partner = null;
      else creating = false;
      return true;
    });
  });

  async function openIt(k: KnownLibrary, readOnly = false) {
    if (!k.exists || busyPath) return;
    if (k.path === currentPath && !readOnly) return ui.closeDialog();
    busyPath = k.path;
    errors = { ...errors, [k.path]: '' };
    topError = null;
    try {
      // The library store starts the view over when a different library opens.
      await library.open(k.path, readOnly ? { readOnly: true } : undefined);
      ui.closeDialog();
    } catch (e) {
      errors = { ...errors, [k.path]: errorText(e) };
    } finally {
      busyPath = null;
    }
  }

  async function openOther() {
    topError = null;
    try {
      const path = await api.pickLibraryFolder();
      if (!path) return;
      const k = await api.addLibrary(path);
      await refresh();
      await openIt(k);
    } catch (e) {
      topError = errorText(e);
    }
  }

  async function chooseDir() {
    try {
      const dir = await api.pickDirectory('Where should the new library go?');
      if (dir) newDir = dir;
    } catch (e) {
      createError = errorText(e);
    }
  }

  const nameProblem = $derived(newName ? libraryNameProblem(newName) : null);
  const canCreate = $derived(!!newName.trim() && !nameProblem && !!newDir && busyPath === null);

  async function create(e?: Event) {
    e?.preventDefault();
    if (!canCreate) return;
    busyPath = 'create';
    createError = null;
    try {
      await library.create(newDir, newName.trim());
      ui.closeDialog();
    } catch (err) {
      createError = errorText(err);
    } finally {
      busyPath = null;
    }
  }

  async function savePartner() {
    if (!partner) return;
    const { path, value } = partner;
    partner = null;
    try {
      await api.setLibraryOptions(path, { partnerName: value.trim() || null });
      await refresh();
    } catch (e) {
      errors = { ...errors, [path]: errorText(e) };
    }
  }

  async function toggleShared(k: KnownLibrary) {
    try {
      await api.setLibraryOptions(k.path, { shared: !k.shared });
      await refresh();
    } catch (e) {
      errors = { ...errors, [k.path]: errorText(e) };
    }
  }

  async function forget(k: KnownLibrary) {
    try {
      await api.forgetLibrary(k.path);
      await refresh();
    } catch (e) {
      errors = { ...errors, [k.path]: errorText(e) };
    }
  }

  function menu(e: MouseEvent, k: KnownLibrary) {
    const items: MenuItem[] = [
      { label: 'Open', disabled: !k.exists, run: () => openIt(k) },
      { label: 'Open read-only', disabled: !k.exists, run: () => openIt(k, true) },
      { separator: true },
      {
        label: 'Partner name…',
        run: () => void (partner = { path: k.path, value: k.partnerName ?? '' }),
      },
      { label: 'Shared over Dropbox', checked: k.shared, run: () => toggleShared(k) },
      { separator: true },
      {
        label: 'Remove from list',
        danger: true,
        disabled: k.path === currentPath,
        run: () => forget(k),
      },
    ];
    openContextMenu(e, items);
  }

  /** "AR" from "Art Archive", "CL" from "Course Library - Main File". */
  function initials(name: string): string {
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
    return two.toUpperCase();
  }

  const shareLabel = (k: KnownLibrary) =>
    k.partnerName ? `Dropbox · shared with ${k.partnerName}` : 'Dropbox · shared';
</script>

<Modal
  title={creating && !library.known.length
    ? 'Create a library'
    : startup
      ? 'Open a library'
      : 'Libraries'}
  subtitle={startup
    ? 'Pick an Eagle library to start. Boogie edits it in place, so you can keep sharing it.'
    : 'Switch, add or create libraries. One is open at a time.'}
  width={640}
  dismissable={!startup}
  backdropClose={!startup}
>
  {#if topError}<p class="dg-err" style="margin:6px 0 8px">{topError}</p>{/if}

  {#if library.known.length}
    <ul class="list">
      {#each library.known as k (k.path)}
        {@const cur = k.path === currentPath}
        {@const sp = splitPath(k.path)}
        <li class="item" class:cur class:missing={!k.exists}>
          <div class="row" role="presentation" oncontextmenu={(e) => menu(e, k)}>
            <button
              class="main"
              disabled={!k.exists || (busyPath !== null && busyPath !== k.path)}
              onclick={() => openIt(k)}
            >
              <span class="ico">{initials(k.name)}</span>
              <span class="txt">
                <span class="nm">
                  <b>{k.name}</b>
                  {#if cur}<span class="dg-badge blue">Open now</span>{/if}
                  {#if k.shared}<span class="dg-badge">{shareLabel(k)}</span>{/if}
                  {#if !k.exists}<span class="dg-badge warn">Missing</span>{/if}
                </span>
                <span class="sub">
                  <span class="dg-mid path" title={k.path}
                    ><span class="head">{sp.head}</span><span class="tail">{sp.tail}</span></span
                  >
                  <span class="when">
                    {#if k.source === 'eagle-settings' && !k.lastOpenedAt}Found in Eagle{:else if k.lastOpenedAt}Opened
                      {relativeTime(k.lastOpenedAt)}{:else}Not opened yet{/if}
                  </span>
                </span>
              </span>
              {#if busyPath === k.path}<span class="opening"
                  ><LoaderCircle size={14} class="dg-spin" />Opening…</span
                >{/if}
            </button>
            <button
              class="dg-ib"
              aria-label="More for {k.name}"
              title="More"
              onclick={(e) => menu(e, k)}><Ellipsis size={16} /></button
            >
          </div>
          {#if partner?.path === k.path}
            <form class="partner" onsubmit={(e) => (e.preventDefault(), savePartner())}>
              <label for="pn-{k.id}">Who else uses this library?</label>
              <input
                id="pn-{k.id}"
                class="dg-input"
                placeholder="Name, like Sam"
                bind:value={partner.value}
                data-autofocus
              />
              <button class="dg-btn sm pri" type="submit">Save</button>
              <button class="dg-btn sm" type="button" onclick={() => (partner = null)}
                >Cancel</button
              >
            </form>
          {/if}
          {#if errors[k.path]}<p class="dg-err rowerr">{errors[k.path]}</p>{/if}
        </li>
      {/each}
    </ul>
  {:else}
    <div class="dg-empty">
      <FolderOpen size={26} />No libraries yet. Open an Eagle library, or create a new one.
    </div>
  {/if}

  {#if creating}
    <form class="create" onsubmit={create}>
      <div class="dg-field" style="margin-top:0">
        <label class="dg-label" for="nl-name">Library name</label>
        <input
          id="nl-name"
          class="dg-input"
          class:bad={!!nameProblem}
          placeholder="My new library"
          bind:value={newName}
          data-autofocus
          autocomplete="off"
        />
        {#if nameProblem}<p class="dg-err">{nameProblem}</p>{/if}
      </div>
      <div class="dg-field">
        <span class="dg-label" id="nl-loc">Location</span>
        <div class="dg-row">
          <span class="dg-code loc dg-mid" aria-labelledby="nl-loc" title={newDir}>
            {#if newDir}<span class="head">{splitPath(newDir, 26).head}</span><span class="tail"
                >{splitPath(newDir, 26).tail}</span
              >{:else}<span class="dg-hint">No folder chosen</span>{/if}
          </span>
          <button class="dg-btn" type="button" onclick={chooseDir}>Choose…</button>
        </div>
        {#if newDir && newName.trim() && !nameProblem}<p class="dg-hint">
            Creates {newDir}/{newName.trim()}.library
          </p>{/if}
      </div>
      {#if createError}<p class="dg-err" style="margin-top:10px">{createError}</p>{/if}
      <div class="dg-row" style="margin-top:14px">
        <span class="dg-sp" style="flex:1"></span>
        <button class="dg-btn" type="button" onclick={() => (creating = false)}>Cancel</button>
        <button class="dg-btn pri" type="submit" disabled={!canCreate}>
          {#if busyPath === 'create'}<LoaderCircle size={14} class="dg-spin" />{/if}Create library
        </button>
      </div>
    </form>
  {/if}

  {#snippet footer()}
    <button class="dg-btn" onclick={openOther} disabled={busyPath !== null}
      ><FolderOpen size={14} />Open other library…</button
    >
    <button class="dg-btn" onclick={() => (creating = !creating)} aria-expanded={creating}
      ><Plus size={14} />Create new library…</button
    >
  {/snippet}
</Modal>

<style>
  .list {
    list-style: none;
    margin: 4px -6px 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    border-radius: 9px;
  }
  .item.cur {
    background: color-mix(in srgb, var(--bl) 7%, transparent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 6px;
    border-radius: 9px;
  }
  .row:hover {
    background: var(--hov);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 6px 9px 10px;
    text-align: left;
    cursor: pointer;
    border-radius: 9px;
  }
  .main:disabled {
    cursor: default;
  }
  .missing .txt,
  .missing .ico {
    opacity: 0.55;
  }
  .ico {
    width: 34px;
    height: 34px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 9px;
    font-weight: 600;
    font-size: 12px;
    background: linear-gradient(135deg, var(--chip), var(--hov));
    border: 1px solid var(--chip-line);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nm {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .nm b {
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    color: var(--fa);
    min-width: 0;
  }
  .path {
    flex: 1;
  }
  .when {
    flex: none;
    white-space: nowrap;
  }
  .opening {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: 12px;
    color: var(--mu);
  }
  .rowerr {
    margin: 0 10px 8px 56px;
  }
  .partner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 10px 10px 56px;
  }
  .partner label {
    font-size: 12px;
    color: var(--mu);
    white-space: nowrap;
  }
  .create {
    margin-top: 14px;
    padding: 14px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.14);
    border: 1px solid var(--line);
  }
  .loc {
    flex: 1;
    min-width: 0;
    height: 30px;
    align-items: center;
    padding: 0 9px;
    font-family: var(--font);
    font-size: 12.5px;
  }
</style>
