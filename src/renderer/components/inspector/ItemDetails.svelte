<script lang="ts">
  // Details of the selection: one item (preview, palette, name, notes, source link, tags, folders,
  // properties) or several (mosaic, shared tags and folders, rating, notes and link for all).
  import { untrack } from 'svelte';
  import LinkIcon from '@lucide/svelte/icons/link';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import type { Item } from '../../../shared/types';
  import { library } from '../../lib/stores/library.svelte';
  import { plural } from '../../lib/format';
  import Field from './Field.svelte';
  import FoldersSection from './FoldersSection.svelte';
  import Mosaic from './Mosaic.svelte';
  import Palette from './Palette.svelte';
  import Preview from './Preview.svelte';
  import Props from './Props.svelte';
  import TagsSection from './TagsSection.svelte';
  import { openLink } from '../../lib/files';
  import { editSelected, restoreItems } from './edit';
  import { commonValue } from './logic';

  let { items, ids: selectedIds }: { items: Item[]; ids: string[] } = $props();

  // The selection this panel was built for. The parent builds a new panel when the selection changes,
  // so this never changes during the panel's life; a save that finishes as the panel is torn down
  // (a field's blur fires when it leaves the page) still goes to the items the user was editing.
  const ids = untrack(() => selectedIds);

  const readonly = $derived(library.readOnly);
  const one = $derived(ids.length === 1 && items.length === 1 ? items[0] : null);
  const trashed = $derived(items.filter((i) => i.isDeleted));
  const notes = $derived(commonValue(items.map((i) => i.annotation)));
  const link = $derived(commonValue(items.map((i) => i.url)));
</script>

{#if trashed.length}
  <div class="trash">
    <span class="msg"
      >{one || trashed.length === items.length
        ? 'In the trash'
        : `${trashed.length} of ${items.length} are in the trash`}</span
    >
    <button type="button" disabled={readonly} onclick={() => restoreItems(trashed.map((i) => i.id))}
      ><RotateCcw size={12} />Restore</button
    >
  </div>
{/if}

{#if one}
  <Preview item={one} />
  <Palette palettes={one.palettes} />
  <Field
    value={one.name}
    label="Name"
    placeholder="Name"
    suffix={one.ext ? `.${one.ext}` : ''}
    {readonly}
    trim
    allowEmpty={false}
    oncommit={(name) => editSelected(ids, { name }, { what: 'rename this item' })}
  />
{:else}
  <Mosaic {items} {ids} />
{/if}

<Field
  value={notes.value}
  mixed={notes.mixed}
  label="Notes"
  placeholder={notes.mixed ? 'Multiple values' : 'Add notes…'}
  emptyText="No notes"
  multiline
  {readonly}
  oncommit={(annotation) =>
    editSelected(
      ids,
      { annotation },
      { what: `replace the notes on ${plural(ids.length, 'item')}`, always: true },
    )}
/>
<Field
  value={link.value}
  mixed={link.mixed}
  label="Source link"
  placeholder={link.mixed ? 'Multiple values' : 'Add a source link'}
  emptyText="No source link"
  {readonly}
  trim
  oncommit={(url) =>
    editSelected(
      ids,
      { url },
      { what: `replace the source link on ${plural(ids.length, 'item')}`, always: true },
    )}
>
  {#snippet lead()}
    <button
      type="button"
      class="lnk"
      disabled={link.mixed || !link.value}
      title={link.value ? `Open ${link.value}` : 'No link to open'}
      aria-label="Open the source link"
      onclick={() => openLink(link.value)}
    >
      <LinkIcon size={13} />
    </button>
  {/snippet}
</Field>

<TagsSection {items} {ids} {readonly} />
<FoldersSection {items} {ids} {readonly} />
<Props {items} {ids} {readonly} />
{#if ids.length > 1}<div class="note count">
    {plural(ids.length, 'item')} selected. Edits apply to all of them.
  </div>{/if}

<style>
  .trash {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    padding: 6px 8px 6px 10px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
    font-size: 12px;
  }
  .msg {
    flex: 1;
  }
  .trash button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border-radius: 5px;
    background: var(--chip);
    color: var(--tx);
    font-size: 11.5px;
    cursor: pointer;
  }
  .trash button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .lnk {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--mu);
    cursor: pointer;
  }
  .lnk:disabled {
    color: var(--fa);
    cursor: default;
  }
  .lnk:not(:disabled):hover {
    color: var(--link);
  }
  .count {
    margin-top: 12px;
  }
</style>
