<script lang="ts">
  // The frame every dialog shares: backdrop, panel, header, footer. Handles Escape, a focus trap,
  // returning focus when it closes, and telling the shortcut system a dialog has focus.
  import { onMount, type Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import { enterMode, focus, registerCommands } from '../../lib/commands.svelte';
  import { contextMenu } from '../../lib/contextMenu.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { trapTab } from '../../lib/ui/focusTrap';
  import { runEscapeHandlers } from './escape';
  import './dialogs.css';

  let {
    title,
    subtitle,
    width = 560,
    dismissable = true,
    backdropClose = true,
    onclose,
    children,
    footer,
    headerExtra,
  }: {
    title: string;
    subtitle?: string;
    width?: number;
    /** False for the startup library picker: nothing closes it except opening a library. */
    dismissable?: boolean;
    /** Clicking outside closes. Turn off for forms so a stray click can't lose typing. */
    backdropClose?: boolean;
    onclose?: () => void;
    children: Snippet;
    footer?: Snippet;
    headerExtra?: Snippet;
  } = $props();

  const uid = Math.random().toString(36).slice(2, 8);
  let panel = $state<HTMLDivElement | null>(null);

  function close() {
    if (!dismissable) return;
    if (onclose) onclose();
    else ui.closeDialog();
  }

  onMount(() => {
    const before = focus.region;
    const returnTo = document.activeElement as HTMLElement | null;
    focus.region = 'dialog';
    // A dialog owns the keyboard: nothing behind it (grid, viewer, Triage) acts on a key.
    const leaveMode = enterMode('dialog', () => false);
    // First field or button, unless a component marked one with data-autofocus.
    const first =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>(
        '.dg-body input:not([type=hidden]):not(:disabled), .dg-body textarea:not(:disabled)',
      ) ??
      null;
    (first ?? panel)?.focus();
    const off = registerCommands([
      {
        id: 'dialog.close',
        anyMode: true,
        title: 'Close dialog',
        keys: ['Escape'],
        allowInInput: true,
        priority: 100,
        hidden: true,
        // A right-click menu open over the dialog gets Escape first (it listens on its own).
        when: () => !contextMenu.open,
        run: () => {
          if (!runEscapeHandlers()) close();
        },
      },
    ]);
    return () => {
      off();
      leaveMode();
      focus.region = before === 'dialog' ? 'grid' : before;
      if (returnTo?.isConnected) returnTo.focus();
    };
  });

  /** A held-down Enter acts once (a text area still gets its new lines). */
  function blockHeldEnter(e: KeyboardEvent) {
    if (e.key === 'Enter' && e.repeat && !(e.target instanceof HTMLTextAreaElement))
      (e.preventDefault(), e.stopPropagation());
  }

  let downOnScrim = false;
</script>

<div
  class="dg-scrim"
  role="presentation"
  onmousedown={(e) => (downOnScrim = e.target === e.currentTarget)}
  onmouseup={(e) => {
    if (backdropClose && downOnScrim && e.target === e.currentTarget) close();
    downOnScrim = false;
  }}
>
  <div
    class="dg-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dg-title-{uid}"
    tabindex="-1"
    bind:this={panel}
    style:--dg-w="{width}px"
    onkeydown={(e) => trapTab(e, panel)}
    onkeydowncapture={blockHeldEnter}
  >
    <div class="dg-head">
      <div class="dg-grow">
        <h2 id="dg-title-{uid}">{title}</h2>
        {#if subtitle}<p>{subtitle}</p>{/if}
      </div>
      {#if headerExtra}{@render headerExtra()}{/if}
      {#if dismissable}<button class="dg-x" aria-label="Close" title="Close (Esc)" onclick={close}
          ><X size={15} /></button
        >{/if}
    </div>
    <div class="dg-body">{@render children()}</div>
    {#if footer}<div class="dg-foot">{@render footer()}</div>{/if}
  </div>
</div>
