<script lang="ts">
  // A font: loaded from the file with the FontFace API and shown as sample text at three sizes.
  // The bytes are fetched and handed over as a buffer (no font URL), which is how it also passes
  // the page's font-src rule.
  import { untrack } from 'svelte';
  import type { Item } from '../../../shared/types';
  import { fileSize } from '../../lib/format';
  import { openDefault } from '../../lib/files';

  let { item }: { item: Item } = $props();

  const family = `boogie-preview-${untrack(() => item.id)}`;
  let state = $state<'loading' | 'ready' | 'failed'>('loading');

  $effect(() => {
    let face: FontFace | null = null;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(untrack(() => item.fileUrl));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        face = new FontFace(family, await res.arrayBuffer());
        await face.load();
        if (!live) return;
        document.fonts.add(face);
        state = 'ready';
      } catch {
        if (live) state = 'failed';
      }
    })();
    return () => {
      live = false;
      if (face) document.fonts.delete(face);
    };
  });

  const SIZES = [48, 30, 18];
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const DIGITS = '0123456789  !?&@#$%*()[]{}';
</script>

<div class="fv">
  <header>
    <div class="name" title={item.name}>{item.name}</div>
    <div class="meta">{item.ext.toUpperCase()} · {fileSize(item.size)}</div>
  </header>
  {#if state === 'failed'}
    <div class="msg">
      <p>Couldn’t load this font.</p>
      <button type="button" class="btn" onclick={() => void openDefault(item.id)}
        >Open with default app</button
      >
    </div>
  {:else}
    <div class="sheet" class:ready={state === 'ready'} style="font-family:'{family}', sans-serif">
      <div class="hero">Aa Bb Cc Dd Ee Ff Gg</div>
      {#each SIZES as size (size)}
        <div class="row" style="font-size:{size}px">
          <div>{UPPER}</div>
          <div>{LOWER}</div>
          <div>{DIGITS}</div>
        </div>
      {/each}
      <div class="row" style="font-size:24px">The quick brown fox jumps over the lazy dog.</div>
    </div>
  {/if}
</div>

<style>
  .fv {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--thumb-bg);
    padding: 22px 32px 40px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding-bottom: 14px;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--line);
  }
  .name {
    font-size: 15px;
    font-weight: 600;
  }
  .meta {
    color: var(--fa);
    font-size: 12px;
  }
  .sheet {
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .sheet.ready {
    opacity: 1;
  }
  .hero {
    font-size: 88px;
    line-height: 1.1;
    margin-bottom: 26px;
    overflow-wrap: anywhere;
  }
  .row {
    margin-bottom: 22px;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .msg {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding-top: 80px;
    color: var(--mu);
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
</style>
