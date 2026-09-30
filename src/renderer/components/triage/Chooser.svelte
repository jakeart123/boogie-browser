<script lang="ts">
  // Pick a folder or a tag: for a key (it keeps it for this queue) or, with 0, for this item only.
  // Type to narrow the list, arrows to move, Enter to pick, Esc to cancel.
  import { onMount } from 'svelte';
  import { searchFolders } from '../../lib/folders';
  import { library } from '../../lib/stores/library.svelte';
  import type { TriageSession } from '../../lib/stores/triage.svelte';
  import { canonicalTag, tagExists } from '../../lib/tags';
  import { assignKey, chosen } from './actions';
  import { FILE_KEYS, TAG_KEYS } from '../../lib/triageKeys';
  import { quoted } from '../../lib/format';

  let { session: s }: { session: TriageSession } = $props();

  const c = $derived(s.choosing!);
  let text = $state('');
  let hi = $state(0);
  let input = $state<HTMLInputElement>();

  interface Row {
    value: string; // folder id or tag name
    label: string;
    sub: string;
  }

  const rows = $derived.by<Row[]>(() => {
    if (c.kind === 'folder')
      return searchFolders(text, 40).map((f) => ({
        value: f.id,
        label: f.name,
        sub: f.path === f.name ? '' : f.path,
      }));
    const q = text.trim().toLowerCase();
    const hits = library.tags
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
      .map((t) => ({ value: t.name, label: t.name, sub: `${t.count.toLocaleString()} items` }));
    const typed = canonicalTag(text);
    if (typed && !tagExists(typed))
      hits.unshift({ value: typed, label: `New tag ${quoted(typed)}`, sub: '' });
    return hits;
  });

  const title = $derived.by(() => {
    const what = c.kind === 'folder' ? 'folder' : 'tag';
    if (c.slot === null) return `Pick a ${what} for this item`;
    const key = c.kind === 'folder' ? FILE_KEYS[c.slot] : TAG_KEYS[c.slot];
    return `Which ${what} is key ${key} for?`;
  });

  function pick(r: Row | undefined) {
    if (r) void chosen(r.value);
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') hi = Math.min(rows.length - 1, hi + 1);
    else if (e.key === 'ArrowUp') hi = Math.max(0, hi - 1);
    else if (e.key === 'Enter') pick(rows[hi]);
    else if (e.key === 'Escape') s.choosing = null;
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // The text field keeps the keyboard (a click on the title or the list doesn't take it away),
  // and focus goes back where it was when the chooser closes.
  onMount(() => {
    const before = document.activeElement;
    input?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

<div class="scrim" role="presentation" onclick={() => (s.choosing = null)}></div>
<div
  class="chooser"
  role="dialog"
  aria-label={title}
  tabindex="-1"
  onmousedown={(e) => e.target !== input && e.preventDefault()}
>
  <div class="hd">{title}</div>
  <input
    bind:this={input}
    bind:value={text}
    oninput={() => (hi = 0)}
    onkeydown={onkey}
    placeholder={c.kind === 'folder' ? 'Find a folder' : 'Find or type a tag'}
    spellcheck="false"
  />
  <div class="list" role="listbox">
    {#each rows as r, i (r.value)}
      <button
        type="button"
        role="option"
        aria-selected={i === hi}
        class="row"
        class:hi={i === hi}
        onmousemove={() => (hi = i)}
        onclick={() => pick(r)}
      >
        <span class="lb">{r.label}</span>
        {#if r.sub}<span class="sb">{r.sub}</span>{/if}
      </button>
    {:else}
      <p class="none">{c.kind === 'folder' ? 'No folder has that name.' : 'Type a tag name.'}</p>
    {/each}
  </div>
  <div class="ft">
    <span>↑ ↓ to move · Enter to pick · Esc to cancel</span>
    {#if c.slot !== null}
      {@const has = c.kind === 'folder' ? s.keys.folders[c.slot] : s.keys.tags[c.slot]}
      {#if has}<button
          type="button"
          class="clear"
          onclick={() => (assignKey(c.kind, c.slot!, null), (s.choosing = null))}
          >Clear this key</button
        >{/if}
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 1;
    background: var(--scrim);
  }
  .chooser {
    position: absolute;
    z-index: 2;
    top: 14vh;
    left: 50%;
    width: min(520px, calc(100vw - 40px));
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    border-radius: var(--radius-lg);
    background: var(--panel);
    border: 1px solid var(--panel-line);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  .hd {
    padding: 12px 16px 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--mu);
  }
  input {
    margin: 4px 12px 8px;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--radius);
    background: var(--fld);
    border: 1px solid var(--line);
    color: var(--tx);
    font: inherit;
    outline: none;
  }
  input:focus {
    border-color: var(--bl);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 6px 6px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border-radius: var(--radius);
    text-align: left;
  }
  .row.hi {
    background: var(--bls);
  }
  .lb {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fa);
    font-size: 12px;
  }
  .none {
    margin: 10px;
    color: var(--fa);
  }
  .ft {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--fa);
  }
  .clear {
    color: var(--err);
    font-size: 11.5px;
  }
</style>
