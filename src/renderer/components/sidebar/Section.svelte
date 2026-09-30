<script lang="ts">
  import type { Snippet } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { sections, type SectionId } from './sections.svelte';

  let {
    id,
    title,
    count = null,
    actions,
    children,
    oncontextmenu,
  }: {
    id: SectionId;
    title: string;
    count?: number | null;
    actions?: Snippet;
    children: Snippet;
    oncontextmenu?: (e: MouseEvent) => void;
  } = $props();
  const open = $derived(sections.open[id]);
</script>

<section class="sb-section" {oncontextmenu} aria-label={title}>
  <div class="sb-sec">
    <button
      class="sb-sec-toggle"
      class:open
      aria-expanded={open}
      onclick={() => sections.toggle(id)}
    >
      <ChevronRight size={12} />
      <span>{title}</span>
      {#if count !== null && count > 0}<span class="n">{count.toLocaleString()}</span>{/if}
    </button>
    {#if actions}<span class="sb-sec-actions">{@render actions()}</span>{/if}
  </div>
  {#if open}{@render children()}{/if}
</section>
