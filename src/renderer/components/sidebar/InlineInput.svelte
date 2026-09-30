<script lang="ts">
  // The little name editor used for rename and "new folder" rows. Enter or leaving the field
  // saves, Escape cancels. The result is always reported once.
  import { onMount } from 'svelte';

  let {
    value = '',
    label,
    placeholder = '',
    oncommit,
    oncancel,
  }: {
    value?: string;
    label: string;
    placeholder?: string;
    oncommit: (text: string) => void;
    oncancel: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally: the field starts from the value it was opened with
  let text = $state(value);
  let el = $state<HTMLInputElement | null>(null);
  let finished = false;

  onMount(() => {
    el?.focus();
    el?.select();
  });

  function commit() {
    if (finished) return;
    finished = true;
    oncommit(text.trim());
  }
  function cancel() {
    if (finished) return;
    finished = true;
    oncancel();
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') (e.preventDefault(), commit());
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), cancel());
  }
</script>

<input
  class="sb-input"
  bind:this={el}
  bind:value={text}
  aria-label={label}
  {placeholder}
  spellcheck="false"
  autocomplete="off"
  onkeydown={keydown}
  onblur={commit}
  onclick={(e) => e.stopPropagation()}
  ondblclick={(e) => e.stopPropagation()}
  oncontextmenu={(e) => e.stopPropagation()}
/>
