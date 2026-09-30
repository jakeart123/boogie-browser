<script lang="ts">
  // Pick several folders for a smart folder rule: chips for what's chosen, and a folder search
  // that opens underneath (a library can have thousands of folders, so it never lists them all).
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import { library } from '../../lib/stores/library.svelte';
  import { onEscape } from './escape';
  import FolderSearch from './FolderSearch.svelte';

  let { ids = $bindable([]), disabled = false }: { ids: string[]; disabled?: boolean } = $props();

  let open = $state(false);

  const nameOf = (id: string) => library.folder(id)?.node.name ?? 'Missing folder';

  const toggle = (id: string) =>
    (ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

  $effect(() => {
    if (!open) return;
    return onEscape(() => ((open = false), true));
  });
</script>

<div class="fm">
  <div class="box">
    {#each ids as id (id)}
      <span
        class="dg-chip"
        class:gone={!library.folder(id)}
        title={library.folder(id)?.path.join(' › ')}
        >{nameOf(id)}{#if !disabled}<button
            type="button"
            class="dg-cx"
            aria-label="Remove {nameOf(id)}"
            onclick={() => toggle(id)}><X size={10} /></button
          >{/if}</span
      >
    {/each}
    {#if !disabled}
      <button type="button" class="add" aria-expanded={open} onclick={() => (open = !open)}
        ><Plus size={12} />{ids.length ? 'Add' : 'Pick folders'}</button
      >
    {/if}
  </div>
  {#if open}
    <div class="pick">
      <FolderSearch checked={(id) => ids.includes(id)} onpick={(id) => id && toggle(id)} />
    </div>
  {/if}
</div>

<style>
  .fm {
    min-width: 0;
    flex: 1;
  }
  .box {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: center;
    min-height: 30px;
    padding: 3px 6px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
  }
  .gone {
    color: var(--warn);
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px dashed var(--chip-line);
    color: var(--mu);
    font-size: 11.5px;
    cursor: pointer;
  }
  .add:hover {
    color: var(--tx);
    background: var(--hov);
  }
  .pick {
    margin-top: 4px;
  }
</style>
