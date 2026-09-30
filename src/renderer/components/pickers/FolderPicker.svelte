<script lang="ts">
  // Three overlays share this fuzzy folder list. "add" (F, Ctrl+Shift+J, like Eagle's F tool) adds
  // the selected items to a folder; Shift+Enter moves them out of the folder you are viewing
  // instead. "move" (M, the selection bar's Move to) is the other way round: Enter moves, Shift+Enter
  // adds. "goto" (Ctrl+J) just opens the folder.
  import type { Component } from 'svelte';
  import Folder from '@lucide/svelte/icons/folder';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import Images from '@lucide/svelte/icons/images';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Search from '@lucide/svelte/icons/search';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Tags from '@lucide/svelte/icons/tags';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { api } from '../../lib/api';
  import { canEdit, confirmBulk, fail, mutate, readOnlyTip } from '../../lib/edit';
  import { leaveFolders, rank } from '../../lib/folders';
  import { plural, quoted } from '../../lib/format';
  import { segments, type Segment } from '../../lib/fuzzy';
  import { pushRecent, readList } from '../../lib/storage';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { FOLDER_COLORS, type Scope } from '../../../shared/types';
  import { filterUi } from '../filters/filterUi.svelte';
  import { rememberFolder } from '../../lib/lastFolder';
  import Modal from './Modal.svelte';

  let {
    mode,
    ids,
    onclose,
  }: { mode: 'add' | 'move' | 'goto'; ids: string[]; onclose: () => void } = $props();

  interface Entry {
    key: string;
    kind: 'folder' | 'smart' | 'special';
    id: string;
    name: string;
    path: string;
    color: string | null;
    count: number | null;
    scope: Scope | null;
    icon: Component<any>;
  }
  interface Row {
    entry: Entry | null; // null = the "Create folder" row
    segs: Segment[];
    section: string;
  }

  const recentKey = `recentFolders.${library.state?.ref.id ?? 'none'}`;
  let text = $state('');
  let hi = $state(0);
  let busy = $state(false);
  let listEl = $state<HTMLDivElement | null>(null);

  const folderEntries = $derived<Entry[]>(
    [...library.folders].map(([id, f]) => ({
      key: `f:${id}`,
      kind: 'folder' as const,
      id,
      name: f.node.name,
      path: f.path.join(' › '),
      color: f.node.iconColor ? FOLDER_COLORS[f.node.iconColor] : null,
      count: library.counts?.folders[id]?.deep ?? null,
      scope: { kind: 'folder' as const, id, includeSubfolders: view.showSubfolderContents },
      icon: Folder,
    })),
  );

  // Go to also knows smart folders and the built-in views.
  const extraEntries = $derived<Entry[]>(
    mode === 'goto'
      ? [
          ...[...library.smartFolders.values()].map((s) => ({
            key: `s:${s.id}`,
            kind: 'smart' as const,
            id: s.id,
            name: s.name,
            path: s.name,
            color: s.iconColor ? FOLDER_COLORS[s.iconColor] : null,
            count: library.counts?.smartFolders[s.id] ?? null,
            scope: { kind: 'smartFolder' as const, id: s.id },
            icon: Sparkles,
          })),
          ...(
            [
              ['All', { kind: 'all' }, Images, library.counts?.all],
              ['Uncategorized', { kind: 'uncategorized' }, Inbox, library.counts?.uncategorized],
              ['Untagged', { kind: 'untagged' }, Tags, library.counts?.untagged],
              ['Trash', { kind: 'trash' }, Trash2, library.counts?.trash],
              ['Random', { kind: 'random', seed: Date.now() % 100000 }, Shuffle, undefined],
            ] as [string, Scope, Component<any>, number | undefined][]
          ).map(([name, scope, icon, count]) => ({
            key: `v:${name}`,
            kind: 'special' as const,
            id: name,
            name,
            path: name,
            color: null,
            count: count ?? null,
            scope,
            icon,
          })),
        ]
      : [],
  );

  const rows = $derived.by<Row[]>(() => {
    const q = text.trim();
    const out: Row[] = [];
    if (!q) {
      const byId = new Map(folderEntries.map((e) => [e.id, e]));
      const recent = readList(recentKey)
        .map((id) => byId.get(id))
        .filter((e): e is Entry => !!e)
        .slice(0, 8);
      for (const e of recent)
        out.push({ entry: e, segs: [{ text: e.path, hit: false }], section: 'Recent' });
      for (const e of folderEntries.slice(0, 300)) {
        if (!recent.includes(e))
          out.push({ entry: e, segs: [{ text: e.path, hit: false }], section: 'All folders' });
      }
      return out;
    }
    const scored: { row: Row; score: number }[] = [];
    for (const e of [...folderEntries, ...extraEntries]) {
      const hit = rank(q, e.name, e.path);
      if (hit)
        scored.push({
          row: {
            entry: e,
            segs: segments(e.path, hit.positions),
            section: e.kind === 'folder' ? 'Folders' : 'Go to',
          },
          score: hit.score,
        });
    }
    scored.sort((a, b) => b.score - a.score || a.row.entry!.path.length - b.row.entry!.path.length);
    out.push(...scored.slice(0, 60).map((s) => s.row));
    const exact = folderEntries.some((e) => e.name.toLowerCase() === q.toLowerCase());
    if (mode !== 'goto' && !exact)
      out.push({
        entry: null,
        segs: [{ text: `Create folder ${quoted(q)}`, hit: false }],
        section: 'New',
      });
    return out;
  });

  // The highlighted row, kept inside the list as it changes (typing starts it over at the top).
  const at = $derived(Math.min(hi, Math.max(rows.length - 1, 0)));

  const scope = $derived(view.scope);
  const fromFolder = $derived(
    scope.kind === 'folder' ? library.folder(scope.id)?.node.name : undefined,
  );

  /** Enter moves in "move" mode and Shift+Enter in "add" mode, when there is a folder to leave. */
  const wantsMove = (shift: boolean) => (mode === 'move') !== shift && !!fromFolder;

  async function run(row: Row, shift: boolean) {
    if (busy) return;
    if (mode === 'goto') {
      const e = row.entry;
      if (!e?.scope) return;
      onclose();
      if (e.kind === 'folder') pushRecent(recentKey, e.id);
      view.setScope(e.scope, { keepFilter: filterUi.lock });
      return;
    }
    if (!ids.length || !canEdit()) return;
    const targetName = row.entry?.name ?? text.trim();
    const move = wantsMove(shift) && scope.kind === 'folder' && scope.id !== row.entry?.id;
    const n = plural(ids.length, 'item');
    // Ask before anything is written, so a "no" doesn't leave a new empty folder behind.
    if (
      !(await confirmBulk(ids.length, {
        what: `${move ? 'move' : 'add'} ${n} to ${quoted(targetName)}`,
      }))
    )
      return;
    busy = true;
    try {
      const targetId = row.entry?.id ?? (await api.createFolder(targetName, null)).id;
      const leave = move ? leaveFolders(scope, targetId) : [];
      const res = await mutate(
        () =>
          api.updateItems(
            ids,
            leave.length
              ? { addFolders: [targetId], removeFolders: leave }
              : { addFolders: [targetId] },
          ),
        `${leave.length ? 'Moved' : 'Added'} ${n} to ${quoted(targetName)}`,
      );
      if (res) {
        rememberFolder(targetId);
        pushRecent(recentKey, targetId);
        onclose();
      }
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') hi = Math.min(at + 1, rows.length - 1);
    else if (e.key === 'ArrowUp') hi = Math.max(at - 1, 0);
    else if (e.key === 'Enter') {
      if (rows[at]) void run(rows[at], e.shiftKey);
    } else return;
    e.preventDefault();
    if (e.key !== 'Enter')
      void Promise.resolve().then(() =>
        listEl?.querySelector('.row.hi')?.scrollIntoView({ block: 'nearest' }),
      );
  }

  const verb = $derived(mode === 'move' && fromFolder ? 'Move' : 'Add');
  const title = $derived(
    mode === 'goto'
      ? 'Go to folder'
      : ids.length
        ? `${verb} ${plural(ids.length, 'item')} to a folder`
        : `${verb} to a folder`,
  );
</script>

<Modal {onclose} label={title} width={560}>
  <div class="in">
    <Search size={17} />
    <input
      data-autofocus
      placeholder={mode === 'goto' ? 'Go to a folder' : 'Find a folder, or type a new name'}
      aria-label={mode === 'goto' ? 'Go to a folder' : 'Find a folder'}
      autocomplete="off"
      spellcheck="false"
      bind:value={text}
      oninput={() => (hi = 0)}
      onkeydown={onkey}
    />
    <span class="ctx">{title}</span>
  </div>
  {#if mode !== 'goto' && !ids.length}
    <p class="empty">Select some items first.</p>
  {:else if mode !== 'goto' && library.readOnly}
    <p class="empty ro">{readOnlyTip()}</p>
  {/if}
  <div class="list" bind:this={listEl} role="listbox" aria-label="Folders">
    {#each rows as row, i (row.section + ':' + (row.entry?.key ?? 'new'))}
      {@const e = row.entry}
      {#if i === 0 || rows[i - 1].section !== row.section}<h6>{row.section}</h6>{/if}
      <div
        class="row"
        class:hi={i === at}
        role="option"
        tabindex="-1"
        aria-selected={i === at}
        onmousedown={(ev) => ev.preventDefault()}
        onclick={(ev) => run(row, ev.shiftKey)}
        onkeydown={() => {}}
        onmousemove={() => (hi = i)}
      >
        {#if e}
          <e.icon
            size={16}
            style={e.color ? `color:${e.color};fill:${e.color}` : 'color:var(--mu)'}
          />
        {:else}
          <FolderPlus size={16} />
        {/if}
        <span class="nm"
          >{#each row.segs as s, j (j)}{#if s.hit}<mark>{s.text}</mark
              >{:else}{s.text}{/if}{/each}</span
        >
        {#if e?.count !== null && e}<span class="d">{e.count!.toLocaleString()}</span
          >{:else if !e}<span class="d">top level</span>{/if}
      </div>
    {:else}
      <p class="empty">No folder matches.</p>
    {/each}
  </div>
  <div class="foot">
    <span>↑ ↓ to move</span>
    {#if mode === 'goto'}<span>Enter to open</span>
    {:else if !fromFolder}<span>Enter to add</span>
    {:else if mode === 'move'}<span>Enter to move out of {fromFolder}</span><span
        >Shift Enter to add</span
      >
    {:else}<span>Enter to add</span><span>Shift Enter to move out of {fromFolder}</span>{/if}
    <span>Esc to close</span>
  </div>
</Modal>

<style>
  .in {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    color: var(--fa);
    flex: none;
  }
  .in input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: none;
    border: 0;
    outline: none;
    font-size: 15px;
    color: var(--tx);
  }
  .in input::placeholder {
    color: var(--fa);
  }
  .ctx {
    font-size: 12px;
    white-space: nowrap;
  }
  .list {
    overflow: auto;
    min-height: 0;
    max-height: 380px;
    padding: 4px 8px 8px;
  }
  h6 {
    margin: 10px 10px 4px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 11px;
    height: 36px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 13.5px;
    cursor: default;
  }
  .row.hi {
    background: var(--bls);
  }
  .row :global(svg) {
    flex: none;
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
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    margin: 12px 18px;
    font-size: 12.5px;
    color: var(--fa);
  }
  .ro {
    color: var(--warn);
  }
  .foot {
    display: flex;
    gap: 16px;
    padding: 10px 18px;
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--fa);
    flex: none;
  }
</style>
