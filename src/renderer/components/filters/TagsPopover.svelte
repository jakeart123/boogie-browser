<script lang="ts">
  // Tags and folders filters share one checklist: click includes, right-click (or the small ban
  // button) excludes. Tags also get the any / all / exact switch.
  import { tick, untrack } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Ban from '@lucide/svelte/icons/ban';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { fuzzy } from '../../lib/fuzzy';
  import { starredTags } from '../../lib/tags';
  import { toggleIncluded } from './chips';
  import Popover from './Popover.svelte';

  let { kind }: { kind: 'tags' | 'folders' } = $props();

  interface Entry {
    id: string;
    label: string;
    sub: string;
    count: number;
  }

  const spec = $derived(kind === 'tags' ? view.filter.tags : view.filter.folders);
  const include = $derived(spec?.include ?? []);
  const exclude = $derived(spec?.exclude ?? []);
  let mode = $state<'any' | 'all' | 'exact'>(view.filter.tags?.mode ?? 'any');
  let search = $state('');
  let hi = $state(0);
  let listEl = $state<HTMLDivElement | null>(null);
  // Selected entries float to the top when the popover opens, then stay put while you click.
  const pinned = untrack(() => new Set([...(spec?.include ?? []), ...(spec?.exclude ?? [])]));

  // Starred tags come right after the ones already in the filter.
  const starred = $derived(new Set(kind === 'tags' ? starredTags() : []));

  const all = $derived.by<Entry[]>(() => {
    if (kind === 'tags')
      return library.tags.map((t) => ({ id: t.name, label: t.name, sub: '', count: t.count }));
    return [...library.folders].map(([id, f]) => ({
      id,
      label: f.node.name,
      sub: f.path.slice(0, -1).join(' › '),
      count: library.counts?.folders[id]?.deep ?? 0,
    }));
  });

  const rows = $derived.by(() => {
    const q = search.trim();
    let list: { e: Entry; score: number }[];
    if (q) {
      list = [];
      for (const e of all) {
        const hit = fuzzy(q, e.label);
        if (hit) list.push({ e, score: hit.score });
      }
      list.sort((a, b) => b.score - a.score || b.e.count - a.e.count);
    } else {
      list = all
        .map((e) => ({ e, score: 0 }))
        .sort(
          (a, b) =>
            Number(pinned.has(b.e.id)) - Number(pinned.has(a.e.id)) ||
            Number(starred.has(b.e.id)) - Number(starred.has(a.e.id)) ||
            b.e.count - a.e.count ||
            a.e.label.localeCompare(b.e.label),
        );
    }
    return list.slice(0, 150).map((x) => x.e);
  });

  $effect(() => {
    void rows;
    hi = Math.min(hi, Math.max(rows.length - 1, 0));
  });

  function apply(inc: string[], exc: string[]) {
    const empty = !inc.length && !exc.length;
    if (kind === 'tags')
      view.setFilter({ tags: empty ? undefined : { mode, include: inc, exclude: exc } });
    else view.setFilter({ folders: empty ? undefined : { include: inc, exclude: exc } });
  }

  function toggle(id: string, excluding: boolean) {
    const next = toggleIncluded(include, exclude, id, excluding);
    apply(next.include, next.exclude);
  }

  function setMode(m: 'any' | 'all' | 'exact') {
    mode = m;
    if (include.length || exclude.length) apply(include, exclude);
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') ((hi = Math.min(hi + 1, rows.length - 1)), e.preventDefault());
    else if (e.key === 'ArrowUp') ((hi = Math.max(hi - 1, 0)), e.preventDefault());
    else if (e.key === 'Enter' && rows[hi]) (toggle(rows[hi].id, e.shiftKey), e.preventDefault());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
      void tick().then(() =>
        listEl?.querySelector('.row.hi')?.scrollIntoView({ block: 'nearest' }),
      );
  }

  const stateOf = (id: string) =>
    include.includes(id) ? 'inc' : exclude.includes(id) ? 'exc' : 'off';
</script>

<Popover
  {kind}
  title={kind === 'tags' ? 'Filter by tags' : 'Filter by folders'}
  onclear={include.length || exclude.length ? () => apply([], []) : undefined}
>
  {#if kind === 'tags'}
    <div class="seg" role="group" aria-label="Match">
      {#each [['any', 'Any'], ['all', 'All'], ['exact', 'Exactly']] as const as [m, label] (m)}
        <button aria-pressed={mode === m} onclick={() => setMode(m)}>{label}</button>
      {/each}
    </div>
  {/if}
  <input
    class="inp find"
    data-autofocus
    placeholder={kind === 'tags' ? 'Find a tag' : 'Find a folder'}
    aria-label={kind === 'tags' ? 'Find a tag' : 'Find a folder'}
    bind:value={search}
    onkeydown={onkey}
  />
  <div
    class="list"
    bind:this={listEl}
    role="listbox"
    aria-label={kind === 'tags' ? 'Tags' : 'Folders'}
    aria-multiselectable="true"
  >
    {#each rows as e, i (e.id)}
      {@const st = stateOf(e.id)}
      <div
        class="row"
        class:hi={i === hi}
        data-state={st}
        role="option"
        tabindex="-1"
        aria-selected={st === 'inc'}
        onmousedown={(ev) => ev.preventDefault()}
        onclick={() => toggle(e.id, false)}
        onkeydown={() => {}}
        oncontextmenu={(ev) => (ev.preventDefault(), toggle(e.id, true))}
        onmousemove={() => (hi = i)}
      >
        <span class="st">
          {#if st === 'inc'}<Check size={13} />{:else if st === 'exc'}<Ban size={12} />{/if}
        </span>
        <span class="nm"
          >{e.label}{#if e.sub}<i>{e.sub}</i>{/if}</span
        >
        <span class="ct">{e.count.toLocaleString()}</span>
        <button
          class="ex"
          title="Exclude"
          aria-label="Exclude {e.label}"
          onclick={(ev) => (ev.stopPropagation(), toggle(e.id, true))}
        >
          <Ban size={12} />
        </button>
      </div>
    {:else}
      <p class="none">Nothing matches.</p>
    {/each}
  </div>
  <p class="hint">Click to include. Right-click or Shift+Enter to exclude.</p>
</Popover>

<style>
  .find {
    margin-top: 10px;
  }
  .seg + .find {
    margin-top: 10px;
  }
  .list {
    margin: 8px -6px 0;
    max-height: 300px;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 6px;
    border-radius: 6px;
    font-size: 12.5px;
    cursor: default;
  }
  .row.hi {
    background: var(--hov);
  }
  .row[data-state='inc'] {
    color: var(--link);
  }
  .row[data-state='exc'] .nm {
    color: var(--err);
    text-decoration: line-through;
  }
  .st {
    width: 14px;
    display: grid;
    place-items: center;
    flex: none;
  }
  .row[data-state='exc'] .st {
    color: var(--err);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nm i {
    margin-left: 8px;
    font-style: normal;
    font-size: 11.5px;
    color: var(--fa);
  }
  .ct {
    font-size: 11.5px;
    color: var(--fa);
    font-variant-numeric: tabular-nums;
  }
  .ex {
    display: none;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--mu);
    place-items: center;
  }
  .row:hover .ex,
  .row.hi .ex {
    display: grid;
  }
  .ex:hover {
    background: var(--chip);
    color: var(--err);
  }
  .none {
    margin: 12px 6px;
    color: var(--fa);
    font-size: 12px;
  }
</style>
