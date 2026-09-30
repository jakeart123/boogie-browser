<script lang="ts">
  // The tag manager's left side: every tag with its count, a search, and per tag: star, rename
  // (merging when the name exists), groups and delete. Confirmations are inline.
  import Layers from '@lucide/svelte/icons/layers';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Search from '@lucide/svelte/icons/search';
  import Star from '@lucide/svelte/icons/star';
  import Tag from '@lucide/svelte/icons/tag';
  import Trash from '@lucide/svelte/icons/trash';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { api } from '../../lib/api';
  import { openContextMenu, type MenuItem } from '../../lib/contextMenu.svelte';
  import { readOnlyTip, toastWithUndo } from '../../lib/edit';
  import { plural, quoted } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import {
    followTagInTriageKeys,
    groupColor as hex,
    isStarred,
    renameTarget,
    setStarred,
  } from '../../lib/tags';
  import { onEscape } from './escape';
  import type { TagEdits } from './tagEdits';
  import { TAG_MIME, visibleTags, type TagSort } from './tagManager';

  let { edits }: { edits: TagEdits } = $props();

  let query = $state('');
  let sort = $state<TagSort>('name');
  const tags = $derived(visibleTags(library.tags, query, sort));
  const groups = $derived(library.state?.tagGroups ?? []);
  const readOnly = $derived(library.readOnly);
  const lockTip = $derived(readOnly ? readOnlyTip() : undefined);

  // One tag is edited at a time: renamed, or asked about before deleting.
  let renaming = $state<{ from: string; value: string; mergeCount: number | null } | null>(null);
  let deleting = $state<string | null>(null);

  $effect(() => {
    if (!renaming && !deleting) return;
    return onEscape(() => {
      if (renaming) renaming = null;
      else deleting = null;
      return true;
    });
  });

  function startRename(name: string) {
    if (readOnly) return;
    deleting = null;
    renaming = { from: name, value: name, mergeCount: null };
  }

  async function commitRename(confirmed = false) {
    if (!renaming) return;
    const { from } = renaming;
    const to = renameTarget(from, renaming.value);
    if (!to || to === from) return void (renaming = null);
    const clash = library.tags.find((t) => t.name === to);
    if (clash && !confirmed) return void (renaming = { ...renaming, mergeCount: clash.count });
    renaming = null;
    const res = await edits.run(() => api.renameTag(from, to));
    if (!res) return;
    followTagInTriageKeys(from, to);
    toastWithUndo(
      clash
        ? `Merged ${quoted(from)} into ${quoted(to)}`
        : `Renamed ${quoted(from)} to ${quoted(to)}`,
      res.groupId,
    );
  }

  async function confirmDelete(name: string) {
    deleting = null;
    const res = await edits.run(() => api.deleteTag(name));
    if (!res) return;
    followTagInTriageKeys(name, null);
    toastWithUndo(`Deleted tag ${quoted(name)}`, res.groupId);
  }

  const toggleStar = (name: string) => setStarred([name], !isStarred(name));

  function tagMenu(e: MouseEvent, name: string) {
    if (readOnly) return;
    const inGroups = groups.filter((g) => g.tags.includes(name));
    const items: MenuItem[] = [
      { label: isStarred(name) ? 'Unstar' : 'Star', run: () => toggleStar(name) },
      { label: 'Rename', run: () => startRename(name) },
      {
        label: 'Add to group',
        disabled: !groups.length,
        submenu: groups.map((g) => ({
          label: g.name,
          checked: g.tags.includes(name),
          run: () => edits.addToGroup(name, g.id),
        })),
      },
      ...inGroups.map((g): MenuItem => ({
        label: `Remove from ${quoted(g.name)}`,
        run: () => edits.removeFromGroup(name, g),
      })),
      { separator: true },
      {
        label: 'Delete tag…',
        danger: true,
        run: () => void ((renaming = null), (deleting = name)),
      },
    ];
    openContextMenu(e, items);
  }

  function dragStart(e: DragEvent, name: string) {
    if (readOnly || !e.dataTransfer) return e.preventDefault();
    e.dataTransfer.setData(TAG_MIME, name);
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.effectAllowed = 'copyMove';
  }
</script>

<div class="tools">
  <label class="search">
    <Search size={14} />
    <input
      placeholder="Search {library.tags.length.toLocaleString()} tags"
      aria-label="Search tags"
      bind:value={query}
      autocomplete="off"
      data-autofocus
    />
  </label>
  <div class="dg-seg" role="group" aria-label="Sort tags">
    <button
      class:on={sort === 'name'}
      aria-pressed={sort === 'name'}
      onclick={() => (sort = 'name')}>A to Z</button
    >
    <button
      class:on={sort === 'count'}
      aria-pressed={sort === 'count'}
      onclick={() => (sort = 'count')}>Most used</button
    >
  </div>
</div>

