<script lang="ts">
  // ui.prompt: one line of text (a name for a saved filter, say). Resolves exactly once, with the
  // trimmed text on Enter or the button, or null on Escape, Cancel or being replaced.
  import { onDestroy, untrack } from 'svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import Modal from './Modal.svelte';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  const args = untrack(() => incoming);
  const title = String(args.title ?? 'Name');
  const label = typeof args.label === 'string' ? args.label : 'Name';
  const body = typeof args.body === 'string' ? args.body : '';
  const confirmLabel = String(args.confirmLabel ?? 'Save');
  const resolve = args.resolve as ((v: string | null) => void) | undefined;

  let value = $state(typeof args.value === 'string' ? args.value : '');
  let done = false;

  function finish(v: string | null) {
    if (done) return;
    done = true;
    resolve?.(v);
    if (ui.dialog?.kind === 'prompt') ui.closeDialog();
  }
  // Replaced by another dialog or closed from outside: that's a no (and not ours to close).
  onDestroy(() => {
    if (!done) ((done = true), resolve?.(null));
  });

  const ok = () => value.trim() && finish(value.trim());
</script>

<Modal {title} width={420} backdropClose={false} onclose={() => finish(null)}>
  {#if body}<p class="body">{body}</p>{/if}
  <label class="dg-field">
    <span class="dg-label">{label}</span>
    <input
      class="dg-input"
      bind:value
      spellcheck="false"
      onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), ok())}
      onfocus={(e) => e.currentTarget.select()}
    />
  </label>
  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn" onclick={() => finish(null)}>Cancel</button>
    <button class="dg-btn pri" disabled={!value.trim()} onclick={ok}>{confirmLabel}</button>
  {/snippet}
</Modal>

<style>
  .body {
    margin: 0 0 12px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--mu);
  }
</style>
