<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Search from '@lucide/svelte/icons/search';
  import { api } from '../../lib/api';
  import { commands, focus, type CommandContext } from '../../lib/commands.svelte';
  import { editItems, fail } from '../../lib/edit';
  import { plural, quoted } from '../../lib/format';
  import { pushRecent, readList } from '../../lib/storage';
  import { canonicalTag } from '../../lib/tags';
  import { library } from '../../lib/stores/library.svelte';
  import { selection } from '../../lib/stores/selection.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { filterUi } from '../filters/filterUi.svelte';
  import { iconFor } from '../pickers/icons';
  import { rememberFolder } from '../../lib/lastFolder';
  import Modal from '../pickers/Modal.svelte';
  import { buildPalette, type PaletteRow } from './paletteModel';

  let { initial, onclose }: { initial: string; onclose: () => void } = $props();

  const RECENT_KEY = 'recentCommands';
  let text = $state(untrack(() => initial));
  let hi = $state(0);
  let sugg = $state.raw<{
    tags: { label: string; count: number }[];
    folders: Parameters<typeof buildPalette>[0]['folderSuggestions'];
  }>({ tags: [], folders: [] });
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  const recentIds = readList(RECENT_KEY);
  const searchKey = `recentSearches.${library.state?.ref.id ?? 'none'}`;
  const recentSearches = readList(searchKey);
  // Commands are judged from where you opened the palette (the grid, the sidebar, the viewer...),
  // not from the palette itself, so it offers what the window behind it can do. Read before this
  // palette's own overlay takes the keyboard.
  const from: CommandContext = untrack(() => ({
    region: focus.region === 'overlay' ? focus.underOverlay : focus.region,
  }));

  const sections = $derived(
    buildPalette({
      text,
      selectionCount: selection.count,
      canEdit: !library.readOnly,
      currentKeywords: view.filter.keywords ?? '',
      tagSuggestions: sugg.tags,
      folderSuggestions: sugg.folders,
      knownTags: library.tags.map((t) => t.name),
      commands: commands.enabled(from).filter((c) => !c.hidden),
      recentCommandIds: recentIds,
      recentSearches,
      libraries: library.known
        .filter((k) => k.exists && k.path !== library.state?.ref.path)
        .map((k) => ({ path: k.path, name: k.name })),
    }),
  );
  const flat = $derived(sections.flatMap((s) => s.rows));
  // Index of each section's first row, for Tab.
  const starts = $derived(
    sections.map((_, i) => sections.slice(0, i).reduce((n, s) => n + s.rows.length, 0)),
  );

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  // Ask the core for tag and folder matches as you type (debounced; a late answer is dropped).
  let seq = 0;
  $effect(() => {
    const q = text.trim();
    hi = 0;
    const mine = ++seq;
    if (!q) return void (sugg = { tags: [], folders: [] });
    const t = setTimeout(async () => {
      try {
        const [tags, folders] = await Promise.all([
          api.suggest(q, ['tag'], 8),
          api.suggest(q, ['folder', 'smartFolder'], 10),
        ]);
        if (mine !== seq) return;
        sugg = {
          tags: tags.map((r) => ({ label: r.label, count: r.count })),
          folders: folders
            .filter((r) => r.kind !== 'tag')
            // The core writes paths as "Parent / Child"; the rest of the UI shows "Parent › Child".
            .map((r) => ({
              kind: r.kind as 'folder' | 'smartFolder',
              id: r.id,
              label: r.label,
              path: library.folder(r.id)?.path.join(' › ') ?? r.path,
              count: r.count,
            })),
        };
      } catch {
        /* the search and command rows still work without suggestions */
      }
    }, 60);
    return () => clearTimeout(t);
  });

  async function run(row: PaletteRow) {
    const a = row.action;
    const ids = selection.inOrder(view.result?.ids);
    // Close first and let the palette unmount: the action may open another overlay, and a command
    // must run with the keyboard back where the palette was opened from.
    onclose();
    await tick();
    try {
      switch (a.kind) {
        case 'search': {
          const q = a.text.trim();
          view.setFilter({ keywords: q || undefined });
          if (q) pushRecent(searchKey, q, 5);
          break;
        }
        case 'clearSearch':
          view.setFilter({ keywords: undefined });
          break;
        case 'addTag': {
          const tag = canonicalTag(a.tag);
          await editItems(
            ids,
            { addTags: [tag] },
            {
              done: `Added the tag ${quoted(tag)} to ${plural(ids.length, 'item')}`,
            },
          );
          break;
        }
        case 'showTag':
          view.setScope({ kind: 'tag', name: a.tag }, { keepFilter: filterUi.lock });
          break;
        case 'goFolder':
          view.setScope(
            a.folder === 'folder'
              ? { kind: 'folder', id: a.id, includeSubfolders: view.showSubfolderContents }
              : { kind: 'smartFolder', id: a.id },
            { keepFilter: filterUi.lock },
          );
          break;
        case 'addToFolder':
          if (
            await editItems(
              ids,
              { addFolders: [a.id] },
              {
                done: `Added ${plural(ids.length, 'item')} to ${quoted(a.name)}`,
              },
            )
          )
            rememberFolder(a.id);
          break;
        case 'command':
          pushRecent(RECENT_KEY, a.id, 5);
          if (!(await commands.run(a.id))) ui.toast('That can’t run here', { kind: 'warn' });
          break;
        case 'library':
          await library.open(a.path); // the store starts the view over for the new library
          break;
      }
    } catch (e) {
      fail(e);
    }
  }

  function move(to: number) {
    if (!flat.length) return;
    hi = (to + flat.length) % flat.length;
    void tick().then(() => listEl?.querySelector('.po.on')?.scrollIntoView({ block: 'nearest' }));
  }

  function jumpSection(dir: 1 | -1) {
    if (!starts.length) return;
    let cur = starts.findLastIndex((s) => s <= hi);
    cur = (cur + dir + starts.length) % starts.length;
    move(starts[cur]);
  }

  function onkey(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') move(hi + 1);
    else if (e.key === 'ArrowUp') move(hi - 1);
    else if (e.key === 'Tab') jumpSection(e.shiftKey ? -1 : 1);
    else if (e.key === 'Enter') {
      if (flat[hi]) void run(flat[hi]);
    } else return;
    e.preventDefault();
  }
