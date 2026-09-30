// What the command palette lists for a given input. Pure: the component feeds it the typed text,
// the selection size, suggestions from the core and the enabled commands, and gets back sections of
// rows, each carrying a plain description of what Enter does.
import { fuzzy, fuzzyTight, segments, type Segment } from '../../lib/fuzzy';
import { quoted } from '../../lib/format';

export type PaletteAction =
  | { kind: 'search'; text: string }
  | { kind: 'clearSearch' }
  | { kind: 'addTag'; tag: string }
  | { kind: 'showTag'; tag: string }
  | { kind: 'goFolder'; id: string; folder: 'folder' | 'smartFolder' }
  | { kind: 'addToFolder'; id: string; name: string }
  | { kind: 'command'; id: string }
  | { kind: 'library'; path: string };

export interface PaletteRow {
  key: string;
  icon: string; // lucide name
  segs: Segment[];
  detail?: string;
  /** Shortcut to show on the right, e.g. "Ctrl Z". */
  keys?: string;
  action: PaletteAction;
}

export interface PaletteSection {
  title: string;
  rows: PaletteRow[];
}

export interface PaletteInput {
  text: string;
  selectionCount: number;
  canEdit: boolean;
  currentKeywords: string;
  tagSuggestions: { label: string; count: number }[];
  folderSuggestions: {
    kind: 'folder' | 'smartFolder';
    id: string;
    label: string;
    path: string;
    count: number;
  }[];
  knownTags: string[];
  commands: { id: string; title: string; keys?: string[]; icon?: string }[];
  recentCommandIds: string[];
  /** The last few searches in this library, newest first (Eagle keeps 5). */
  recentSearches?: string[];
  libraries: { path: string; name: string }[];
}

const plain = (text: string): Segment => ({ text, hit: false });
const selected = (n: number) => `${n.toLocaleString()} selected`;

/** Commands worth showing before you type anything. */
const SUGGESTED = [
  'app.search',
  'filter.menu',
  'folder.goTo',
  'item.tags',
  'item.folderPicker',
  'item.rename',
  'edit.undo',
  'import.files',
  'dupes.open',
];

function commandRow(c: PaletteInput['commands'][number], positions?: number[]): PaletteRow {
  return {
    key: `cmd:${c.id}`,
    icon: c.icon ?? 'command',
    segs: segments(c.title, positions),
    keys: c.keys?.[0]?.replace(/\+/g, ' ').replace('Arrow', ''),
    action: { kind: 'command', id: c.id },
  };
}

