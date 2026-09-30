<script lang="ts">
  // The tag manager's right side: tag groups. Drop a tag on a group to move it there (Alt keeps
  // it in its other groups too); name, color, describe or delete a group in place.
  import Plus from '@lucide/svelte/icons/plus';
  import Trash from '@lucide/svelte/icons/trash';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import { api } from '../../lib/api';
  import { readOnlyTip, toastWithUndo } from '../../lib/edit';
  import { library } from '../../lib/stores/library.svelte';
  import { groupColor as hex } from '../../lib/tags';
  import { FOLDER_COLORS, type TagGroup } from '../../../shared/types';
  import { onEscape } from './escape';
  import type { TagEdits } from './tagEdits';
  import { TAG_MIME } from './tagManager';
  import { quoted } from '../../lib/format';

  let { edits }: { edits: TagEdits } = $props();

  const groups = $derived(library.state?.tagGroups ?? []);
  const readOnly = $derived(library.readOnly);
  const lockTip = $derived(readOnly ? readOnlyTip() : undefined);
  // A running Eagle on the partner's computer never reloads tag groups (and may undo them).
  const partner = $derived(library.current?.partnerName?.trim() || '');

  // One thing is edited at a time. `groupName.id` is 'new' for a new group.
  let groupName = $state<{ id: string; value: string } | null>(null);
  let descFor = $state<{ id: string; value: string } | null>(null);
  let colorFor = $state<string | null>(null);
  let deletingGroup = $state<string | null>(null);
  let dragOver = $state<string | null>(null);

  $effect(() => {
    if (!groupName && !colorFor && !deletingGroup && !descFor) return;
    return onEscape(() => {
      if (descFor) descFor = null;
      else if (groupName) groupName = null;
      else if (colorFor) colorFor = null;
      else deletingGroup = null;
      return true;
    });
  });

  async function commitGroupName() {
    if (!groupName) return;
    const { id, value } = groupName;
    const name = value.trim();
    groupName = null;
    if (!name) return;
    if (id === 'new') await edits.run(() => api.upsertTagGroup({ name, tags: [], color: null }));
    else {
      const g = groups.find((x) => x.id === id);
      if (g && g.name !== name) await edits.saveGroups([{ ...g, name }]);
    }
  }

  async function commitDesc() {
    if (!descFor) return;
    const { id, value } = descFor;
    descFor = null;
    const g = groups.find((x) => x.id === id);
    if (g && g.description !== value.trim())
      await edits.saveGroups([{ ...g, description: value.trim() }]);
  }

  async function setColor(g: TagGroup, color: string | null) {
    colorFor = null;
    if (color !== g.color) await edits.saveGroups([{ ...g, color }]);
  }

  async function removeGroup(g: TagGroup) {
    deletingGroup = null;
    const res = await edits.run(() => api.deleteTagGroup(g.id));
    if (res) toastWithUndo(`Deleted group ${quoted(g.name)}`, res.groupId);
  }

  function drop(e: DragEvent, g: TagGroup) {
    e.preventDefault();
    dragOver = null;
    const tag = e.dataTransfer?.getData(TAG_MIME);
    if (tag && !readOnly) void edits.addToGroup(tag, g.id, e.altKey);
  }
</script>

<div class="tools">
  <h3>Groups</h3>
  <button
    class="dg-btn sm"
    disabled={readOnly}
    title={lockTip}
    onclick={() => (groupName = { id: 'new', value: '' })}><Plus size={13} />New group</button
  >
</div>
<div class="dg-note-box">
  <TriangleAlert size={14} />
  <span
    >Tag groups don’t reach Eagle on {partner ? `${partner}’s` : 'your partner’s'} computer while it’s
    open, and it may undo them.</span
  >
</div>
<p class="dg-hint" style="margin:8px 0">
  Drag a tag onto a group. It leaves its other groups unless you hold Alt.
</p>

