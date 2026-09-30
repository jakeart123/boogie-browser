<script lang="ts">
  // One group of duplicates: the copies side by side, a radio for which one to keep, and what
  // merging would do. A merged group folds into a one-line "Merged. Undo".
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { dateTime, fileSize, quoted } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import type { DuplicateGroup } from '../../../shared/types';
  import { inLibrary, likeness, mergePreview, mergeSentence } from './dupes';

  let {
    group,
    n,
    keeperId,
    libraryId,
    merged,
    merging,
    blocked,
    onkeeper,
    onmerge,
    onhide,
    onundo,
  }: {
    group: DuplicateGroup;
    n: number;
    keeperId: string;
    libraryId: string;
    merged: { keptName: string; count: number; groupId: string | null } | null;
    merging: boolean;
    /** Why merging is off right now (read-only library, another merge running), or null. */
    blocked: string | null;
    onkeeper: (id: string) => void;
    onmerge: () => void;
    onhide: () => void;
    onundo: () => void;
  } = $props();

  const preview = $derived(mergePreview(group, keeperId, libraryId));
  const folderName = (id: string) => library.folder(id)?.node.name ?? null;
  const MAX_CHIPS = 3;
</script>

{#if merged}
  <div class="done">
    <span
      >Merged {merged.count.toLocaleString()}
      {merged.count === 1 ? 'copy' : 'copies'} into {quoted(merged.keptName)}.</span
    >
    {#if merged.groupId}<button class="dg-link" onclick={onundo}>Undo</button>{/if}
  </div>
{:else}
  <section class="grp" aria-label="Group {n}">
    <header>
      <span class="ttl">Group {n}</span>
      <span class="dg-badge">{group.kind === 'exact' ? 'Exact copies' : 'Similar images'}</span>
      <span class="cnt">{group.members.length} items</span>
    </header>

    <div class="members">
      {#each group.members as m (m.libraryId + m.id)}
        {@const mine = inLibrary(m, libraryId)}
        {@const keep = keeperId === m.id}
        <div class="m" class:keep class:other={!mine}>
          <div class="th"><img src={m.thumbUrl} alt="" loading="lazy" /></div>
          {#if mine}
            <label class="pick"
              ><input
                type="radio"
                name="keep-{group.key}"
                checked={keep}
                onchange={() => onkeeper(m.id)}
              />{keep ? 'Keep this one' : 'Keep'}</label
            >
          {:else}
            <span
              class="pick left"
              title="Other libraries are opened read-only, so this copy can’t be changed"
              >In {m.libraryName}, left alone</span
            >
          {/if}
          <div class="nm" title="{m.name}.{m.ext}">{m.name}</div>
          <div class="meta">
            {m.ext.toUpperCase()} · {fileSize(m.size)}{#if m.width && m.height}
              · {m.width}×{m.height}{/if}
          </div>
          <div class="meta">
            Added {dateTime(m.importedAt).split(' ')[0]}{#if group.kind === 'similar'}
              · {likeness(m.distance)}{/if}
          </div>
          {#if mine && m.folders.length}
            <div class="chips">
              {#each m.folders.slice(0, MAX_CHIPS) as f (f)}<span
                  class="dg-chip fold"
                  title={folderName(f) ?? ''}>{folderName(f) ?? 'Folder'}</span
                >{/each}
              {#if m.folders.length > MAX_CHIPS}<span class="more"
                  >+{m.folders.length - MAX_CHIPS}</span
                >{/if}
            </div>
          {/if}
          {#if m.tags.length}
            <div class="chips">
              {#each m.tags.slice(0, MAX_CHIPS) as t (t)}<span class="dg-chip" title={t}>{t}</span
                >{/each}
              {#if m.tags.length > MAX_CHIPS}<span class="more">+{m.tags.length - MAX_CHIPS}</span
                >{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <footer>
      <span class="what">{mergeSentence(preview)}</span>
      <button
        class="dg-btn sm ghost"
        onclick={onhide}
        title="Hide this group until you close the finder">Not duplicates</button
      >
      <button
        class="dg-btn sm pri"
        disabled={!!blocked || merging || !preview.trashed}
        title={blocked ?? (preview.trashed ? undefined : 'Nothing in this library to merge')}
        onclick={onmerge}
      >
        {#if merging}<LoaderCircle size={13} class="dg-spin" />{/if}Merge
      </button>
    </footer>
  </section>
{/if}

<style>
  .grp {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.1);
    content-visibility: auto;
    contain-intrinsic-size: auto 300px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px 0;
    font-size: 12px;
  }
  .ttl {
    font-weight: 600;
  }
  .cnt {
    color: var(--fa);
  }
  .members {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    overflow-x: auto;
  }
  .m {
    flex: 0 0 172px;
    width: 172px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px;
    border-radius: 8px;
    border: 1px solid transparent;
    min-width: 0;
  }
  .m.keep {
    border-color: color-mix(in srgb, var(--bl) 60%, transparent);
    background: color-mix(in srgb, var(--bl) 7%, transparent);
  }
  .m.other {
    opacity: 0.8;
  }
  .th {
    height: 116px;
    border-radius: 6px;
    background: var(--thumb-bg);
    overflow: hidden;
    display: grid;
    place-items: center;
  }
  .th img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    margin-top: 3px;
    cursor: pointer;
    color: var(--mu);
  }
  .keep .pick {
    color: var(--link);
    font-weight: 600;
  }
  .pick input {
    margin: 0;
    accent-color: var(--bl);
  }
  .pick.left {
    cursor: default;
    color: var(--warn);
    font-size: 11.5px;
    line-height: 1.3;
  }
  .nm {
    font-size: 12.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 11.5px;
    color: var(--fa);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 2px;
    min-width: 0;
  }
  .chips .dg-chip {
    height: 19px;
    font-size: 11px;
    padding: 0 6px;
    display: inline-block;
    line-height: 17px;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .chips .fold {
    border-style: dashed;
    color: var(--mu);
  }
  .more {
    font-size: 11px;
    color: var(--fa);
    align-self: center;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
  }
  .what {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--mu);
    line-height: 1.4;
  }
  .done {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 12px;
    border-radius: 10px;
    border: 1px dashed var(--line);
    font-size: 12.5px;
    color: var(--mu);
  }
</style>
