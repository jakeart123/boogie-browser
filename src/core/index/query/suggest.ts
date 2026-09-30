// Fuzzy suggestions for tag inputs, "go to folder" and the command bar. Eagle's "mki" finds
// "Mockup iPhone": the letters just have to appear in order. Ranking: label starts with the text >
// the text starts a word in the label > letters appear in order (in the label, or for folders in
// the whole "Parent / Child" path), then the higher item count wins.
import type Database from 'better-sqlite3';
import type { EagleSmartFolderRecord, TagInfo } from '../../../shared/types';
import { flattenSmartFolders } from './smartFolders';

export type SuggestKind = 'tag' | 'folder' | 'smartFolder';

export interface SuggestEntry {
  kind: SuggestKind;
  id: string;
  label: string;
  path: string;
  count: number;
}

const MARKS = /\p{M}+/gu;
const foldChar = (c: string): string => c.normalize('NFD').replace(MARKS, '').toLowerCase();

export const fold = (s: string): string => s.normalize('NFD').replace(MARKS, '').toLowerCase();

interface Folded {
  text: string;
  /** Offsets (into `text`) where a word starts: after a non-letter/digit, or a lower-to-UPPER camel hump. */
  wordStarts: Set<number>;
}

const foldedCache = new Map<string, Folded>();

function foldWithWords(label: string): Folded {
  const hit = foldedCache.get(label);
  if (hit) return hit;
  let text = '';
  const wordStarts = new Set<number>();
  let prev = '';
  for (const ch of label) {
    const alnum = /[\p{L}\p{N}]/u.test(ch);
    const prevAlnum = prev !== '' && /[\p{L}\p{N}]/u.test(prev);
    const camel = /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(ch);
    if (alnum && (!prevAlnum || camel)) wordStarts.add(text.length);
    text += foldChar(ch);
    prev = ch;
  }
  if (foldedCache.size > 50_000) foldedCache.clear();
  const folded = { text, wordStarts };
  foldedCache.set(label, folded);
  return folded;
}

function isSubsequence(needle: string, hay: string): number | null {
  let j = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      if (first < 0) first = i;
      last = i;
      j++;
    }
  }
  return j === needle.length ? last - first : null;
}

/** 0 prefix, 1 word start, 2 letters in order in the label, 3 letters in order in the path; null = no match. */
export function matchClass(
  query: string,
  label: string,
  path: string,
): { cls: number; span: number } | null {
  const q = fold(query).trim();
  if (!q) return { cls: 0, span: 0 };
  const { text, wordStarts } = foldWithWords(label);
  if (text.startsWith(q)) return { cls: 0, span: 0 };

  const tokens = q.split(/\s+/).filter(Boolean);
  const startsWord = (tok: string): boolean => {
    for (const at of wordStarts) if (text.startsWith(tok, at)) return true;
    return false;
  };
  if (tokens.every(startsWord)) return { cls: 1, span: 0 };

  const letters = q.replace(/\s+/g, '');
  const inLabel = isSubsequence(letters, text);
  if (inLabel !== null) return { cls: 2, span: inLabel };
  if (path && path !== label) {
    const inPath = isSubsequence(letters, fold(path));
    if (inPath !== null) return { cls: 3, span: inPath };
  }
  return null;
}

export function rankSuggestions(
  entries: SuggestEntry[],
  text: string,
  limit: number,
): SuggestEntry[] {
  const scored: { e: SuggestEntry; cls: number; span: number }[] = [];
  for (const e of entries) {
    const m = matchClass(text, e.label, e.path);
    if (m) scored.push({ e, cls: m.cls, span: m.span });
  }
  scored.sort(
    (a, b) =>
      a.cls - b.cls ||
      b.e.count - a.e.count ||
      a.span - b.span ||
      a.e.label.length - b.e.label.length ||
      a.e.label.localeCompare(b.e.label),
  );
  return scored.slice(0, Math.max(0, limit)).map((s) => s.e);
}

// ───────────────────────── corpora ─────────────────────────

/** Tags from index.tags(): live counts plus tags that only live in a tag group (count 0). */
export function tagEntries(tags: TagInfo[]): SuggestEntry[] {
  return tags.map((t) => ({ kind: 'tag', id: t.name, label: t.name, path: '', count: t.count }));
}

/** Every folder with its "Parent / Child" path and live item count. */
export function folderEntries(db: Database.Database): SuggestEntry[] {
  const counts = new Map<string, number>();
  for (const r of db
    .prepare(
      'SELECT f.folder_id AS id, COUNT(*) AS n FROM item_folders f JOIN items i ON i.rowid = f.item_rowid WHERE i.is_deleted = 0 GROUP BY f.folder_id',
    )
    .all() as { id: string; n: number }[]) {
    counts.set(r.id, r.n);
  }
  return (
    db.prepare('SELECT id, name, path FROM folders').all() as {
      id: string;
      name: string;
      path: string;
    }[]
  ).map((f) => ({
    kind: 'folder',
    id: f.id,
    label: f.name,
    path: f.path,
    count: counts.get(f.id) ?? 0,
  }));
}

export function smartFolderEntries(
  tree: EagleSmartFolderRecord[],
  counts: Record<string, number>,
): SuggestEntry[] {
  return flattenSmartFolders(tree).map(({ node, path }) => ({
    kind: 'smartFolder',
    id: node.id,
    label: String(node.name ?? ''),
    path,
    count: counts[node.id] ?? 0,
  }));
}