{#if groupName?.id === 'new'}
  <form class="gname" onsubmit={(e) => (e.preventDefault(), commitGroupName())}>
    <input
      class="dg-input"
      aria-label="Group name"
      placeholder="Group name"
      bind:value={groupName.value}
      data-autofocus
      autocomplete="off"
    />
    <button class="dg-btn sm pri" type="submit">Add</button>
    <button class="dg-btn sm" type="button" onclick={() => (groupName = null)}>Cancel</button>
  </form>
{/if}

<ul class="groups">
  {#each groups as g (g.id)}
    <li
      class="grp"
      class:over={dragOver === g.id}
      ondragover={(e) => (e.preventDefault(), (dragOver = g.id))}
      ondragleave={() => dragOver === g.id && (dragOver = null)}
      ondrop={(e) => drop(e, g)}
    >
      <div class="gh">
        <button
          class="dot"
          style:background={hex(g.color) ?? 'transparent'}
          aria-label="Color for {g.name}"
          title={lockTip ?? 'Color'}
          disabled={readOnly}
          onclick={() => (colorFor = colorFor === g.id ? null : g.id)}
        ></button>
        {#if groupName?.id === g.id}
          <form class="gname" onsubmit={(e) => (e.preventDefault(), commitGroupName())}>
            <input
              class="dg-input"
              aria-label="Group name"
              bind:value={groupName.value}
              data-autofocus
              autocomplete="off"
            />
            <button class="dg-btn sm pri" type="submit">Save</button>
          </form>
        {:else}
          <button
            class="gn"
            title={lockTip ?? 'Rename group'}
            disabled={readOnly}
            onclick={() => (groupName = { id: g.id, value: g.name })}>{g.name}</button
          >
          <span class="ct">{g.tags.length}</span>
          <button
            class="dg-ib"
            aria-label="Delete group {g.name}"
            title={lockTip ?? 'Delete group'}
            disabled={readOnly}
            onclick={() => (deletingGroup = g.id)}><Trash size={13} /></button
          >
        {/if}
      </div>
      {#if descFor?.id === g.id}
        <form class="gname" onsubmit={(e) => (e.preventDefault(), commitDesc())}>
          <input
            class="dg-input"
            aria-label="Description of {g.name}"
            placeholder="What this group is for"
            bind:value={descFor.value}
            data-autofocus
            autocomplete="off"
          />
          <button class="dg-btn sm pri" type="submit">Save</button>
        </form>
      {:else if g.description || !readOnly}
        <button
          class="gdesc"
          class:empty={!g.description}
          title={lockTip ?? 'Edit description'}
          disabled={readOnly}
          onclick={() => (descFor = { id: g.id, value: g.description })}
          >{g.description || 'Add a description'}</button
        >
      {/if}
      {#if colorFor === g.id}
        <div class="dg-swatches sw">
          <button
            type="button"
            class="dg-sw none"
            class:on={g.color === null}
            aria-label="No color"
            onclick={() => setColor(g, null)}
          ></button>
          {#each Object.entries(FOLDER_COLORS) as [c, h] (c)}
            <button
              type="button"
              class="dg-sw"
              class:on={g.color === c}
              style:background={h}
              aria-label={c}
              title={c}
              onclick={() => setColor(g, c)}
            ></button>
          {/each}
        </div>
      {/if}
      {#if deletingGroup === g.id}
        <div class="dg-note-box inl" role="alert">
          <TriangleAlert size={14} />
          <div>
            Delete the group {quoted(g.name)}? The tags stay on your items.
            <div class="dg-row" style="margin-top:6px">
              <button class="dg-btn sm danger" onclick={() => removeGroup(g)}>Delete group</button>
              <button class="dg-btn sm" onclick={() => (deletingGroup = null)}>Cancel</button>
            </div>
          </div>
        </div>
      {/if}
      <div class="gt">
        {#each g.tags as t (t)}
          <span class="dg-chip"
            >{t}{#if !readOnly}<button
                class="dg-cx"
                aria-label="Remove {t} from {g.name}"
                onclick={() => edits.removeFromGroup(t, g)}><X size={10} /></button
              >{/if}</span
          >
        {:else}
          <span class="dg-hint">Drop tags here</span>
        {/each}
      </div>
    </li>
  {:else}
    <li class="none">No groups yet.</li>
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
  h3 {
    margin: 0;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
    flex: 1;
  }
  .groups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .grp {
    padding: 8px 10px 10px;
    border-radius: 9px;
    border: 1px dashed var(--line);
    background: rgba(0, 0, 0, 0.1);
    transition:
      border-color 100ms ease-out,
      background 100ms ease-out;
  }
  .grp.over {
    border-color: var(--bl);
    background: var(--bls);
  }
  .gh {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .gn {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-weight: 600;
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
    border-radius: 4px;
  }
  .ct {
    color: var(--fa);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex: none;
    border: 1px solid var(--fa);
    cursor: pointer;
  }
  .gdesc {
    display: block;
    margin: 4px 0 0 22px;
    text-align: left;
    font-size: 12px;
    color: var(--mu);
    cursor: text;
  }
  .gdesc.empty {
    color: var(--fa);
  }
  .gname {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
    flex: 1;
    min-width: 0;
  }
  .sw {
    margin: 8px 0 2px;
  }
  .gt {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
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
