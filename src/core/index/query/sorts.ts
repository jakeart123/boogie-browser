// Sort helpers: the SQL for the sorts that SQLite can do alone, the JS keys for the ones it can't
// (natural NAME, seeded RANDOM), and the Eagle sortIncrease <-> ascending mapping.
import type { OrderBy, SortSpec } from '../../../shared/types';
import { timeOrImport } from './sql';

export const ORDER_BYS: readonly OrderBy[] = [
  'IMPORT',
  'NAME',
  'EXT',
  'RESOLUTION',
  'FILESIZE',
  'RATING',
  'DURATION',
  'BTIME',
  'MTIME',
  'TAGS',
  'MANUAL',
  'RANDOM',
];

export const isOrderBy = (v: unknown): v is OrderBy =>
  typeof v === 'string' && (ORDER_BYS as readonly string[]).includes(v);

export const DEFAULT_SORT: SortSpec = { by: 'IMPORT', ascending: false };

/**
 * SortSpec.ascending is literal: ascending NAME is A to Z, ascending IMPORT is oldest first.
 * Eagle's folder field `sortIncrease` is not: it means "the order Eagle's own sort function
 * produces" (research: app.bundle.js sortData + `if (!sortIncrease) data.reverse()`), and that
 * base order is descending for IMPORT, BTIME, MTIME and MANUAL (newest / top first).
 */
const BASE_ASCENDING: Record<OrderBy, boolean> = {
  IMPORT: false,
  BTIME: false,
  MTIME: false,
  MANUAL: false,
  NAME: true,
  EXT: true,
  RESOLUTION: true,
  FILESIZE: true,
  RATING: true,
  DURATION: true,
  TAGS: true,
  RANDOM: true,
};

/** Folder/smart folder `sortIncrease` (Eagle's meaning) to a literal SortSpec.ascending. */
export function ascendingFromSortIncrease(by: OrderBy, sortIncrease: boolean): boolean {
  return BASE_ASCENDING[by] ? sortIncrease : !sortIncrease;
}

/** The inverse, for callers that write a folder's sort back to root metadata.json. */
export function sortIncreaseFromAscending(by: OrderBy, ascending: boolean): boolean {
  return BASE_ASCENDING[by] ? ascending : !ascending;
}

/**
 * Folder's own sort from its root-record fields. Eagle reverses the base order whenever
 * `sortIncrease` is not truthy (even when the key is missing), so a missing key means reversed.
 */
export function folderSort(orderBy: unknown, sortIncrease: unknown): SortSpec | null {
  if (!isOrderBy(orderBy)) return null;
  return {
    by: orderBy,
    ascending: ascendingFromSortIncrease(orderBy, sortIncrease === true || sortIncrease === 1),
  };
}

// ── SQL ORDER BY for the sorts SQLite can do without help ──

export interface SqlOrder {
  expr: string;
  params: unknown[];
}

/** null = this sort needs the JS path. `manualFolderId` is the folder whose `order` key MANUAL uses. */
export function sqlOrderExpr(by: OrderBy, manualFolderId: string | null): SqlOrder | null {
  switch (by) {
    case 'IMPORT':
      return { expr: 'i.imported_at', params: [] };
    case 'EXT':
      return { expr: 'i.ext COLLATE NOCASE', params: [] };
    case 'RESOLUTION':
      return { expr: '(COALESCE(i.width, 0) * COALESCE(i.height, 0))', params: [] };
    case 'FILESIZE':
      return { expr: 'i.size', params: [] };
    case 'RATING':
      return { expr: 'i.star', params: [] };
    case 'DURATION':
      return { expr: 'COALESCE(i.duration, 0)', params: [] };
    // Eagle's own TAGS order (first tag's name) is not in its menus. Ours is the "Number of tags" sort the UI offers.
    case 'TAGS':
      return { expr: 'i.tag_count', params: [] };
    // Eagle's Date Created / Date Modified are the source file's times (item.btime / item.mtime),
    // falling back to the import time. NOT lastModified (that is "last time a library edit touched it").
    case 'BTIME':
      return { expr: timeOrImport('btime'), params: [] };
    case 'MTIME':
      return { expr: timeOrImport('mtime'), params: [] };
    case 'MANUAL':
      // TEXT compare (format-spec §9): the key is item.order[folder] (an empty value counts as
      // missing, like Eagle's truthiness test), else String(modificationTime).
      if (manualFolderId === null) return { expr: 'i.imported_at_str', params: [] };
      return {
        expr: `COALESCE(NULLIF((SELECT f.ord FROM item_folders f WHERE f.item_rowid = i.rowid AND f.folder_id = ?), ''), i.imported_at_str)`,
        params: [manualFolderId],
      };
    default:
      return null;
  }
}

// ── natural, case-insensitive name key ──

const NON_ASCII = /[^\x00-\x7f]/;
// ICU (which Eagle's collator uses) orders spaces and punctuation before digits, and in its own
// order among themselves ("-" before "(" before "~"), not in ASCII order. Ask the runtime's ICU for
// that order once and give each of those characters a rank character below "0" in the key.
const PUNCT_RANK = (() => {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const punct = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter(
    (c) => !/[0-9A-Za-z]/.test(c),
  );
  punct.sort((a, b) => collator.compare(a, b));
  return new Map(punct.map((c, i) => [c, String.fromCharCode(1 + i)]));
})();
const ASCII_PUNCT = /[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g;
const keyCache = new Map<string, string>();

/**
 * A string that compares (plain `<`) the way Eagle's Intl.Collator({numeric, sensitivity:'base'})
 * orders names: case and accents ignored, digit runs compared as numbers, punctuation in ICU order.
 * An approximation (not full ICU: no ligature or script rules), built so the result is a plain
 * string we can sort 85k of in tens of ms.
 */
export function naturalKey(name: string): string {
  const hit = keyCache.get(name);
  if (hit !== undefined) return hit;
  let s = name;
  if (NON_ASCII.test(s)) s = s.normalize('NFD').replace(/\p{M}+/gu, '');
  s = s
    .toLowerCase()
    .replace(ASCII_PUNCT, (c) => PUNCT_RANK.get(c) ?? c)
    .replace(/\d+/g, (d) => (d.length >= 20 ? d : '0'.repeat(20 - d.length) + d));
  if (keyCache.size > 300_000) keyCache.clear();
  keyCache.set(name, s);
  return s;
}

// ── seeded random ──

/** 32-bit FNV-1a over the id, mixed with the seed and finished with murmur3's avalanche. */
export function seededHash(id: string, seed: number): number {
  let h = (0x811c9dc5 ^ (seed | 0)) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
