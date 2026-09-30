<script lang="ts">
  // Audio: a card with the waveform thumbnail (when Eagle made one) and the same controls as video.
  import { untrack } from 'svelte';
  import Music from '@lucide/svelte/icons/music';
  import type { Item } from '../../../shared/types';
  import { fileSize } from '../../lib/format';
  import MediaBar from './MediaBar.svelte';

  let {
    item,
    autoplay = true,
    onended,
  }: { item: Item; autoplay?: boolean; onended?: () => void } = $props();

  const src = untrack(() => item.fileUrl);
  let a = $state<HTMLAudioElement>();
  let art = $state(!untrack(() => item.noThumbnail));
</script>

<div class="ap">
  <div class="card">
    {#if art}
      <img src={item.thumbUrl} alt="" onerror={() => (art = false)} />
    {:else}
      <span class="icon"><Music size={56} strokeWidth={1.1} /></span>
    {/if}
    <div class="name" title={item.name}>{item.name}</div>
    <div class="meta">{item.ext.toUpperCase()} · {fileSize(item.size)}</div>
  </div>
  <audio bind:this={a} {src} {autoplay} preload="metadata" {onended}></audio>
  <MediaBar media={a} video={false} />
</div>

<style>
  .ap {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--thumb-bg);
  }
  .card {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 20px;
  }
  img {
    max-width: min(560px, 80%);
    max-height: 45%;
    border-radius: var(--radius);
    background: var(--fld);
    margin-bottom: 10px;
  }
  .icon {
    color: var(--fa);
    margin-bottom: 8px;
  }
  .name {
    max-width: 640px;
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--fa);
    font-size: 12px;
  }
</style>
