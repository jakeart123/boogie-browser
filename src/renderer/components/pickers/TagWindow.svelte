<script lang="ts">
  // The tag window (T): add or remove tags on the selection. Each tag shows whether all, some or none
  // of the selected items have it; clicking flips it for every selected item.
  import { onMount, untrack } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import { api } from '../../lib/api';
  import { editItems, fail, readOnlyTip } from '../../lib/edit';
  import { plural, quoted } from '../../lib/format';
  import { fuzzy, segments, type Segment } from '../../lib/fuzzy';
  import { pushRecent, readList } from '../../lib/storage';
  import { canonicalTag, recentTags, starredTags, tagExists } from '../../lib/tags';
  import { items } from '../../lib/stores/items.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import Modal from './Modal.svelte';

  let { ids, onclose }: { ids: string[]; onclose: () => void } = $props();

  // Checking every item would mean fetching every full record; past this the state is a sample.
  const SAMPLE = 2000;
  const sampleSize = untrack(() => Math.min(ids.length, SAMPLE));
  const recentKey = `recentTags.${library.state?.ref.id ?? 'none'}`;

  let text = $state('');
  let hi = $state(-1);
  let loaded = $state(false);
  /** tag -> how many of the sampled items carry it */
  let have = $state.raw(new Map<string, number>());
  let sugg = $state.raw<{ label: string; count: number }[]>([]);
  let recent = $state.raw(readList(recentKey));
  let listEl = $state<HTMLDivElement | null>(null);

  type State = 'all' | 'some' | 'none';
  interface Row {
    name: string;
    state: State;
    /** How many of the selected items have it. */
    on: number;
    /** Items in the library with it. */
    count: number | null;
    segs: Segment[];
    /** Adds several new tags at once ("a, b"). */
    many?: string[];
    create?: boolean;
    section: string;
  }

  const stateOf = (name: string): State => {
    const n = have.get(name) ?? 0;
    return n === 0 ? 'none' : n >= sampleSize ? 'all' : 'some';
  };
  const libCount = new Map(library.tags.map((t) => [t.name, t.count]));

  const typedNames = $derived(
    text
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );

  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    const seen = new Set<string>();
    const push = (name: string, section: string, positions?: number[]) => {
      if (seen.has(name)) return;
      seen.add(name);
      out.push({
        name,
        state: stateOf(name),
        on: have.get(name) ?? 0,
        count: libCount.get(name) ?? null,
        segs: segments(name, positions),
        section,
      });
    };
    if (text.trim()) {
      if (typedNames.length > 1) {
        return [
          {
            name: typedNames.join(', '),
            state: 'none',
            on: 0,
            count: null,
            segs: [{ text: `Add ${typedNames.length} tags: ${typedNames.join(', ')}`, hit: false }],
            many: [...new Set(typedNames.map(canonicalTag))],
            create: true,
            section: 'Add',
          },
        ];
      }
      const q = text.trim();
      const canon = canonicalTag(q);
      if (tagExists(canon)) push(canon, 'Matches', fuzzy(q, canon)?.positions);
      else
        out.push({
          name: q,
          state: 'none',
          on: 0,
          count: null,
          segs: [{ text: `Create tag ${quoted(q)}`, hit: false }],
          create: true,
          section: 'Matches',
        });
      for (const s of sugg) push(s.label, 'Matches', fuzzy(q, s.label)?.positions);
      return out;
    }
    [...have.keys()]
      .sort(
        (a, b) => Number(stateOf(b) === 'all') - Number(stateOf(a) === 'all') || a.localeCompare(b),
      )
      .forEach((n) => push(n, 'On these items'));
    starredTags().forEach((n) => push(n, 'Starred'));
    // This computer's picks first, then the library's own recent list (tags.json).
    recentTags(recent).forEach((n) => push(n, 'Recent'));
    [...library.tags]
      .sort((a, b) => b.count - a.count)
      .slice(0, 24)
      .forEach((t) => push(t.name, 'Popular'));
    return out;
  });

  onMount(() => {
    void (async () => {
      try {
        const fulls = await items.loadFulls(ids.slice(0, SAMPLE));
        const m = new Map<string, number>();
        for (const it of fulls) for (const t of it.tags) m.set(t, (m.get(t) ?? 0) + 1);
        have = m;
      } catch (e) {
        fail(e);
      } finally {
        loaded = true;
      }
    })();
  });

  // Fuzzy suggestions for what you type (the core knows the tag counts and ranking).
  let seq = 0;
  $effect(() => {
    const q = text.trim();
    hi = q ? 0 : -1;
    if (!q || q.includes(',')) return void (sugg = []);
    const mine = ++seq;
    const t = setTimeout(async () => {
      try {
        const res = await api.suggest(q, ['tag'], 30);
        if (mine === seq) sugg = res.map((r) => ({ label: r.label, count: r.count }));
      } catch {
        /* suggestions are a nicety; the create row still works */
      }
    }, 60);
    return () => clearTimeout(t);
  });

  async function add(names: string[]) {
    // Quiet: the checkbox turning on says it worked.
    const res = await editItems(
      ids,
      { addTags: names },
      {
        what: `add ${names.join(', ')} to ${plural(ids.length, 'item')}`,
      },
    );
    if (!res) return;
    const m = new Map(have);
    for (const n of names) {
      m.set(n, sampleSize);
      recent = pushRecent(recentKey, n);
    }
    have = m;
  }

  async function remove(name: string) {
    const n = plural(ids.length, 'item');
    const res = await editItems(
      ids,
      { removeTags: [name] },
      {
        what: `remove the tag ${quoted(name)} from ${n}`,
        done: `Removed the tag ${quoted(name)} from ${n}`,
      },
    );
    if (!res) return;
    const m = new Map(have);
    m.delete(name);
    have = m;
  }

  function toggle(row: Row) {
    if (row.many) return void add(row.many).then(() => (text = ''));
    if (row.create) return void add([canonicalTag(row.name)]).then(() => (text = ''));
    if (row.state === 'all') void remove(row.name);
    else void add([row.name]);
  }

  /** Enter: adds (never removes), and clears the box so you can type the next tag. */
  function enter() {
    const row = rows[hi];
    if (row) {
      if (row.state === 'all' && !row.create) return void (text = '');
      if (row.many) return void add(row.many).then(() => (text = ''));
      return void add([row.create ? canonicalTag(row.name) : row.name]).then(() => (text = ''));
    }
    if (!text.trim()) onclose();
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') hi = Math.min(hi + 1, rows.length - 1);
    else if (e.key === 'ArrowUp') hi = Math.max(hi - 1, -1);
    else if (e.key === 'Enter') enter();
    else return;
    e.preventDefault();
    if (e.key !== 'Enter')
      void Promise.resolve().then(() =>
        listEl?.querySelector('.row.hi')?.scrollIntoView({ block: 'nearest' }),
      );
  }
