<script lang="ts">
  // Shell for every filter popover: a click-away scrim, a titled panel pinned under its anchor, and
  // the shared control styles (segmented buttons, toggles, inputs) the popovers are built from.
  import { onMount, type Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import { enterOverlay } from '../../lib/commands.svelte';
  import { trapTab } from '../../lib/ui/focusTrap';
  import { filterUi, POPOVER_WIDTH } from './filterUi.svelte';
  import type { PopoverKind } from './chips';

  let {
    title,
    kind,
    onclear,
    children,
  }: { title: string; kind: PopoverKind; onclear?: (() => void) | undefined; children: Snippet } =
    $props();

  const w = $derived(POPOVER_WIDTH[kind]);
  const x = $derived(filterUi.open?.x ?? 8);
  const y = $derived(filterUi.open?.y ?? 56);
  let el = $state<HTMLDivElement | null>(null);

  onMount(() => {
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return enterOverlay(); // the grid's number keys must not rate items while you click around here
  });
</script>

<div class="scrim" role="presentation" onmousedown={() => filterUi.close()}></div>
<div
  class="pop"
  role="dialog"
  aria-label={title}
  tabindex="-1"
  bind:this={el}
  onkeydown={(e) => trapTab(e, el)}
  style="left:max(8px, min({x}px, calc(100vw - {w +
    8}px))); top:{y}px; width:{w}px; max-height:calc(100vh - {y + 12}px)"
>
  <header>
    <h3>{title}</h3>
    {#if onclear}<button class="clear" onclick={onclear}>Clear</button>{/if}
    <button class="close" aria-label="Close" onclick={() => filterUi.close()}
      ><X size={14} /></button
    >
  </header>
  <div class="body">{@render children()}</div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 84;
  }
  .pop {
    position: fixed;
    z-index: 85;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    border-radius: 12px;
    box-shadow: var(--shadow-pop);
    animation: pop-in 120ms ease-out;
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 38px;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  h3 {
    margin: 0;
    font-size: 12.5px;
    font-weight: 600;
    flex: 1;
  }
  header button {
    height: 24px;
    padding: 0 8px;
    border-radius: 6px;
    color: var(--mu);
    font-size: 12px;
    display: grid;
    place-items: center;
  }
  header button:hover {
    background: var(--hov);
    color: var(--tx);
  }
  .close {
    width: 24px;
    padding: 0 !important;
  }
  .body {
    padding: 12px 14px 14px;
    overflow: auto;
    min-height: 0;
  }

  /* Controls shared by the popovers. */
  .pop :global(.sub) {
    margin: 12px 0 6px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
  }
  .pop :global(.sub:first-child) {
    margin-top: 0;
  }
  .pop :global(.seg) {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 8px;
    background: var(--fld);
  }
  .pop :global(.seg button) {
    flex: 1;
    height: 26px;
    border-radius: 6px;
    color: var(--mu);
    font-size: 12px;
  }
  .pop :global(.seg button:hover) {
    color: var(--tx);
  }
  .pop :global(.seg button[aria-pressed='true']) {
    background: var(--chip);
    color: var(--tx);
  }
  .pop :global(.grid) {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pop :global(.tog) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid var(--chip-line);
    background: var(--chip);
    color: var(--tx);
    font-size: 12px;
  }
  .pop :global(.tog:hover) {
    border-color: var(--mu);
  }
  .pop :global(.tog[aria-pressed='true']),
  .pop :global(.tog[data-state='inc']) {
    background: var(--bls);
    border-color: var(--bl);
    color: var(--tx);
  }
  .pop :global(.tog[data-state='exc']) {
    background: transparent;
    border-color: var(--err);
    color: var(--err);
    text-decoration: line-through;
  }
  .pop :global(.inp) {
    height: 30px;
    min-width: 0;
    width: 100%;
    padding: 0 9px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
    font-size: 12.5px;
    outline: none;
  }
  .pop :global(.inp:focus-visible),
  .pop :global(.inp:focus) {
    border-color: var(--bl);
  }
  .pop :global(.inp::placeholder) {
    color: var(--fa);
  }
  .pop :global(.pair) {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px;
    color: var(--fa);
    font-size: 12px;
  }
  .pop :global(.lab) {
    display: grid;
    grid-template-columns: 72px 1fr;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--mu);
  }
  .pop :global(.hint) {
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--fa);
  }
  .pop :global(button:focus-visible) {
    outline: 2px solid var(--bl);
    outline-offset: 1px;
  }
</style>
