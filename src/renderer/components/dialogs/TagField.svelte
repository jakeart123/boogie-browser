<script lang="ts">
  // A row of tag chips with a text box: Enter or comma adds, Backspace removes the last,
  // and matching existing tags are suggested underneath.
  import X from '@lucide/svelte/icons/x';
  import { canonicalTag } from '../../lib/tags';
  import { onEscape } from './escape';

  let {
    tags = $bindable([]),
    suggestions = [],
    placeholder = 'Add a tag',
    disabled = false,
    label = 'Tags',
  }: {
    tags: string[];
    suggestions?: string[];
    placeholder?: string;
    disabled?: boolean;
    label?: string;
  } = $props();

  let text = $state('');
  let active = $state(-1);
  let focused = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const query = $derived(text.trim().toLowerCase());
  const matches = $derived(
    query
      ? suggestions.filter((t) => !tags.includes(t) && t.toLowerCase().includes(query)).slice(0, 8)
      : [],
  );

  /** Add tags from text. Commas split it; a tag the library has in any case keeps its spelling. */
  function add(raw: string) {
    const next = [...tags];
    for (const part of raw.split(/[,\r\n]+/)) {
      const t = part.trim();
      if (!t) continue;
      const name = canonicalTag(t);
      if (!next.includes(name)) next.push(name);
    }
    if (next.length !== tags.length) tags = next;
    text = '';
    active = -1;
  }

  const remove = (t: string) => (tags = tags.filter((x) => x !== t));

  /** Typing or pasting a comma finishes the tags before it and leaves the rest in the box. */
  function oninput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    const at = v.lastIndexOf(',');
    if (at < 0) return;
    add(v.slice(0, at));
    text = v.slice(at + 1).trimStart();
  }

  function keydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' && matches.length)
      (e.preventDefault(), (active = (active + 1) % matches.length));
    else if (e.key === 'ArrowUp' && matches.length)
      (e.preventDefault(), (active = (active <= 0 ? matches.length : active) - 1));
    else if (e.key === 'Enter') {
      if (!text.trim()) return; // let the form save
      e.preventDefault();
      add(active >= 0 && matches[active] ? matches[active] : text);
    } else if (e.key === 'Backspace' && !text && tags.length && !e.repeat) tags = tags.slice(0, -1);
  }

  // Escape clears what's being typed before it closes the dialog.
  $effect(() => {
    if (!focused || !text) return;
    return onEscape(() => ((text = ''), (active = -1), true));
  });
</script>

<div class="tf" class:disabled>
  <div class="box" role="presentation" onclick={() => input?.focus()}>
    {#each tags as t (t)}
      <span class="dg-chip"
        >{t}{#if !disabled}<button
            class="dg-cx"
            type="button"
            aria-label="Remove {t}"
            onclick={(e) => (e.stopPropagation(), remove(t))}><X size={10} /></button
          >{/if}</span
      >
    {/each}
    <input
      bind:this={input}
      bind:value={text}
      aria-label={label}
      {placeholder}
      {disabled}
      autocomplete="off"
      spellcheck="false"
      onkeydown={keydown}
      {oninput}
      onfocus={() => (focused = true)}
      onblur={() => {
        focused = false;
        if (text.trim()) add(text);
      }}
    />
  </div>
  {#if focused && matches.length}
    <ul class="sug" role="listbox" aria-label="Suggestions">
      {#each matches as m, i (m)}
        <li role="option" aria-selected={i === active}>
          <button
            type="button"
            class:on={i === active}
            onmousedown={(e) => (e.preventDefault(), add(m))}>{m}</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tf {
    position: relative;
  }
  .box {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: center;
    min-height: 32px;
    padding: 4px 6px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
    cursor: text;
  }
  .box:hover {
    border-color: var(--panel-line);
  }
  .box:focus-within {
    border-color: var(--bl-soft);
  }
  .disabled .box {
    cursor: default;
    opacity: 0.7;
  }
  input {
    flex: 1;
    min-width: 90px;
    height: 22px;
    background: none;
    border: 0;
    outline: none;
    font-size: 12.5px;
    color: var(--tx);
  }
  input::placeholder {
    color: var(--fa);
  }
  /* The box already shows focus (border), so the input inside doesn't draw its own ring. */
  .tf input:focus-visible {
    outline: none;
  }
  .sug {
    position: absolute;
    z-index: 5;
    left: 0;
    right: 0;
    top: calc(100% + 3px);
    margin: 0;
    padding: 4px;
    list-style: none;
    border-radius: 8px;
    background: var(--hov);
    border: 1px solid var(--panel-line);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .sug button {
    display: block;
    width: 100%;
    text-align: left;
    height: 26px;
    padding: 0 8px;
    border-radius: 5px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .sug button:hover,
  .sug button.on {
    background: var(--bls);
  }
</style>