</script>

<Modal {onclose} label="Tags" width={440}>
  <div class="head">
    <h2>Tags</h2>
    <span class="n">{plural(ids.length, 'item')}</span>
  </div>
  {#if !ids.length}
    <p class="empty">Select some items first.</p>
  {:else}
    {#if library.readOnly}<p class="ro">{readOnlyTip()}</p>{/if}
    <div class="inrow">
      <Plus size={15} />
      <input
        data-autofocus
        readonly={library.readOnly}
        placeholder={library.readOnly
          ? 'Tags can’t be changed here'
          : 'Add a tag (separate several with commas)'}
        aria-label="Add a tag"
        autocomplete="off"
        spellcheck="false"
        bind:value={text}
        onkeydown={onkey}
      />
    </div>
    <div
      class="list"
      class:locked={library.readOnly}
      bind:this={listEl}
      role="listbox"
      aria-label="Tags"
      aria-multiselectable="true"
    >
      {#each rows as row, i (row.section + ':' + row.name)}
        {#if i === 0 || rows[i - 1].section !== row.section}<h6>{row.section}</h6>{/if}
        <div
          class="row"
          class:hi={i === hi}
          role="option"
          tabindex="-1"
          aria-selected={row.state === 'all'}
          onmousedown={(ev) => ev.preventDefault()}
          onclick={() => toggle(row)}
          onkeydown={() => {}}
          onmousemove={() => (hi = i)}
        >
          {#if row.create}
            <span class="box new"><Plus size={12} /></span>
          {:else}
            <span class="box" class:on={row.state !== 'none'}>
              {#if row.state === 'all'}<Check size={12} />{:else if row.state === 'some'}<Minus
                  size={12}
                />{/if}
            </span>
          {/if}
          <span class="nm"
            >{#each row.segs as s, j (j)}{#if s.hit}<mark>{s.text}</mark
                >{:else}{s.text}{/if}{/each}</span
          >
          {#if row.on > 0 && sampleSize > 1}<span class="d"
              >{row.on.toLocaleString()} of {sampleSize.toLocaleString()}</span
            >{:else if row.count !== null}<span class="d">{row.count.toLocaleString()}</span>{/if}
        </div>
      {:else}
        {#if loaded}<p class="empty">No tags yet. Type one and press Enter.</p>{/if}
      {/each}
    </div>
    {#if ids.length > SAMPLE}<p class="note">
        Checkboxes reflect the first {SAMPLE.toLocaleString()} items.
      </p>{/if}
  {/if}
  <div class="foot">
    {#if !library.readOnly}<span>Enter to add</span><span>Click to turn a tag on or off</span>{/if}
    <span>Esc to close</span>
    <button class="done" onclick={onclose}>Done</button>
  </div>
</Modal>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 16px 6px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .n {
    color: var(--fa);
    font-size: 12px;
  }
  .inrow {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    margin: 6px 12px 4px;
    padding: 0 10px;
    border-radius: 8px;
    background: var(--fld);
    border: 1px solid var(--chip-line);
    color: var(--fa);
  }
  .inrow:focus-within {
    border-color: var(--bl);
  }
  .inrow input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: none;
    border: 0;
    outline: none;
    font-size: 13.5px;
    color: var(--tx);
  }
  .inrow input::placeholder {
    color: var(--fa);
  }
  .list {
    overflow: auto;
    min-height: 0;
    max-height: 340px;
    padding: 2px 8px 6px;
  }
  h6 {
    margin: 10px 8px 4px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 8px;
    border-radius: 7px;
    font-size: 13px;
    cursor: default;
  }
  .row.hi {
    background: var(--bls);
  }
  .box {
    display: grid;
    place-items: center;
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1.5px solid var(--fa);
    color: var(--tx);
  }
  .box.on {
    background: var(--bl);
    border-color: var(--bl);
  }
  .box.new {
    border-style: dashed;
    color: var(--mu);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: none;
    color: var(--link);
    font-weight: 600;
  }
  .d {
    color: var(--fa);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .empty,
  .note,
  .ro {
    margin: 10px 16px;
    font-size: 12px;
    color: var(--fa);
  }
  .ro {
    color: var(--warn);
  }
  .list.locked {
    opacity: 0.55;
    pointer-events: none;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 12px 8px 18px;
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--fa);
  }
  .done {
    margin-left: auto;
    height: 26px;
    padding: 0 12px;
    border-radius: 6px;
    background: var(--chip);
    color: var(--tx);
    font-size: 12px;
  }
  .done:hover {
    background: var(--chip-line);
  }
  button:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: 1px;
  }
</style>