export function buildPalette(input: PaletteInput): PaletteSection[] {
  const text = input.text.trim();
  const sections: PaletteSection[] = [];
  const add = (title: string, rows: PaletteRow[]) => rows.length && sections.push({ title, rows });
  const byId = new Map(input.commands.map((c) => [c.id, c]));

  if (!text) {
    if (input.currentKeywords) {
      add('Search', [
        {
          key: 'clear',
          icon: 'x',
          segs: [plain(`Clear search ${quoted(input.currentKeywords)}`)],
          action: { kind: 'clearSearch' },
        },
      ]);
    }
    add(
      'Recent searches',
      (input.recentSearches ?? [])
        .filter((q) => q !== input.currentKeywords)
        .slice(0, 5)
        .map((q) => ({
          key: `recentSearch:${q}`,
          icon: 'clock',
          segs: [plain(q)],
          action: { kind: 'search', text: q },
        })),
    );
    const recent = input.recentCommandIds
      .map((id) => byId.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .slice(0, 5);
    add(
      'Recent',
      recent.map((c) => commandRow(c)),
    );
    const shown = new Set(recent.map((c) => c.id));
    const suggested = SUGGESTED.map((id) => byId.get(id)).filter(
      (c): c is NonNullable<typeof c> => !!c && !shown.has(c.id),
    );
    for (const c of input.commands)
      if (suggested.length < 8 && c.keys?.length && !shown.has(c.id) && !suggested.includes(c))
        suggested.push(c);
    add(
      'Commands',
      suggested.slice(0, 8).map((c) => commandRow(c)),
    );
    return sections;
  }

  add('Search', [
    {
      key: 'search',
      icon: 'search',
      segs: [plain(`Search for ${quoted(text)}`)],
      action: { kind: 'search', text: input.text },
    },
  ]);

  // Tags: with a selection you can add the tag to it; you can always show what has the tag.
  const withSel = input.selectionCount > 0 && input.canEdit;
  const tagRows: PaletteRow[] = [];
  for (const t of input.tagSuggestions.slice(0, withSel ? 2 : 3)) {
    const pos = fuzzy(text, t.label)?.positions;
    if (withSel) {
      tagRows.push({
        key: `addTag:${t.label}`,
        icon: 'tag',
        segs: [
          plain('Add tag '),
          ...segments(t.label, pos),
          plain(` to ${selected(input.selectionCount)}`),
        ],
        action: { kind: 'addTag', tag: t.label },
      });
    }
    tagRows.push({
      key: `showTag:${t.label}`,
      icon: 'list-filter',
      segs: [plain('Show items tagged '), ...segments(t.label, pos)],
      detail: `${t.count.toLocaleString()} ${t.count === 1 ? 'item' : 'items'}`,
      action: { kind: 'showTag', tag: t.label },
    });
  }
  if (
    withSel &&
    text.length <= 60 &&
    !input.knownTags.some((k) => k.toLowerCase() === text.toLowerCase())
  ) {
    tagRows.push({
      key: 'createTag',
      icon: 'tag',
      segs: [plain(`Create tag ${quoted(text)} and add to ${selected(input.selectionCount)}`)],
      action: { kind: 'addTag', tag: text },
    });
  }
  add('Tags', tagRows);

  const folderRows: PaletteRow[] = [];
  input.folderSuggestions.slice(0, 4).forEach((f, i) => {
    const pos = fuzzy(text, f.path)?.positions;
    folderRows.push({
      key: `go:${f.id}`,
      icon: f.kind === 'smartFolder' ? 'sparkles' : 'folder',
      segs: [plain('Go to '), ...segments(f.path, pos)],
      detail: f.count.toLocaleString(),
      action: { kind: 'goFolder', id: f.id, folder: f.kind },
    });
    if (withSel && f.kind === 'folder' && i < 2) {
      folderRows.push({
        key: `addTo:${f.id}`,
        icon: 'folder-input',
        segs: [plain(`Add ${selected(input.selectionCount)} to `), ...segments(f.path, pos)],
        action: { kind: 'addToFolder', id: f.id, name: f.label },
      });
    }
  });
  add('Folders', folderRows);

  const cmds = input.commands
    .map((c) => ({ c, hit: fuzzyTight(text, c.title) }))
    .filter(
      (
        x,
      ): x is {
        c: PaletteInput['commands'][number];
        hit: NonNullable<ReturnType<typeof fuzzyTight>>;
      } => !!x.hit,
    )
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, 6);
  add(
    'Commands',
    cmds.map(({ c, hit }) => commandRow(c, hit.positions)),
  );
  // Typing the start of a command's name ("manage tags", "settings") means that command: list the
  // commands first so Enter runs it instead of searching the library for the words.
  const lower = text.toLowerCase();
  const named =
    lower.length >= 4 &&
    cmds.some(({ c }) => c.title.toLowerCase().replace(/…$/, '').startsWith(lower));
  if (named) {
    const i = sections.findIndex((x) => x.title === 'Commands');
    sections.unshift(...sections.splice(i, 1));
  }

  const libs = input.libraries
    .map((l) => ({ l, hit: fuzzyTight(text, l.name) }))
    .filter(
      (
        x,
      ): x is {
        l: PaletteInput['libraries'][number];
        hit: NonNullable<ReturnType<typeof fuzzyTight>>;
      } => !!x.hit,
    )
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, 3);
  add(
    'Libraries',
    libs.map(({ l, hit }) => ({
      key: `lib:${l.path}`,
      icon: 'library',
      segs: [plain('Switch to '), ...segments(l.name, hit.positions)],
      action: { kind: 'library', path: l.path },
    })),
  );

  return sections;
}
