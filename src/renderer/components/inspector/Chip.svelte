<script lang="ts">
  // One chip: a tag, a folder, a suggestion or the dashed "add" button. The remove x is always
  // laid out (so hovering never reflows the row) and only shows on hover or keyboard focus.
  import type { Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';

  interface Props {
    label: string;
    lead?: Snippet;
    /** Small faint text after the label, e.g. "2 of 5". */
    sub?: string;
    /** On only some of the selected items. */
    dim?: boolean;
    /** Dashed outline (suggestions, the add button). */
    ghost?: boolean;
    title?: string;
    onclick?: () => void;
    onremove?: () => void;
  }

  let { label, lead, sub, dim = false, ghost = false, title, onclick, onremove }: Props = $props();
</script>

<span class="chip" class:dim class:ghost class:rm={!!onremove}>
  <button type="button" class="main" {title} {onclick} disabled={!onclick}>
    {#if lead}{@render lead()}{/if}
    <span class="lb">{label}</span>
    {#if sub}<span class="sub">{sub}</span>{/if}
  </button>
  {#if onremove}
    <button type="button" class="x" aria-label="Remove {label}" title="Remove" onclick={onremove}
      ><X size={11} /></button
    >
  {/if}
</span>

<style>
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    height: 24px;
    border-radius: 5px;
    background: var(--chip);
    font-size: 12px;
    white-space: nowrap;
  }
  .chip.ghost {
    background: transparent;
    border: 1px dashed var(--chip-line);
    color: var(--mu);
  }
  .chip.dim .main {
    opacity: 0.6;
  }
  .main {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 100%;
    min-width: 0;
    padding: 0 9px;
    border-radius: 5px;
    cursor: default;
  }
  .main:not(:disabled) {
    cursor: pointer;
  }
  .lb {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 10.5px;
    color: var(--fa);
  }
  .rm .main {
    padding-right: 17px;
  }
  /* Sits over the chip's right padding, so showing it never moves the text or reflows the row. */
  .x {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    display: grid;
    place-items: center;
    width: 17px;
    color: var(--mu);
    border-radius: 0 5px 5px 0;
    opacity: 0;
    cursor: pointer;
  }
  .chip:hover .x,
  .x:focus-visible {
    opacity: 1;
  }
  .x:hover {
    color: var(--tx);
  }
</style>