</script>

<Modal {onclose} label="Command palette" width={640} top="13vh">
  <!-- Clicks anywhere in the palette keep the keyboard in its input, so keys never reach the
       window behind while it's open. -->
  <div
    class="pal"
    role="presentation"
    onmousedown={(e) => e.target !== inputEl && e.preventDefault()}
  >
    <div class="pin">
      <Search size={18} />
      <input
        bind:this={inputEl}
        data-autofocus
        placeholder="Search, filter, or run a command"
        aria-label="Search, filter, or run a command"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        autocomplete="off"
        spellcheck="false"
        bind:value={text}
        onkeydown={onkey}
      />
      {#if selection.count}<span class="ctx">{selection.count.toLocaleString()} selected</span>{/if}
    </div>
    <div class="pg" id="palette-list" role="listbox" bind:this={listEl}>
      {#each sections as sec, si (sec.title)}
        <h6>{sec.title}</h6>
        {#each sec.rows as row, ri (row.key)}
          {@const i = starts[si] + ri}
          {@const Icon = iconFor(row.icon)}
          <div
            class="po"
            class:on={i === hi}
            role="option"
            tabindex="-1"
            aria-selected={i === hi}
            onmousedown={(ev) => ev.preventDefault()}
            onclick={() => run(row)}
            onkeydown={() => {}}
            onmousemove={() => (hi = i)}
          >
            <Icon size={16} />
            <span class="lb"
              >{#each row.segs as s, j (j)}{#if s.hit}<mark>{s.text}</mark
                  >{:else}{s.text}{/if}{/each}</span
            >
            {#if row.detail}<span class="d">{row.detail}</span>{/if}
            {#if row.keys}<kbd>{row.keys}</kbd>{:else if i === hi}<kbd>Enter</kbd>{/if}
          </div>
        {/each}
      {/each}
    </div>
    <div class="pfoot">
      <span>↑ ↓ to move</span><span>Enter to run</span><span>Tab for the next group</span><span
        >Esc to close</span
      >
    </div>
  </div>
</Modal>

<style>
  .pal {
    display: contents;
  }
  .pin {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 54px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    color: var(--fa);
    flex: none;
  }
  .pin input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: none;
    border: 0;
    outline: none;
    font-size: 16px;
    color: var(--tx);
    caret-color: var(--link);
  }
  .pin input::placeholder {
    color: var(--fa);
  }
  .ctx {
    font-size: 12px;
    white-space: nowrap;
  }
  .pg {
    padding: 4px 8px 6px;
    overflow: auto;
    min-height: 0;
  }
  h6 {
    margin: 0;
    padding: 10px 10px 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
  }
  .po {
    display: flex;
    align-items: center;
    gap: 11px;
    height: 38px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 13.5px;
    cursor: default;
  }
  .po :global(svg) {
    color: var(--mu);
    flex: none;
  }
  .po.on {
    background: var(--bls);
  }
  .lb {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .d {
    color: var(--fa);
    font-size: 12.5px;
    white-space: nowrap;
  }
  .po kbd {
    margin-left: auto;
  }
  .lb + .d + kbd,
  .lb + kbd {
    margin-left: auto;
  }
  .lb:has(+ .d) {
    flex: 0 1 auto;
  }
  mark {
    background: none;
    color: var(--link);
    font-weight: 600;
  }
  .pfoot {
    display: flex;
    gap: 16px;
    padding: 10px 18px;
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--fa);
    flex: none;
  }
</style>
