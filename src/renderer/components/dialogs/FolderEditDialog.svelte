<script lang="ts">
  // Edit a folder: name, color, icon (Eagle's own icon names), description, auto-tags and its own
  // sort order.
  import { onMount, tick, untrack } from 'svelte';
  import Folder from '@lucide/svelte/icons/folder';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { FOLDER_ICONS, folderIcon } from '../../lib/folderIcons';
  import { api } from '../../lib/api';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import {
    FOLDER_COLORS,
    type FolderColor,
    type FolderPatch,
    type OrderBy,
  } from '../../../shared/types';
  import { errorText, readOnlyTip } from '../../lib/edit';
  import {
    defaultAscending,
    folderSortSpec,
    sortIncreaseFromAscending,
    SORTS,
  } from '../../lib/sorts';
  import Modal from './Modal.svelte';
  import TagField from './TagField.svelte';
  import { quoted } from '../../lib/format';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  // Read once: Dialogs.svelte mounts a fresh component for every openDialog call.
  const args = untrack(() => incoming);

  const id = String(args.id ?? '');
  // Read once: the form must not reset when the tree refreshes underneath it.
  const info = untrack(() => library.folder(id));
  const node = info?.node;

  let name = $state(node?.name ?? '');
  let color = $state<FolderColor | null>(node?.iconColor ?? null);
  let icon = $state<string | null>(node?.icon || null);
  let description = $state(node?.description ?? '');
  let tags = $state<string[]>([...(node?.tags ?? [])]);
  let orderBy = $state<OrderBy | ''>(node?.orderBy ?? '');
  /** Literal direction (the folder stores Eagle's flag; see lib/sorts). */
  const savedAscending = node
    ? (folderSortSpec(node)?.ascending ?? defaultAscending('IMPORT'))
    : false;
  let increase = $state(savedAscending);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let tagsEl = $state<HTMLElement | null>(null);

  // Ctrl+Shift+R ("set auto-tags") opens this dialog straight in the auto-tags field.
  onMount(() => {
    if (args.focus === 'tags') void tick().then(() => tagsEl?.querySelector('input')?.focus());
  });

  const COLORS = Object.entries(FOLDER_COLORS) as [FolderColor, string][];

  const readOnly = $derived(library.readOnly);
  const nameOk = $derived(name.trim().length > 0);
  const suggestions = $derived(library.tags.map((t) => t.name));

  function patch(): FolderPatch {
    if (!node) return {};
    const p: FolderPatch = {};
    const n = name.trim();
    if (n !== node.name) p.name = n;
    if (description !== node.description) p.description = description;
    if (color !== node.iconColor) p.iconColor = color;
    if (icon !== (node.icon || null)) p.icon = icon;
    if (JSON.stringify(tags) !== JSON.stringify(node.tags)) p.tags = [...tags];
    const before = node.orderBy ?? '';
    if (orderBy !== before) p.orderBy = orderBy || null;
    // Manual and random have no direction to pick: they keep Eagle's own order.
    const fixed = orderBy === 'MANUAL' || orderBy === 'RANDOM';
    const ascending = orderBy && fixed ? defaultAscending(orderBy) : increase;
    if (orderBy && (orderBy !== before || ascending !== savedAscending))
      p.sortIncrease = sortIncreaseFromAscending(orderBy, ascending);
    return p;
  }

  async function save(e?: Event) {
    e?.preventDefault();
    if (!node || saving || readOnly || !nameOk) return;
    const p = patch();
    if (!Object.keys(p).length) return ui.closeDialog();
    saving = true;
    error = null;
    try {
      const res = await api.updateFolder(id, p);
      if (res.warning) ui.toast(res.warning, { kind: 'warn' });
      ui.closeDialog();
    } catch (err) {
      error = errorText(err);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  title="Edit folder"
  subtitle={info ? info.path.join(' › ') : undefined}
  width={520}
  backdropClose={false}
>
  {#if !node}
    <div class="dg-empty">This folder doesn’t exist any more.</div>
  {:else}
    <form id="folder-form" onsubmit={save}>
      <div class="dg-field">
        <label class="dg-label" for="f-name">Name</label>
        <input
          id="f-name"
          class="dg-input"
          bind:value={name}
          disabled={readOnly}
          autocomplete="off"
        />
      </div>

      <div class="dg-field">
        <span class="dg-label">Color</span>
        <div class="dg-swatches" role="radiogroup" aria-label="Folder color">
          <button
            type="button"
            class="dg-sw none"
            class:on={color === null}
            role="radio"
            aria-checked={color === null}
            aria-label="No color"
            title="No color"
            disabled={readOnly}
            onclick={() => (color = null)}
          ></button>
          {#each COLORS as [c, hex] (c)}
            <button
              type="button"
              class="dg-sw"
              class:on={color === c}
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              title={c}
              style:background={hex}
              disabled={readOnly}
              onclick={() => (color = c)}
            ></button>
          {/each}
        </div>
      </div>

      <div class="dg-field">
        <span class="dg-label">Icon</span>
        <div class="icons" role="radiogroup" aria-label="Folder icon">
          <button
            type="button"
            class="ic"
            class:on={!icon}
            role="radio"
            aria-checked={!icon}
            title="Plain folder"
            disabled={readOnly}
            onclick={() => (icon = null)}><Folder size={15} /></button
          >
          {#each FOLDER_ICONS as [iconName, Icon] (iconName)}
            <button
              type="button"
              class="ic"
              class:on={icon === iconName}
              role="radio"
              aria-checked={icon === iconName}
              title={iconName}
              disabled={readOnly}
              onclick={() => (icon = iconName)}><Icon size={15} /></button
            >
          {/each}
          {#if icon && !folderIcon(icon)}
            <span class="dg-hint">Uses Eagle’s {quoted(icon)} icon, which Boogie can’t draw.</span>
          {/if}
        </div>
      </div>

      <div class="dg-field">
        <label class="dg-label" for="f-desc">Description</label>
        <textarea
          id="f-desc"
          class="dg-textarea"
          rows="3"
          bind:value={description}
          disabled={readOnly}
          placeholder="Optional"></textarea>
      </div>

      <div class="dg-field" bind:this={tagsEl}>
        <span class="dg-label">Auto-tags</span>
        <TagField
          bind:tags
          {suggestions}
          disabled={readOnly}
          label="Auto-tags"
          placeholder="Add a tag"
        />
        <p class="dg-hint">Items you add to this folder get these tags.</p>
      </div>

      <div class="dg-field">
        <label class="dg-label" for="f-sort">Sort this folder by</label>
        <div class="dg-row">
          <select id="f-sort" class="dg-select" bind:value={orderBy} disabled={readOnly}>
            <option value="">Use the usual sort</option>
            {#each SORTS as o (o.by)}<option value={o.by}>{o.label}</option>{/each}
          </select>
          {#if orderBy && orderBy !== 'RANDOM' && orderBy !== 'MANUAL'}
            <div class="dg-seg" style="flex:none" role="group" aria-label="Sort direction">
              <button
                type="button"
                class:on={increase}
                aria-pressed={increase}
                disabled={readOnly}
                onclick={() => (increase = true)}>Ascending</button
              >
              <button
                type="button"
                class:on={!increase}
                aria-pressed={!increase}
                disabled={readOnly}
                onclick={() => (increase = false)}>Descending</button
              >
            </div>
          {/if}
        </div>
      </div>
      {#if error}<p class="dg-err" style="margin-top:12px">{error}</p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    {#if readOnly}<span class="dg-note">{readOnlyTip()}</span>{/if}
    <span class="dg-sp"></span>
    <button class="dg-btn" onclick={() => ui.closeDialog()}>Cancel</button>
    <button
      class="dg-btn pri"
      type="submit"
      form="folder-form"
      disabled={!node || saving || readOnly || !nameOk}
    >
      {#if saving}<LoaderCircle size={14} class="dg-spin" />{/if}Save
    </button>
  {/snippet}
</Modal>

<style>
  .icons {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .ic {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    color: var(--mu);
  }
  .ic:hover:not(:disabled) {
    background: var(--bls);
    color: var(--tx);
  }
  .ic.on {
    background: var(--bls);
    color: var(--link);
    box-shadow: inset 0 0 0 1px var(--bl);
  }
</style>
