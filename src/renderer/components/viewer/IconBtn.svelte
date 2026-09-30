<script lang="ts">
  // The square icon button used in the viewer's top bars.
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    title?: string;
    on?: boolean;
    /** Sets aria-pressed too (a toggle). */
    toggle?: boolean;
    disabled?: boolean;
    onclick: (e: MouseEvent) => void;
    children: Snippet;
  }
  let {
    label,
    title,
    on = false,
    toggle = false,
    disabled = false,
    onclick,
    children,
  }: Props = $props();
</script>

<button
  type="button"
  class="ib"
  class:on
  aria-label={label}
  aria-pressed={toggle ? on : undefined}
  title={title ?? label}
  {disabled}
  {onclick}
>
  {@render children()}
</button>

<style>
  .ib {
    flex: none;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: var(--radius);
    color: var(--mu);
  }
  .ib:hover:not(:disabled) {
    background: var(--hov);
    color: var(--tx);
  }
  .ib.on {
    color: var(--bl-soft);
    background: var(--bls);
  }
  .ib:disabled {
    color: var(--fa);
    opacity: 0.5;
  }
  .ib:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: -2px;
  }
</style>
