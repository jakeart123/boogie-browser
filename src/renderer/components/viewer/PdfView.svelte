<script lang="ts">
  // PDF: Electron's built-in viewer in an iframe. The web dev server has no PDF viewer, so it
  // (and anyone who prefers it) gets the rendered preview image instead.
  import type { Item } from '../../../shared/types';
  import { inElectron } from '../../lib/api';
  import { openDefault } from '../../lib/files';
  import ImageView from './ImageView.svelte';
  import type { Bg } from './state.svelte';

  let {
    item,
    flip = false,
    gray = false,
    rotate = 0,
    bg = 'dark',
  }: { item: Item; flip?: boolean; gray?: boolean; rotate?: number; bg?: Bg | 'none' } = $props();

  let asImage = $state(!inElectron);
</script>

<div class="pv">
  {#if asImage}
    <ImageView {item} {flip} {gray} {rotate} {bg} register />
  {:else}
    <iframe
      title={item.name}
      src={item.fileUrl}
      style:filter={gray ? 'grayscale(1)' : undefined}
      style:transform={flip ? 'scaleX(-1)' : undefined}
    ></iframe>
  {/if}
  <div class="tools">
    {#if inElectron}
      <button type="button" onclick={() => (asImage = !asImage)}
        >{asImage ? 'Show PDF viewer' : 'Show preview image'}</button
      >
    {/if}
    <button type="button" onclick={() => void openDefault(item.id)}>Open with default app</button>
  </div>
</div>

<style>
  .pv {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--thumb-bg);
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--thumb-bg);
  }
  .tools {
    position: absolute;
    right: 16px;
    bottom: 14px;
    display: flex;
    gap: 6px;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .pv:hover .tools,
  .tools:focus-within {
    opacity: 1;
  }
  .tools button {
    height: 28px;
    padding: 0 12px;
    border-radius: var(--radius);
    background: var(--panel);
    border: 1px solid var(--panel-line);
    color: var(--tx);
    font-size: 12px;
  }
  .tools button:hover {
    background: var(--hov);
  }
</style>
