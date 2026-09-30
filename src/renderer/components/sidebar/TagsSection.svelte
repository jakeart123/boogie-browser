<script lang="ts">
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { openContextMenu } from '../../lib/contextMenu.svelte';
  import { readOnlyTip } from '../../lib/edit';
  import Star from '@lucide/svelte/icons/star';
  import { groupColor, isStarred, setStarred, starredTags } from '../../lib/tags';
  import type { TagInfo } from '../../../shared/types';
  import InlineInput from './InlineInput.svelte';
  import Section from './Section.svelte';
  import { deleteTag, renameTag } from './actions';

  /** A library can have thousands of tags; the list draws this many and asks you to filter. */
  const MAX_ROWS = 300;

  let query = $state('');
  let renaming = $state<string | null>(null);
  const ro = $derived(library.readOnly);
  const groups = $derived(library.state?.tagGroups ?? []);

  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? library.tags.filter((t) => t.name.toLowerCase().includes(needle))
      : [...library.tags];
    return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });

  interface Block {
    key: string;
    heading: string | null;
    color: string | null;
    tags: TagInfo[];
    total: number;
  }

  // With tag groups: one block per group (a tag can sit in several), then everything else.
  const blocks = $derived.by(() => {
    let budget = MAX_ROWS;
    const take = (
      key: string,
      heading: string | null,
      color: string | null,
      list: TagInfo[],
    ): Block | null => {
      if (!list.length) return null;
      const tags = list.slice(0, Math.max(budget, 0));
      budget -= tags.length;
      return { key, heading, color, tags, total: list.length };
    };
    const out: (Block | null)[] = [];
    // Starred first (tags.json travels with the library), even ones no item carries yet.
    const needle = query.trim().toLowerCase();
    const byName = new Map(library.tags.map((t) => [t.name, t]));
    out.push(
      take(
        'starred',
        'Starred',
        null,
        starredTags()
          .filter((n) => !needle || n.toLowerCase().includes(needle))
          .map((name) => byName.get(name) ?? { name, count: 0, groupIds: [] }),
      ),
    );
    if (!groups.length)
      out.push(take('all', starredTags().length ? 'All tags' : null, null, matches));
    else {
      const known = new Set(groups.map((g) => g.id));
      for (const g of groups)
        out.push(
          take(
            g.id,
            g.name,
            groupColor(g.color) ?? null,
            matches.filter((t) => t.groupIds.includes(g.id)),
          ),
        );
      out.push(
        take(
          'other',
          'Other tags',
          null,
          matches.filter((t) => !t.groupIds.some((id) => known.has(id))),
        ),
      );
    }
    return out.filter((b): b is Block => !!b);
  });
  const hidden = $derived(matches.length - blocks.reduce((n, b) => n + b.tags.length, 0));

  function menu(e: MouseEvent, name: string) {
    const starred = isStarred(name);
    openContextMenu(e, [
      {
        label: starred ? 'Unstar' : 'Star',
        disabled: ro,
        title: readOnlyTip(),
        run: () => setStarred([name], !starred),
      },
      {
        label: 'Rename…',
        disabled: ro,
        title: readOnlyTip(),
        run: () => void (renaming = name),
      },
      {
        label: 'Delete tag…',
        danger: true,
        disabled: ro,
        title: readOnlyTip(),
        run: () => deleteTag(name),
      },
      { separator: true },
      { label: 'Manage tags…', run: () => ui.openDialog('tagManager') },
    ]);
  }

  async function commitRename(from: string, to: string) {
    renaming = null;
    await renameTag(from, to);
  }
</script>

<Section id="tags" title="All tags" count={library.tags.length}>
  {#snippet actions()}
    <button
      class="sb-ib"
      aria-label="Manage tags"
      title="Manage tags…"
      onclick={() => ui.openDialog('tagManager')}><SlidersHorizontal size={13} /></button
    >
  {/snippet}
  {#if library.tags.length > 30}
    <input
      class="sb-filter"
      placeholder="Filter tags"
      aria-label="Filter tags"
      bind:value={query}
    />
  {/if}
  <div class="sb-taglist">
    {#each blocks as block (block.key)}
      {#if block.heading}
        <div class="sb-sub">
          {#if block.key === 'starred'}<Star size={11} class="star" />{/if}
          {#if block.color}<span class="dot" style:background={block.color}></span>{/if}
          <span>{block.heading}</span><span class="n">{block.total.toLocaleString()}</span>
        </div>
      {/if}
      {#each block.tags as t (block.key + '/' + t.name)}
        {#if renaming === t.name}
          <div class="sb-row">
            <span class="hash">#</span>
            <InlineInput
              value={t.name}
              label="New tag name"
              oncommit={(v) => commitRename(t.name, v)}
              oncancel={() => (renaming = null)}
            />
          </div>
        {:else}
          <button
            class="sb-row"
            class:sel={view.scope.kind === 'tag' && view.scope.name === t.name}
            title={t.name}
            onclick={() => view.setScope({ kind: 'tag', name: t.name })}
            oncontextmenu={(e) => menu(e, t.name)}
          >
            <span class="hash">#</span>
            <span class="fn">{t.name}</span>
            {#if t.count}<span class="sb-ct">{t.count.toLocaleString()}</span>{/if}
          </button>
        {/if}
      {/each}
    {/each}
    {#if !library.tags.length}
      <div class="sb-hint">No tags yet.</div>
    {:else if !matches.length}
      <div class="sb-hint">No tags match.</div>
    {:else if hidden > 0}
      <div class="sb-hint">{hidden.toLocaleString()} more. Type to filter.</div>
    {/if}
  </div>
</Section>