<ul class="tags">
  {#each tags as t (t.name)}
    {@const gs = groups.filter((g) => g.tags.includes(t.name))}
    <li class:editing={renaming?.from === t.name || deleting === t.name}>
      {#if renaming?.from === t.name}
        <form class="rn" onsubmit={(e) => (e.preventDefault(), commitRename())}>
          <input
            class="dg-input"
            aria-label="New name for {t.name}"
            bind:value={renaming.value}
            data-autofocus
            autocomplete="off"
            oninput={() => renaming && (renaming.mergeCount = null)}
          />
          <button class="dg-btn sm pri" type="submit">Rename</button>
          <button class="dg-btn sm" type="button" onclick={() => (renaming = null)}>Cancel</button>
        </form>
        {#if renaming.mergeCount !== null}
          <div class="dg-note-box inl" role="alert">
            <TriangleAlert size={14} />
            <div>
              {quoted(renameTarget(renaming.from, renaming.value))} already exists. Merging gives it to
              every item tagged {quoted(t.name)}, {plural(t.count, 'item')} in all.
              <div class="dg-row" style="margin-top:6px">
                <button class="dg-btn sm pri" type="button" onclick={() => commitRename(true)}
                  >Merge tags</button
                >
                <button class="dg-btn sm" type="button" onclick={() => (renaming = null)}
                  >Cancel</button
                >
              </div>
            </div>
          </div>
        {/if}
      {:else}
        <div
          class="row"
          role="presentation"
          draggable={!readOnly}
          ondragstart={(e) => dragStart(e, t.name)}
          ondblclick={() => startRename(t.name)}
          oncontextmenu={(e) => tagMenu(e, t.name)}
        >
          <Tag size={13} class="ti" />
          <span class="nm" title={t.name}>{t.name}</span>
          {#if isStarred(t.name)}<Star size={12} class="st" aria-label="Starred" />{/if}
          {#each gs.slice(0, 3) as g (g.id)}<span
              class="gd"
              style:background={hex(g.color) ?? 'var(--fa)'}
              title="In group {g.name}"
            ></span>{/each}
          <span class="ct">{t.count.toLocaleString()}</span>
          <span class="acts">
            <button
              class="dg-ib"
              aria-label="{isStarred(t.name) ? 'Unstar' : 'Star'} {t.name}"
              title={lockTip ?? (isStarred(t.name) ? 'Unstar' : 'Star')}
              disabled={readOnly}
              onclick={() => toggleStar(t.name)}><Star size={13} /></button
            >
            <button
              class="dg-ib"
              aria-label="Rename {t.name}"
              title={lockTip ?? 'Rename'}
              disabled={readOnly}
              onclick={() => startRename(t.name)}><Pencil size={13} /></button
            >
            <button
              class="dg-ib"
              aria-label="Groups for {t.name}"
              title={lockTip ?? 'Groups'}
              disabled={readOnly}
              onclick={(e) => tagMenu(e, t.name)}><Layers size={13} /></button
            >
            <button
              class="dg-ib"
              aria-label="Delete {t.name}"
              title={lockTip ?? 'Delete'}
              disabled={readOnly}
              onclick={() => ((renaming = null), (deleting = t.name))}><Trash size={13} /></button
            >
          </span>
        </div>
      {/if}
      {#if deleting === t.name}
        <div class="dg-note-box inl" role="alert">
          <TriangleAlert size={14} />
          <div>
            Remove {quoted(t.name)} from {plural(t.count, 'item')}? The items stay.
            <div class="dg-row" style="margin-top:6px">
              <button class="dg-btn sm danger" onclick={() => confirmDelete(t.name)}
                >Delete tag</button
              >
              <button class="dg-btn sm" onclick={() => (deleting = null)}>Cancel</button>
            </div>
          </div>
        </div>
      {/if}
    </li>
  {:else}
    <li class="none">
      {library.tags.length ? 'No tags match.' : 'No tags yet. Add some from the inspector.'}
    </li>
  {/each}
</ul>

<style>
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex: none;
  }
  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 9px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
    color: var(--fa);
  }
  .search:focus-within {
    border-color: var(--bl-soft);
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: none;
    font-size: 12.5px;
  }
  .search input:focus-visible {
    outline: none;
  }
  .tags {
    list-style: none;
    margin: 0 -6px 0 0;
    padding: 0 6px 0 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .tags li {
    content-visibility: auto;
    contain-intrinsic-size: auto 30px;
  }
  .tags li.editing {
    content-visibility: visible;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 6px 0 8px;
    border-radius: 6px;
    cursor: grab;
    font-size: 12.5px;
  }
  .row:hover {
    background: var(--hov);
  }
  .row :global(.ti) {
    color: var(--fa);
    flex: none;
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row :global(.st) {
    color: var(--star);
    fill: currentColor;
    flex: none;
  }
  .ct {
    color: var(--fa);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .gd {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .acts {
    display: none;
    gap: 0;
    flex: none;
  }
  .row:hover .acts,
  .row:focus-within .acts {
    display: flex;
  }
  .row:hover .ct,
  .row:focus-within .ct {
    display: none;
  }
  .rn {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
  }
  .inl {
    margin: 4px 0 6px;
  }
  .none {
    padding: 22px 8px;
    text-align: center;
    color: var(--fa);
    font-size: 12.5px;
  }
</style>
