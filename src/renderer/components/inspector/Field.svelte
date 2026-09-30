<script lang="ts">
  // A text field that commits on its own: Enter (single line), Ctrl+Enter (notes) or leaving it.
  // Escape hands the keyboard back to the grid (and throws the edit away, except in long text).
  // Read-only shows plain text.
  import type { Snippet } from 'svelte';
  import { focus } from '../../lib/commands.svelte';
  import { keepLineEndings, normalizeNewlines } from './logic';

  interface Props {
    value: string;
    label: string;
    placeholder?: string;
    multiline?: boolean;
    readonly?: boolean;
    /** Faint text for an empty read-only field. */
    emptyText?: string;
    /** Muted, uneditable tail, e.g. the file extension. */
    suffix?: string;
    /** The selected items disagree: `value` is '' and the placeholder says "Multiple values". */
    mixed?: boolean;
    trim?: boolean;
    allowEmpty?: boolean;
    /** Save `next`. Resolve true if it was saved (false brings the old text back). */
    oncommit: (next: string) => Promise<boolean> | boolean;
    lead?: Snippet;
  }

  let {
    value,
    label,
    placeholder = '',
    multiline = false,
    readonly = false,
    emptyText = '',
    suffix = '',
    mixed = false,
    trim = false,
    allowEmpty = true,
    oncommit,
    lead,
  }: Props = $props();

  let draft = $state('');
  let dirty = $state(false);
  let busy = false;
  // What the field held when typing began. The props are live, and a field that is being torn down
  // (its blur fires as it leaves the page) must judge "did it change" against what the user saw.
  let base = '';
  let baseMixed = false;
  // Right after a save the stored value may lag a moment; keep showing what was saved until it catches up.
  let held = $state<{ v: string; from: string } | null>(null);
  let el = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const shown = $derived(dirty ? draft : held && held.from === value ? held.v : value);

  async function commit() {
    if (!dirty || busy) return;
    busy = true;
    const typed = trim ? draft.trim() : draft;
    try {
      const same = !baseMixed && normalizeNewlines(typed) === normalizeNewlines(base);
      if (same || (!allowEmpty && !typed)) return;
      const next = multiline ? keepLineEndings(typed, base) : typed;
      if (await oncommit(next)) {
        held = { v: next, from: value };
        setTimeout(() => (held = null), 2000);
      }
    } finally {
      dirty = false;
      busy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // A short field snaps back. A long one (notes) keeps what was typed: leaving it saves it.
      if (multiline) void commit();
      else dirty = false;
      el?.blur();
      focus.region = 'grid';
    } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void commit();
      if (!multiline) el?.blur();
    }
  }

  function oninput() {
    if (!dirty) {
      base = shown;
      baseMixed = mixed;
    }
    draft = el?.value ?? '';
    dirty = true;
  }
</script>

{#if readonly}
  <div class="fld ro" class:ph={!shown} class:area={multiline} title={shown}>
    {#if lead}{@render lead()}{/if}
    <span class="txt"
      >{shown || emptyText}{#if suffix && shown}<span class="sfx">{suffix}</span>{/if}</span
    >
  </div>
{:else}
  <div class="fld" class:area={multiline}>
    {#if lead}{@render lead()}{/if}
    {#if multiline}
      <textarea
        bind:this={el}
        value={shown}
        {placeholder}
        aria-label={label}
        rows="2"
        spellcheck="false"
        {oninput}
        onblur={commit}
        {onkeydown}></textarea>
    {:else}
      <input
        bind:this={el}
        type="text"
        value={shown}
        {placeholder}
        aria-label={label}
        title={shown}
        spellcheck="false"
        {oninput}
        onblur={commit}
        {onkeydown}
      />
      {#if suffix}<span class="sfx">{suffix}</span>{/if}
    {/if}
  </div>
{/if}

<style>
  .fld {
    display: flex;
    align-items: center;
    gap: 7px;
    background: var(--fld);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 7px 9px;
    margin-bottom: 8px;
    font-size: 12.5px;
    line-height: 1.4;
  }
  .fld:focus-within {
    border-color: var(--bl);
  }
  .fld.area {
    align-items: flex-start;
  }
  input,
  textarea {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    padding: 0;
    margin: 0;
    color: var(--tx);
    font: inherit;
    line-height: inherit;
  }
  input {
    text-overflow: ellipsis;
  }
  textarea {
    resize: none;
    display: block;
    min-height: 2.8em;
    max-height: 260px;
    field-sizing: content;
    overflow-y: auto;
  }
  ::placeholder {
    color: var(--fa);
  }
  .sfx {
    color: var(--fa);
    flex: none;
  }
  .ro {
    border-color: transparent;
    background: transparent;
    padding-left: 0;
    padding-right: 0;
  }
  .ro .txt {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Like the inputs they stand in for: a long name or source link (a 600-character search URL)
     stops at two lines, the full text is in the tooltip; notes scroll like the text box does. */
  .ro:not(.area) .txt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .ro.area .txt {
    max-height: 260px;
    overflow-y: auto;
  }
  .ro.ph {
    color: var(--fa);
  }
</style>
