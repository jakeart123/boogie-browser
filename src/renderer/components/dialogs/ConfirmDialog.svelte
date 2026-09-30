<script lang="ts">
  // ui.confirm / ui.confirmWith. Resolves exactly once: Enter or the button says yes, Escape,
  // Cancel, the backdrop, or the dialog being replaced all say no.
  import { onDestroy, untrack } from 'svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import Modal from './Modal.svelte';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  // Read once: Dialogs.svelte mounts a fresh component for every openDialog call.
  const args = untrack(() => incoming);

  const title = String(args.title ?? 'Are you sure?');
  const body = String(args.body ?? '');
  const confirmLabel = String(args.confirmLabel ?? 'Continue');
  const danger = !!args.danger;
  const checkbox = typeof args.checkbox === 'string' ? args.checkbox : null;
  const resolve = args.resolve as ((r: { ok: boolean; checked: boolean }) => void) | undefined;

  let checked = $state(false);
  let done = false;
  // The dialog often opens from an Enter press (a rename that turns into a merge, a bulk edit).
  // That same key event is still on its way up to the window when this mounts, so only keys
  // pressed after the dialog opened can answer it.
  const openedAt = performance.now();

  function finish(ok: boolean) {
    if (done) return;
    done = true;
    resolve?.({ ok, checked: ok && checked });
    if (ui.dialog?.kind === 'confirm') ui.closeDialog();
  }

  // Replaced by another dialog or closed from outside: that's a no.
  onDestroy(() => {
    if (!done) {
      done = true;
      resolve?.({ ok: false, checked: false });
    }
  });

  function key(e: KeyboardEvent) {
    // Neither the press that opened this dialog nor a held-down Enter answers it, not even
    // through the focused button's own click (the key handler in lib/commands also stops that).
    if (e.timeStamp < openedAt || e.repeat) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    // Enter confirms, unless focus is on a button that has its own meaning (Cancel).
    if (
      e.key === 'Enter' &&
      !(e.target instanceof HTMLButtonElement && e.target.dataset.role === 'cancel')
    ) {
      e.preventDefault();
      finish(true);
    }
  }
</script>

<svelte:window onkeydown={key} />

<Modal {title} width={440} backdropClose={false} onclose={() => finish(false)}>
  {#if body}<p class="body">{body}</p>{/if}
  {#if checkbox}
    <label class="dg-check" style="margin-top:14px"
      ><input type="checkbox" bind:checked /><span>{checkbox}</span></label
    >
  {/if}
  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn" data-role="cancel" onclick={() => finish(false)}>Cancel</button>
    <button class="dg-btn {danger ? 'danger' : 'pri'}" data-autofocus onclick={() => finish(true)}
      >{confirmLabel}</button
    >
  {/snippet}
</Modal>

<style>
  .body {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--mu);
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
