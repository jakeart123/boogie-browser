<script lang="ts">
  // "Subfolders (9)" strip above the items of a folder that has child folders.
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { FolderNode } from '../../../shared/types';
  import { readJSON, writeJSON } from '../../lib/storage';
  import SubfolderCard from './SubfolderCard.svelte';

  let { folders }: { folders: FolderNode[] } = $props();

  const PREF = 'grid.subfoldersCollapsed';
  let collapsed = $state(readJSON(PREF, false));
  let expanded = $state(false);
  let row = $state<HTMLElement>();
  let overflowing = $state(false);

  function toggle() {
    collapsed = !collapsed;
    writeJSON(PREF, collapsed);
  }

  // Show "Show all" only when the single row really is cut off.
  $effect(() => {
    void folders;
    const el = row;
    if (!el) return;
    const check = () => (overflowing = el.scrollWidth > el.clientWidth + 1);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  });
</script>

<section class="subfolders" aria-label="Subfolders">
  <div class="hd">
    <button class="tog" onclick={toggle} aria-expanded={!collapsed}>
      <span class="chev" class:open={!collapsed}><ChevronRight size={13} /></span>
      Subfolders ({folders.length})
    </button>
    {#if !collapsed && (overflowing || expanded)}
      <button class="more" onclick={() => (expanded = !expanded)}
        >{expanded ? 'Show less' : 'Show all'}</button
      >
    {/if}
  </div>
  {#if !collapsed}
    <div class="subs" class:expanded class:fade={overflowing && !expanded} bind:this={row}>
      {#each folders as f (f.id)}<SubfolderCard node={f} />{/each}
    </div>
  {/if}
  <div class="divl"></div>
</section>

<style>
  .hd {
    display: flex;
    align-items: center;
    padding: 14px 18px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--mu);
  }
  .tog {
    display: flex;
    align-items: center;
    gap: 6px;
    color: inherit;
    font-weight: inherit;
  }
  .tog:hover {
    color: var(--tx);
  }
  .chev {
    display: grid;
    transition: transform 120ms ease-out;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .more {
    margin-left: auto;
    font-weight: 400;
    color: var(--fa);
  }
  .more:hover {
    color: var(--tx);
  }
  .subs {
    display: flex;
    gap: 14px;
    padding: 0 18px 6px;
    overflow: hidden;
  }
  .subs.fade {
    -webkit-mask-image: linear-gradient(90deg, black 88%, transparent);
    mask-image: linear-gradient(90deg, black 88%, transparent);
  }
  .subs.expanded {
    flex-wrap: wrap;
    row-gap: 14px;
  }
  .divl {
    height: 1px;
    background: var(--line);
    margin: 12px 18px 0;
  }
</style>
