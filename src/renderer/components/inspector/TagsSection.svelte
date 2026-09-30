<script lang="ts">
  // Tags of one item, or the union over a multi-selection ("2 of 5" when only some have it).
  import type { Item } from '../../../shared/types';
  import { library } from '../../lib/stores/library.svelte';
  import { plural, quoted } from '../../lib/format';
  import Chip from './Chip.svelte';
  import TagInput from './TagInput.svelte';
  import { editSelected } from './edit';
  import { groupColor } from '../../lib/tags';
  import { groupTags, onEveryItem, topTags, unionCounts } from './logic';

  let { items, ids, readonly }: { items: Item[]; ids: string[]; readonly: boolean } = $props();

  const n = $derived(items.length);
  const counted = $derived(unionCounts(items.map((i) => i.tags)));
  const layout = $derived(groupTags(counted, library.state?.tagGroups ?? []));
  // A tag on only some of the items can still be typed or suggested: adding it fills in the rest.
  const present = $derived(onEveryItem(counted, n, ids.length));
  const frequent = $derived(topTags(library.tags, present, 3));
  const lastChip = $derived(layout.sections.at(-1)?.tags.at(-1)?.key);

  function add(names: string[]) {
    const tags = names.length === 1 ? `the tag ${names[0]}` : plural(names.length, 'tag');
    return editSelected(
      ids,
      { addTags: names },
      { what: `add ${tags} to ${plural(ids.length, 'item')}` },
    );
  }

  function remove(name: string) {
    return editSelected(
      ids,
      { removeTags: [name] },
      {
        what: `remove the tag ${quoted(name)} from ${plural(ids.length, 'item')}`,
        done:
          ids.length > 1 ? `Removed ${quoted(name)} from ${plural(ids.length, 'item')}` : undefined,
      },
    );
  }
</script>

<div class="lbl">
  Tags{#if layout.grouped}<span class="r">grouped</span>{/if}
</div>
{#each layout.sections as s (s.group?.id ?? '_none')}
  {#if layout.grouped}<div class="tg">{s.group?.name ?? 'Ungrouped'}</div>{/if}
  <div class="chips">
    {#each s.tags as t (t.key)}
      {@const partial = t.count < n}
      <Chip
        label={t.key}
        dim={partial}
        sub={partial ? `${t.count} of ${n}` : undefined}
        title={partial ? `On ${t.count} of ${n} items. Click to add it to all.` : undefined}
        onclick={partial && !readonly ? () => add([t.key]) : undefined}
        onremove={readonly ? undefined : () => remove(t.key)}
      >
        {#snippet lead()}{#if layout.grouped}<span
              class="gdot"
              style:background={groupColor(s.group?.color) ?? 'var(--fa)'}
            ></span>{/if}{/snippet}
      </Chip>
    {/each}
  </div>
{/each}
{#if !counted.length && readonly}<div class="note">No tags</div>{/if}
{#if !readonly}<TagInput
    known={present}
    {frequent}
    onadd={add}
    onremovelast={() => lastChip && remove(lastChip)}
  />{/if}
{#if ids.length > n}<div class="note trunc">
    Tags shown are from the first {n.toLocaleString()} of {ids.length.toLocaleString()} items.
  </div>{/if}

<style>
  .gdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .trunc {
    margin-top: 6px;
  }
</style>
