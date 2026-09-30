<script lang="ts">
  // The right column: facts from the item's note and source, tags and folders they point at
  // (with "Tag all" for every item still in the queue whose note says the same), what is already
  // on the item, and this session's counts.
  import { api } from '../../lib/api';
  import { openLink } from '../../lib/files';
  import { pathText } from '../../lib/folders';
  import { plural } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import type { TriageSession } from '../../lib/stores/triage.svelte';
  import type { Item } from '../../../shared/types';
  import { chosenOnce, tagAll } from './actions';
  import { items } from '../../lib/stores/items.svelte';
  import { parseNote, sameClue, sourceSite, suggest } from './clues';
  import { FILE_KEYS, TAG_KEYS } from '../../lib/triageKeys';

  let { session: s, item }: { session: TriageSession; item: Item | null | undefined } = $props();

  const clues = $derived(item ? parseNote(item.annotation) : []);
  const site = $derived(item ? sourceSite(item.url) : '');
  const folderList = $derived([...library.folders].map(([id, f]) => ({ id, name: f.node.name })));
  const suggestions = $derived(
    item
      ? suggest(
          clues,
          library.tags.map((t) => t.name),
          folderList,
          { tags: item.tags, folders: item.folders },
        )
      : [],
  );

  /** The key a suggestion already has, if any. */
  function keyOf(kind: 'tag' | 'folder', value: string): string | null {
    if (kind === 'tag') {
      const i = s.keys.tags.indexOf(value);
      return i >= 0 ? TAG_KEYS[i] : null;
    }
    const i = s.keys.folders.indexOf(value);
    return i >= 0 ? FILE_KEYS[i] : null;
  }

  // For the first two tag suggestions: the items still waiting in the queue whose note says the
  // same thing (Shift + the tag's key tags them all). The core finds notes containing the words;
  // only those whose note states the very same fact count, so the number shown is what gets tagged.
  /** Past this many candidates the check isn't worth it on every item: no "Tag all". */
  const MAX_CHECK = 2000;
  $effect(() => {
    const it = item;
    const wanted = suggestions.filter((g) => g.kind === 'tag').slice(0, 2);
    s.sameClue = {};
    if (!it || !wanted.length) return;
    let live = true;
    const t = setTimeout(async () => {
      const found: Record<string, string[]> = {};
      const inQueue = queueSet(s.ids);
      for (const g of wanted) {
        try {
          // Items already carrying the tag are left out: tagging them again does nothing.
          const tags = s.filter.tags;
          const r = await api.query({
            scope: s.scope,
            filter: {
              ...s.filter,
              noteContains: g.clue.value,
              tags: {
                mode: tags?.mode ?? 'any',
                include: tags?.include ?? [],
                exclude: [...(tags?.exclude ?? []), g.name],
              },
            },
            sort: null,
          });
          const open = r.ids.filter((x) => inQueue.has(x) && !s.outcomes[x]);
          if (open.length < 2 || open.length > MAX_CHECK) continue;
          const same: string[] = [];
          for (let i = 0; i < open.length && live; i += 500)
            for (const full of await items.loadFulls(open.slice(i, i + 500)))
              if (sameClue(full.annotation, g.clue)) same.push(full.id);
          if (same.length > 1) found[g.name] = same;
        } catch {
          /* no count: the card still offers this one item */
        }
      }
      if (live) s.sameClue = found;
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  });

  const sets = new WeakMap<readonly string[], Set<string>>();
  /** The queue as a set, made once per session (a queue can hold 85,000 items). */
  function queueSet(ids: readonly string[]): Set<string> {
    let set = sets.get(ids);
    if (!set) sets.set(ids, (set = new Set(ids)));
    return set;
  }

  const folderPath = (id: string) => {
    const f = library.folder(id);
    return f ? pathText(f.path) : '';
  };
</script>

<aside class="clues" aria-label="Clues">
  <h3>From the notes</h3>
  {#if clues.length || site}
    <dl class="notes">
      {#each clues as c, i (i)}
        <dt>{c.label}</dt>
        <dd>{c.value}</dd>
      {/each}
      {#if site}
        <dt>Source</dt>
        <dd>
          <button
            type="button"
            class="link"
            title={item?.url}
            onclick={() => item && openLink(item.url)}>{site}</button
          >
        </dd>
      {/if}
    </dl>
  {:else}
    <p class="none">
      {item?.annotation ? 'Nothing labelled in the note.' : 'No note on this item.'}
    </p>
  {/if}

  {#if suggestions.length}
    <h3>Suggested</h3>
    {#each suggestions as g (g.kind + (g.id ?? g.name))}
      {@const key = keyOf(g.kind, g.kind === 'tag' ? g.name : g.id!)}
      {@const all = g.kind === 'tag' ? s.sameClue[g.name] : undefined}
      <div class="sg">
        <span class="kc" class:empty={!key}>{key ?? (g.kind === 'tag' ? '#' : '›')}</span>
        <div class="t">
          {g.kind === 'tag' ? 'Tag' : 'File in'}
          {g.name}
        </div>
        <div class="w">
          {#if g.kind === 'folder'}<span title={folderPath(g.id!)}
              >{folderPath(g.id!)}.
            </span>{/if}The note says <b>{g.clue.label}: {g.clue.value}</b>.
          {#if all}<b>{all.length - 1}</b> more in this queue say the same.{/if}
        </div>
        <div class="act">
          <button
            type="button"
            onclick={() => chosenOnce(g.kind, g.kind === 'tag' ? g.name : g.id!)}
            >{g.kind === 'tag' ? 'Tag this one' : 'File this one'}{#if key}<span class="k"
                >{key}</span
              >{/if}</button
          >
          {#if all}
            <button type="button" onclick={() => tagAll(g.name, all)}
              >Tag all {all.length.toLocaleString()}{#if key}<span class="k">⇧{key}</span
                >{/if}</button
            >
          {/if}
        </div>
      </div>
    {/each}
  {/if}

  <h3>Already on this item</h3>
  <div class="onit">
    {#each item?.folders ?? [] as f (f)}
      {#if library.folder(f)}<span class="chip fold" title={folderPath(f)}
          >{library.folder(f)!.node.name}</span
        >{/if}
    {/each}
    {#each item?.tags ?? [] as t (t)}<span class="chip">{t}</span>{/each}
    {#if item && !item.tags.length}<span class="chip none">no tags yet</span>{/if}
  </div>

  <h3>This session</h3>
  <div class="sess">
    <div><b>{s.stats.tagged}</b>tagged</div>
    <div><b>{s.stats.filed}</b>filed</div>
    <div><b>{s.stats.skipped}</b>skipped</div>
    <div><b>{s.stats.trashed}</b>trashed</div>
  </div>
  {#if s.stats.filed + s.stats.tagged > 0}
    <p class="tip">
      Every change is in History ({plural(
        s.steps.filter((x) => x.groupId).length,
        'entry',
        'entries',
      )}). U takes back the last key.
    </p>
  {/if}
</aside>

<style>
  .clues {
    grid-area: clues;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px 18px;
    background: var(--side);
    border-left: 1px solid var(--line);
    scrollbar-width: thin;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mu);
  }
  h3::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  h3:not(:first-child) {
    margin-top: 18px;
  }
  .notes {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 6px 12px;
    margin: 0;
    font-size: 12.5px;
  }
  dt {
    padding-top: 2px;
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    color: var(--fa);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .link {
    padding: 0;
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .none {
    margin: 0;
    color: var(--fa);
    font-size: 12px;
  }
  .sg {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 3px 10px;
    margin-bottom: 8px;
    padding: 10px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
  }
  .kc {
    grid-row: span 3;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    background: var(--bl);
    color: var(--tx);
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: 600;
  }
  .kc.empty {
    background: var(--chip);
    color: var(--mu);
  }
  .t {
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .w {
    font-size: 12px;
    color: var(--mu);
    line-height: 1.45;
  }
  .w b {
    color: var(--tx);
    font-weight: 500;
  }
  .act {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .act button {
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid var(--chip-line);
    font-size: 11.5px;
    color: var(--tx);
  }
  .act button:hover {
    background: var(--hov);
  }
  .act .k {
    margin-left: 5px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--bl-soft);
  }
  .onit {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .chip {
    max-width: 100%;
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--chip);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.fold {
    background: var(--bls);
    color: var(--bl-soft);
  }
  .chip.none {
    background: none;
    border: 1px dashed var(--chip-line);
    color: var(--mu);
  }
  .sess {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    font-size: 10.5px;
    color: var(--mu);
  }
  .sess div {
    padding: 7px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .sess b {
    display: block;
    margin-bottom: 2px;
    font-family: var(--mono);
    font-size: 17px;
    font-weight: 500;
    color: var(--tx);
  }
  .tip {
    margin: 10px 0 0;
    color: var(--fa);
    font-size: 11.5px;
  }
  button:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: 1px;
  }
</style>
