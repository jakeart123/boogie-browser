<script lang="ts">
  // Backdrop + panel for the palette and the pickers. While any modal is open the grid's keys are off
  // (focus.region = 'overlay'), Escape closes the top one, and focus goes back where it was.
  import { onMount, type Snippet } from 'svelte';
  import { enterOverlay, registerCommands } from '../../lib/commands.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { trapTab } from '../../lib/ui/focusTrap';

  let {
    onclose,
    label,
    width = 560,
    top = '14vh',
    children,
  }: {
    onclose: () => void;
    label: string;
    width?: number;
    top?: string;
    children: Snippet;
  } = $props();

  let panel = $state<HTMLDivElement | null>(null);

  /** A held-down Enter acts once: its repeats must not add a tag twice or close the window. */
  function blockHeldEnter(e: KeyboardEvent) {
    if (e.key === 'Enter' && e.repeat) (e.preventDefault(), e.stopPropagation());
  }

  onMount(() => {
    const before = document.activeElement;
    const leave = enterOverlay();
    panel?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const off = registerCommands([
      {
        id: 'overlay.escape',
        anyMode: true,
        title: 'Close',
        hidden: true,
        keys: ['Escape'],
        allowInInput: true,
        priority: 20,
        run: () => onclose(),
      },
    ]);
    return () => {
      off();
      leave();
      const now = document.activeElement;
      const lost = !now || now === document.body || panel?.contains(now);
      if (lost && before instanceof HTMLElement && document.contains(before)) before.focus();
    };
  });
</script>

<!-- Dialogs (a bulk-edit confirm, say) sit below this layer, so step aside while one is open. -->
<div
  class="scrim"
  class:under={!!ui.dialog}
  role="presentation"
  onmousedown={(e) => e.target === e.currentTarget && onclose()}
>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label={label}
    tabindex="-1"
    bind:this={panel}
    style="width:min({width}px, calc(100vw - 32px)); top:{top}"
    onkeydown={(e) => trapTab(e, panel)}
    onkeydowncapture={blockHeldEnter}
  >
    {@render children()}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: var(--scrim);
    animation: fade 100ms ease-out;
  }
  .scrim.under {
    visibility: hidden;
  }
  .panel {
    outline: none;
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    max-height: calc(100vh - 14vh - 24px);
    display: flex;
    flex-direction: column;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
