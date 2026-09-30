<script lang="ts">
  // Anything the viewer can't show itself: a video Chromium can't play, a Blender file, a zip.
  // Shows the thumbnail when there is one, the facts, and the two ways out.
  import File from '@lucide/svelte/icons/file';
  import FileText from '@lucide/svelte/icons/file-text';
  import Film from '@lucide/svelte/icons/film';
  import Music from '@lucide/svelte/icons/music';
  import Type from '@lucide/svelte/icons/type';
  import type { Item } from '../../../shared/types';
  import { fileSize } from '../../lib/format';
  import { openDefault, reveal } from '../../lib/files';
  import { items } from '../../lib/stores/items.svelte';
  import ImageView from './ImageView.svelte';
  import { viewKind } from '../../lib/fileKinds';
  import type { Bg } from './state.svelte';

  let {
    item,
    message = '',
    bg = 'dark',
    ondblclick,
  }: { item: Item; message?: string; bg?: Bg | 'none'; ondblclick?: () => void } = $props();

  const kind = $derived(viewKind(item.ext));
  const Icon = $derived(
    kind === 'video'
      ? Film
      : kind === 'audio'
        ? Music
        : kind === 'pdf'
          ? FileText
          : kind === 'font'
            ? Type
            : File,
  );
  // Not every item without a thumbnail says so (noThumbnail), so a thumbnail that fails to load
  // also falls back to the type icon. An icon-only item (no Eagle thumbnail) may still have one
  // Boogie drew for it (localThumb, served at the same thumbUrl).
  let thumbBroken = $state(false);
  const hasThumb = $derived(
    !thumbBroken && (!item.noThumbnail || items.brief(item.id)?.localThumb !== false),
  );
</script>

<div class="fp" data-bg={bg}>
  <div class="art">
    {#if hasThumb}
      <ImageView {item} thumbOnly {bg} register bind:broken={thumbBroken} {ondblclick} />
    {:else}
      <span class="big"
        ><Icon size={64} strokeWidth={1.1} /><span class="ext">{item.ext.toUpperCase()}</span></span
      >
    {/if}
  </div>
  <div class="info">
    <div class="name" title={item.name}>{item.name}</div>
    <div class="meta">{item.ext.toUpperCase()} · {fileSize(item.size)}</div>
    {#if message}<p class="msg">{message}</p>{/if}
    <div class="btns">
      <button type="button" class="btn primary" onclick={() => void openDefault(item.id)}
        >Open with default app</button
      >
      <button type="button" class="btn" onclick={() => void reveal(item.id)}
        >Reveal in folder</button
      >
    </div>
  </div>
</div>

<style>
  .fp {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--thumb-bg);
  }
  .art {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
  }
  .art :global(.iv) {
    width: 100%;
    height: 100%;
  }
  .big {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--fa);
  }
  .ext {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
  }
  .info {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 14px 20px 22px;
    text-align: center;
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
  .msg {
    margin: 8px 0 0;
    color: var(--mu);
  }
  .btns {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  .btn {
    height: 30px;
    padding: 0 14px;
    border-radius: var(--radius);
    background: var(--chip);
    border: 1px solid var(--chip-line);
    color: var(--tx);
  }
  .btn:hover {
    background: var(--hov);
  }
  .btn.primary {
    background: var(--bl);
    border-color: var(--bl);
    color: var(--tx);
  }
  .btn.primary:hover {
    filter: brightness(1.1);
  }
  .btn:focus-visible {
    outline: 2px solid var(--bl-soft);
    outline-offset: 2px;
  }
</style>
