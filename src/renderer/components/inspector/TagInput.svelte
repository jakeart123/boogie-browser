<script lang="ts">
  // "Add a tag": type, pick from the library's tags (or make a new one), Enter adds. Commas split.
  // Backspace on an empty box removes the last chip. Under it, the few most used tags this item
  // doesn't have yet; Alt+1..3 (or a click) adds one. Whatever is typed lands on the library's
  // spelling of a tag (lib/tags), without waiting for the search to answer.
  import { untrack } from 'svelte';
  import Tag from '@lucide/svelte/icons/tag';
  import { api } from '../../lib/api';
  import { focus } from '../../lib/commands.svelte';
  import { canonicalTag, splitTags, tagExists } from '../../lib/tags';
  import { library } from '../../lib/stores/library.svelte';
  import Chip from './Chip.svelte';
  import { quoted } from '../../lib/format';

  interface Props {
    /** Tags already on the item(s). */
    known: ReadonlySet<string>;
    /** Up to 3 frequent tags not on the item(s). */
    frequent: string[];
    onadd: (names: string[]) => unknown;
    onremovelast: () => void;
    placeholder?: string;
    /** Shortcut shown at the right while the box is idle. */
    hint?: string;
  }
  let {
    known,
    frequent,
    onadd,
    onremovelast,
    placeholder = 'Add a tag',
    hint = 'T',
  }: Props = $props();

  interface Row {
    label: string;
    count: number | null;
    isNew: boolean;
  }

  let el = $state<HTMLInputElement | null>(null);
  let text = $state('');
  let focused = $state(false);
  let found = $state.raw<{ label: string; count: number }[]>([]);
  let active = $state(0);

  const query = $derived(text.trim());
  const knownLower = $derived(new Set([...known].map((k) => k.toLowerCase())));
  const isKnown = (name: string) => knownLower.has(name.toLowerCase());
  const rows = $derived.by<Row[]>(() => {
    if (!query || isKnown(query)) return [];
    const list = found
      .filter((f) => !known.has(f.label))
      .map((f) => ({ label: f.label, count: f.count, isNew: false }));
    if (list.some((r) => r.label.toLowerCase() === query.toLowerCase())) return list;
    // Not in the search answer (yet): the library's own tag in its spelling, or a new tag.
    const name = canonicalTag(query);
    const count = library.tags.find((t) => t.name === name)?.count ?? null;
    return [{ label: name, count, isNew: !tagExists(name) }, ...list];
  });

  // The row Enter would pick: an exact match if there is one, else what was typed.
  $effect(() => {
    const list = rows;
    const q = untrack(() => query).toLowerCase();
    const exact = list.findIndex((r) => r.label.toLowerCase() === q);
    active = exact < 0 ? 0 : exact;
  });

  $effect(() => {
    const q = query;
    if (!q) {
      found = [];
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const r = await api.suggest(q, ['tag'], 12);
        if (live) found = r.map((x) => ({ label: x.label, count: x.count }));
      } catch {
        if (live) found = [];
      }
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  function add(names: string[]) {
    const fresh = [...new Set(names)].filter((n) => n && !isKnown(n));
    if (fresh.length) void onadd(fresh);
  }

  function clear() {
    text = '';
    if (el) el.value = '';
    found = [];
  }

  function commit() {
    const row = rows[active];
    const names = row ? [canonicalTag(row.label)] : splitTags(text);
    clear();
    add(names);
  }

  function oninput() {
    const v = el?.value ?? '';
    if (!v.includes(',')) {
      text = v;
      return;
    }
    const parts = v.split(',');
    const rest = (parts.pop() ?? '').trimStart();
    const names = splitTags(parts.join(','));
    text = rest;
    if (el) el.value = rest;
    add(names);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (e.altKey && digit) {
      const name = frequent[Number(digit) - 1];
      if (name) {
        e.preventDefault();
        add([name]);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
    } else if (e.key === 'Backspace' && !text) {
      e.preventDefault();
      // Only a fresh press: holding Backspace to clear the text must stop at an empty box, not go
      // on to remove one tag per key repeat.
      if (!e.repeat) onremovelast();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (text) return clear();
      el?.blur();
      focus.region = 'grid';
    }
  }
</script>

<div class="wrap">
  <label class="tagin" class:on={focused}>
    <Tag size={13} />
    <input
      bind:this={el}
      value={text}
      {placeholder}
      aria-label={placeholder}
      role="combobox"
      aria-expanded={focused && rows.length > 0}
      aria-controls="tag-suggestions"
      autocomplete="off"
      spellcheck="false"
      {oninput}
      {onkeydown}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
    />
    {#if hint && !focused && !text}<kbd>{hint}</kbd>{/if}
  </label>
  {#if focused && rows.length}
    <div
      class="drop"
      id="tag-suggestions"
      role="listbox"
      tabindex="-1"
      onmousedown={(e) => e.preventDefault()}
    >
      {#each rows as r, i (r.label)}
        <button
          type="button"
          role="option"
          aria-selected={i === active}
          class:on={i === active}
          onmouseenter={() => (active = i)}
          onclick={() => ((active = i), commit())}
        >
          <span class="lb">{r.isNew ? `Add ${quoted(r.label)}` : r.label}</span>
          <span class="ct">{r.isNew ? 'new tag' : r.count}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if frequent.length}
  <div class="sugg">
    {#each frequent as name, i (name)}
      <Chip label={name} ghost title="Add {name} (Alt+{i + 1})" onclick={() => add([name])}>
        {#snippet lead()}<i class="num">{i + 1}</i>{/snippet}
      </Chip>
    {/each}
  </div>
{/if}

<style>
  .wrap {
    position: relative;
    margin-top: 10px;
  }
  .tagin {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 6px 0 9px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
    color: var(--fa);
    font-size: 12.5px;
  }
  .tagin.on {
    border-color: var(--bl);
    color: var(--mu);
  }
  input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    padding: 0;
    color: var(--tx);
    font: inherit;
  }
  input::placeholder {
    color: var(--fa);
  }
  .tagin kbd {
    margin-left: auto;
  }
  .drop {
    position: absolute;
    z-index: 5;
    left: 0;
    right: 0;
    top: calc(100% + 4px);
    max-height: 240px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    box-shadow: var(--shadow-pop);
  }
  .drop button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border-radius: 5px;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .drop button.on {
    background: var(--hov);
  }
  .lb {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ct {
    color: var(--fa);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .sugg {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
  }
  .num {
    font-style: normal;
    font-size: 10px;
    font-weight: 600;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    display: grid;
    place-items: center;
    background: var(--chip);
    color: var(--tx);
    margin-left: -5px;
  }
</style>
