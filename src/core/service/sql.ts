// The few direct reads the service does on the index (schema: src/core/index/schema.sql).
// Reads only. These include trashed items, which the query engine's scopes leave out.
import type { LibraryIndex } from '../contracts';
import { chunks } from './util';

const CHUNK = 500; // well under SQLite's variable limit

function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** Which of these ids are in the index at all. */
export function existingIds(index: LibraryIndex, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const part of chunks(ids, CHUNK)) {
    const rows = index.db
      .prepare(`SELECT id FROM items WHERE id IN (${marks(part.length)})`)
      .all(...part) as { id: string }[];
    for (const r of rows) found.add(r.id);
  }
  return found;
}

/** The ids (of `ids`) that are in the trash. */
export function trashedAmong(index: LibraryIndex, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const part of chunks(ids, CHUNK)) {
    const rows = index.db
      .prepare(`SELECT id FROM items WHERE is_deleted = 1 AND id IN (${marks(part.length)})`)
      .all(...part) as { id: string }[];
    for (const r of rows) found.add(r.id);
  }
  return found;
}

export function allItemIds(index: LibraryIndex): string[] {
  return (index.db.prepare('SELECT id FROM items').all() as { id: string }[]).map((r) => r.id);
}

export function allTrashedIds(index: LibraryIndex): string[] {
  return (
    index.db.prepare('SELECT id FROM items WHERE is_deleted = 1').all() as { id: string }[]
  ).map((r) => r.id);
}

/** Items (trashed or not) that sit in any of these folders. */
export function itemIdsInFolders(index: LibraryIndex, folderIds: readonly string[]): string[] {
  const found = new Set<string>();
  for (const part of chunks(folderIds, CHUNK)) {
    const rows = index.db
      .prepare(
        `SELECT DISTINCT i.id FROM item_folders f JOIN items i ON i.rowid = f.item_rowid WHERE f.folder_id IN (${marks(part.length)})`,
      )
      .all(...part) as { id: string }[];
    for (const r of rows) found.add(r.id);
  }
  return [...found];
}

/** Items (trashed or not) carrying this exact tag. */
export function itemIdsWithTag(index: LibraryIndex, tag: string): string[] {
  const rows = index.db
    .prepare('SELECT i.id FROM item_tags t JOIN items i ON i.rowid = t.item_rowid WHERE t.tag = ?')
    .all(tag) as { id: string }[];
  return rows.map((r) => r.id);
}
