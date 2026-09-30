<script lang="ts">
  // The folder you are looking at with nothing selected: its color, description and auto-tags are
  // edited here. Built for one folder id; the parent makes a new one when the folder changes.
  import { untrack } from 'svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import { openMenuBelow } from '../../lib/contextMenu.svelte';
  import { folderSortLabel, folderSortMenu } from '../../lib/sorts';
  import { library } from '../../lib/stores/library.svelte';
  import { FOLDER_COLORS, type FolderColor } from '../../../shared/types';
  import Chip from './Chip.svelte';
  import Field from './Field.svelte';
  import TagInput from './TagInput.svelte';
  import { editFolder } from './edit';
  import { folderColor } from './logic';

  let { id: folderId }: { id: string } = $props();
  // Fixed for this panel's life, so a save that lands as the panel is torn down goes to this folder.
  const id = untrack(() => folderId);

  const readonly = $derived(library.readOnly);
  const counts = $derived(library.counts?.folders[id]);
  const info = $derived(library.folder(id));
  const node = $derived(info?.node);

  const sortText = $derived(node ? folderSortLabel(node) : '');

  const autoTags = $derived(new Set(node?.tags ?? []));
  const colorNames = Object.keys(FOLDER_COLORS) as FolderColor[];
</script>

{#if node}
  <div class="head">
    <span class="fd" style:color={folderColor(node.iconColor)}
      ><Folder size={18} fill="currentColor" strokeWidth={1.5} /></span
    >
    <h3 title={node.name}>{node.name}</h3>
  </div>
  {#if info && info.path.length > 1}<div class="note path">
      {info.path.slice(0, -1).join(' \u203a ')}
    </div>{/if}

  <div class="lbl">Color</div>
  <div class="colors" role="group" aria-label="Folder color">
    {#each colorNames as c (c)}
      <button
        type="button"
        class="dot"
        class:on={node.iconColor === c}
        style:background={FOLDER_COLORS[c]}
        disabled={readonly}
        aria-label={c}
        aria-pressed={node.iconColor === c}
        title={node.iconColor === c ? `${c} (click to clear)` : c}
        onclick={() => editFolder(id, { iconColor: node.iconColor === c ? null : c })}
      ></button>
    {/each}
  </div>

  <div class="lbl">Description</div>
  <Field
    value={node.description}
    label="Folder description"
    placeholder="Add a description…"
    emptyText="No description"
    multiline
    {readonly}
    oncommit={(description) => editFolder(id, { description })}
  />

  <div class="lbl">Auto-tags<span class="r">added to items you put here</span></div>
  <div class="chips">
    {#each node.tags as t (t)}
      <Chip
        label={t}
        onremove={readonly
          ? undefined
          : () => editFolder(id, { tags: node.tags.filter((x) => x !== t) })}
      />
    {/each}
  </div>
  {#if !node.tags.length && readonly}<div class="note">None</div>{/if}
  {#if !readonly}
    <TagInput
      known={autoTags}
      frequent={[]}
      placeholder="Add an auto-tag"
      hint=""
      onadd={(names) => editFolder(id, { tags: [...node.tags, ...names] })}
      onremovelast={() => node.tags.length && editFolder(id, { tags: node.tags.slice(0, -1) })}
    />
  {/if}

  <dl class="props">
    <div>
      <dt>Items</dt>
      <dd>{(counts?.own ?? 0).toLocaleString()}</dd>
    </div>
    {#if node.children.length}<div>
        <dt>With subfolders</dt>
        <dd>{(counts?.deep ?? 0).toLocaleString()}</dd>
      </div>{/if}
    <div>
      <dt>Sort</dt>
      <dd>
        {#if readonly}{sortText}{:else}<button
            type="button"
            class="sort"
            title="Change how this folder sorts"
            aria-haspopup="menu"
            onclick={(e) => node && openMenuBelow(e.currentTarget, folderSortMenu(node))}
            >{sortText}<ChevronDown size={12} /></button
          >{/if}
      </dd>
    </div>
  </dl>
{:else}
  <div class="note">This folder no longer exists.</div>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .fd {
    display: inline-grid;
    color: var(--mu);
    flex: none;
  }
  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path {
    margin: 2px 0 0 27px;
  }
  .colors {
    display: flex;
    gap: 7px;
  }
  .dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  .dot.on {
    box-shadow:
      0 0 0 2px var(--side),
      0 0 0 3.5px var(--tx);
  }
  .dot:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .props {
    border-top: 1px solid var(--line);
    margin: 16px 0 0;
    padding-top: 4px;
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
  .sort {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 6px;
    margin-right: -4px;
    border-radius: 5px;
    color: var(--tx);
    font-size: 12px;
    cursor: pointer;
  }
  .sort:hover {
    background: var(--hov);
  }
  .sort :global(svg) {
    color: var(--fa);
  }
</style>
