<script lang="ts">
  // Ctrl+K / Ctrl+F. Renders the palette while ui.overlay is 'command'; each opening is a fresh
  // Palette (keyed on the overlay object) so Ctrl+F while it is open restarts it with the keywords.
  import { ui } from '../../lib/stores/ui.svelte';
  import Palette from './Palette.svelte';

  const overlay = $derived(ui.overlay);
  const initial = (arg: unknown): string => {
    const text = (arg as { text?: unknown } | undefined)?.text;
    return typeof text === 'string' ? text : '';
  };
</script>

{#if overlay?.kind === 'command'}
  {#key overlay}
    <Palette initial={initial(overlay.arg)} onclose={() => ui.closeOverlay()} />
  {/key}
{/if}
