<script lang="ts">
  // Bottom-center stack of messages from ui.toast(). The store removes them on a timer; this
  // only shows the newest three and lets the user close one or press its action (Undo).
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import { selection } from '../../lib/stores/selection.svelte';
  import { triage } from '../../lib/stores/triage.svelte';
  import { ui, type Toast } from '../../lib/stores/ui.svelte';

  const shown = $derived(ui.toasts.slice(-3));
  // The grid's selection bar sits at the bottom center too (two or more selected): stay above it.
  const lifted = $derived(selection.count >= 2 && !ui.viewer && !triage.session);

  const dismiss = (t: Toast) => (ui.toasts = ui.toasts.filter((x) => x.id !== t.id));

  function act(t: Toast) {
    dismiss(t);
    t.action?.run();
  }
</script>

<div class="stack" class:lifted aria-live="polite">
  {#each shown as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <span class="ico">
        {#if t.kind === 'ok'}<CircleCheck size={16} />
        {:else if t.kind === 'warn'}<TriangleAlert size={16} />
        {:else if t.kind === 'error'}<CircleX size={16} />
        {:else}<Info size={16} />{/if}
      </span>
      <span class="txt">{t.text}</span>
      {#if t.action}<button class="act" onclick={() => act(t)}>{t.action.label}</button>{/if}
      <button class="x" aria-label="Dismiss" onclick={() => dismiss(t)}><X size={13} /></button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    left: 50%;
    bottom: calc(var(--strip-h) + 16px);
    transform: translateX(-50%);
    z-index: 80;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: min(560px, calc(100vw - 32px));
    pointer-events: none;
  }
  .stack.lifted {
    bottom: calc(var(--strip-h) + 72px);
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 6px 8px 6px 12px;
    border-radius: 10px;
    background: rgba(40, 41, 46, 0.96);
    border: 1px solid var(--panel-line);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
    font-size: 12.5px;
    animation: rise 130ms ease-out;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .ico {
    display: grid;
    flex: none;
    color: var(--bl-soft);
  }
  .ok .ico {
    color: var(--ok);
  }
  .warn .ico {
    color: var(--warn);
  }
  .error .ico {
    color: var(--err);
  }
  .txt {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .act {
    flex: none;
    height: 26px;
    padding: 0 10px;
    border-radius: 6px;
    color: var(--link);
    font-weight: 600;
    cursor: pointer;
  }
  .act:hover {
    background: var(--hov);
  }
  .x {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--fa);
    cursor: pointer;
  }
  .x:hover {
    background: var(--hov);
    color: var(--tx);
  }
  button:focus-visible {
    outline: 1px solid var(--bl-soft);
    outline-offset: 1px;
  }
</style>
