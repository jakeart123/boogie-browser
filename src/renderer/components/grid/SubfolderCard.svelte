<script lang="ts">
  // One subfolder card: a mosaic of up to three thumbnails, the folder's name and its count.
  import Folder from '@lucide/svelte/icons/folder';
  import { FOLDER_COLORS, type FolderNode } from '../../../shared/types';
  import { folderIcon } from '../../lib/folderIcons';
  import { items } from '../../lib/stores/items.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { mosaics } from './mosaic.svelte';

  let { node }: { node: FolderNode } = $props();

  let seen = $state(false);
  // The folder's cover (set in Eagle or with "Use as folder cover") leads the mosaic.
  const ids = $derived.by(() => {
    const first = mosaics.ids(node.id) ?? [];
    const cover = node.coverId;
    return cover ? [cover, ...first.filter((x) => x !== cover)].slice(0, 3) : first;
  });
  $effect(() => {
    if (seen && node.coverId) items.ensure([node.coverId]);
  });
  const thumbs = $derived(
    ids.map((id) => items.brief(id)?.thumbUrl).filter((u): u is string => !!u),
  );
  const count = $derived(library.counts?.folders[node.id]?.deep);
  const color = $derived(node.iconColor ? FOLDER_COLORS[node.iconColor] : 'var(--mu)');
  const Icon = $derived(folderIcon(node.icon));

  // Fetch the mosaic only once the card has been on screen.
  function visible(el: HTMLElement) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true;
        io.disconnect();
      }
    });
    io.observe(el);
    return { destroy: () => io.disconnect() };
  }
  $effect(() => {
    if (seen) mosaics.ensure(node.id);
  });

  function open() {
    view.setScope({ kind: 'folder', id: node.id, includeSubfolders: view.showSubfolderContents });
  }
</script>

<button class="subf" use:visible onclick={open} title={node.name}>
  <div class="mos n{thumbs.length}">
    {#each thumbs as url (url)}<img src={url} alt="" decoding="async" draggable="false" />{/each}
  </div>
  <div class="l">
    {#if Icon}<Icon size={14} {color} strokeWidth={2} />{:else}<Folder
        size={14}
        {color}
        fill={color}
        strokeWidth={1.5}
      />{/if}
    <span class="name">{node.name}</span>
    {#if count !== undefined}<span class="ct">{count.toLocaleString()}</span>{/if}
  </div>
</button>

<style>
  .subf {
    flex: none;
    width: 168px;
    text-align: left;
  }
  .mos {
    height: 112px;
    border-radius: 7px;
    overflow: hidden;
    background: var(--chip);
    border: 1px solid var(--line);
    display: grid;
    grid-template-columns: 2fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 2px;
  }
  .subf:hover .mos {
    border-color: var(--chip-line);
  }
  .mos img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    min-height: 0;
    min-width: 0;
  }
  .mos img:first-child {
    grid-row: span 2;
  }
  .n1 img {
    grid-column: span 2;
  }
  .n2 img:nth-child(2) {
    grid-row: span 2;
  }
  .l {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
    font-size: 12px;
    white-space: nowrap;
  }
  .l :global(svg) {
    flex: none;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ct {
    flex: none;
    margin-left: auto;
    font-size: 11px;
    color: var(--fa);
    font-variant-numeric: tabular-nums;
  }
</style>
