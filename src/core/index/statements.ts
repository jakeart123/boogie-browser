// The index's SQL: the item columns, the search text expression, and every prepared statement the
// index runs (the query engine prepares its own). Kept apart from the logic that uses them.
import type Database from 'better-sqlite3';
import { LOCKED_ROWIDS } from './folders';
import type { ItemRow } from './project';

/** The FTS/search fields of item `i`, rebuilt from the tables (projectRecord's order and joins). */
const FIELDS_SQL = [
  'i.name',
  "COALESCE((SELECT group_concat(tag, char(10)) FROM item_tags WHERE item_rowid = i.rowid), '')",
  'i.annotation',
  'i.url',
  "COALESCE((SELECT group_concat(fo.name, char(10)) FROM item_folders f JOIN folders fo ON fo.id = f.folder_id WHERE f.item_rowid = i.rowid AND fo.name <> ''), '')",
  'i.ext',
  'i.comments',
  "COALESCE((SELECT group_concat(fo.description, char(10)) FROM item_folders f JOIN folders fo ON fo.id = f.folder_id WHERE f.item_rowid = i.rowid AND fo.description <> ''), '')",
];
export const SEARCH_SQL = `boogie_lower(${FIELDS_SQL.join(' || char(10) || ')})`;

/** JS toLowerCase for SQL (SQLite's lower() folds ASCII only). */
export function registerFunctions(db: Database.Database): void {
  db.function('boogie_lower', { deterministic: true }, (s: unknown) =>
    typeof s === 'string' ? s.toLowerCase() : '',
  );
}

const ITEM_COLS = [
  'id',
  'name',
  'ext',
  'size',
  'width',
  'height',
  'star',
  'url',
  'annotation',
  'comments',
  'is_deleted',
  'deleted_time',
  'imported_at',
  'imported_at_str',
  'last_modified',
  'btime',
  'mtime',
  'duration',
  'no_thumbnail',
  'no_preview',
  'tag_count',
  'folder_count',
  'animated',
  'record_json',
  'meta_file_mtime',
] as const satisfies readonly (keyof ItemRow)[];

export function prepare(db: Database.Database) {
  const insertCols = ITEM_COLS.join(', ');
  return {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?').pluck(),
    setMeta: db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    delMeta: db.prepare('DELETE FROM meta WHERE key = ?'),

    byId: db.prepare('SELECT rowid, record_json, meta_file_mtime FROM items WHERE id = ?'),
    insertItem: db.prepare(
      `INSERT INTO items (${insertCols}) VALUES (${ITEM_COLS.map((c) => '@' + c).join(', ')})`,
    ),
    updateItem: db.prepare(
      `UPDATE items SET ${ITEM_COLS.map((c) => `${c} = @${c}`).join(', ')} WHERE rowid = @rowid`,
    ),
    touchItem: db.prepare('UPDATE items SET record_json = ?, meta_file_mtime = ? WHERE rowid = ?'),
    deleteItem: db.prepare('DELETE FROM items WHERE rowid = ?'),
    idsWithText: db.prepare(
      'SELECT id, rowid, record_json FROM items WHERE id IN (SELECT value FROM json_each(?))',
    ),
    knownLastModified: db.prepare('SELECT id, last_modified FROM items').raw(),
    itemCount: db.prepare('SELECT count(*) FROM items').pluck(),
    knownMetaMtime: db.prepare('SELECT id, meta_file_mtime FROM items ORDER BY rowid').raw(),
    record: db.prepare('SELECT record_json FROM items WHERE id = ?').pluck(),
    fileFacts: db.prepare('SELECT ext, width, height, size FROM items WHERE id = ?'),

    insertTag: db.prepare('INSERT INTO item_tags (item_rowid, tag) VALUES (?, ?)'),
    insertFolder: db.prepare(
      'INSERT INTO item_folders (item_rowid, folder_id, ord) VALUES (?, ?, ?)',
    ),
    insertPalette: db.prepare(
      'INSERT INTO palette (item_rowid, idx, r, g, b, l, a, bb, ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    insertFts: db.prepare(
      'INSERT INTO items_fts (rowid, name, tags, annotation, url, folder_names, ext, comments, folder_descriptions) VALUES (@rowid, @name, @tags, @annotation, @url, @folder_names, @ext, @comments, @folder_descriptions)',
    ),
    deleteTags: db.prepare('DELETE FROM item_tags WHERE item_rowid = ?'),
    deleteFolders: db.prepare('DELETE FROM item_folders WHERE item_rowid = ?'),
    deletePalette: db.prepare('DELETE FROM palette WHERE item_rowid = ?'),
    deleteFts: db.prepare('DELETE FROM items_fts WHERE rowid = ?'),

    clearFolders: db.prepare('DELETE FROM folders'),
    clearClosure: db.prepare('DELETE FROM folder_closure'),
    insertFolderRow: db.prepare(
      'INSERT INTO folders (id, parent_id, name, description, path, depth, position, auto_tags, order_by, sort_increase, locked) VALUES (@id, @parent_id, @name, @description, @path, @depth, @position, @auto_tags, @order_by, @sort_increase, @locked)',
    ),
    insertClosure: db.prepare(
      'INSERT INTO folder_closure (ancestor_id, descendant_id, distance) VALUES (@ancestor_id, @descendant_id, @distance)',
    ),
    folderText: db.prepare('SELECT id, name, description FROM folders').raw(),
    closurePairs: db.prepare('SELECT descendant_id, ancestor_id FROM folder_closure').raw(),
    // For items that reference folders whose name/existence changed: recount folders, redo the FTS row.
    recountFolders: db.prepare(
      `UPDATE items SET folder_count = (SELECT count(*) FROM item_folders f JOIN folders fo ON fo.id = f.folder_id WHERE f.item_rowid = items.rowid)
       WHERE rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id IN (SELECT value FROM json_each(?)))`,
    ),
    dropFtsFor: db.prepare(
      'DELETE FROM items_fts WHERE rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id IN (SELECT value FROM json_each(?)))',
    ),
    // A contentless FTS row can't be edited in place, so it is rebuilt whole from the tables
    // (lists joined with a newline, like projectRecord's FTS_SEP).
    rebuildFtsFor: db.prepare(
      `INSERT INTO items_fts (rowid, name, tags, annotation, url, folder_names, ext, comments, folder_descriptions)
       SELECT i.rowid, ${FIELDS_SQL.join(', ')}
       FROM items i WHERE i.rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id IN (SELECT value FROM json_each(?)))`,
    ),
    rebuildSearchFor: db.prepare(
      `INSERT OR REPLACE INTO item_search (item_rowid, text) SELECT i.rowid, ${SEARCH_SQL}
       FROM items i WHERE i.rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id IN (SELECT value FROM json_each(?)))`,
    ),
    upsertSearch: db.prepare('INSERT OR REPLACE INTO item_search (item_rowid, text) VALUES (?, ?)'),
    paletteOf: db
      .prepare('SELECT l, a, bb, ratio FROM palette WHERE item_rowid = ? ORDER BY idx')
      .raw(),
    affectedByFolders: db
      .prepare(
        'SELECT DISTINCT item_rowid FROM item_folders WHERE folder_id IN (SELECT value FROM json_each(?))',
      )
      .pluck(),

    totals: db.prepare(
      `SELECT coalesce(sum(is_deleted = 0), 0) AS "all",
              coalesce(sum(is_deleted = 0 AND folder_count = 0), 0) AS uncategorized,
              coalesce(sum(is_deleted = 0 AND tag_count = 0), 0) AS untagged,
              coalesce(sum(is_deleted = 1), 0) AS trash,
              coalesce(sum(CASE WHEN is_deleted = 0 THEN size END), 0) AS totalSize FROM items`,
    ),
    // Two cheap scans beat joining every folder row back to items: the pairs, then the (few) trashed rowids.
    // ORDER BY is free here (item_folders is stored in this order) and keeps each item's folders together.
    folderPairs: db
      .prepare('SELECT item_rowid, folder_id FROM item_folders ORDER BY item_rowid')
      .raw(),
    trashedRowids: db.prepare('SELECT rowid FROM items WHERE is_deleted = 1').pluck(),
    anyLocked: db.prepare('SELECT 1 FROM folders WHERE locked = 1 LIMIT 1').pluck(),
    // Live items Eagle hides while a folder is locked, and what they add to the totals.
    lockedTotals: db.prepare(
      `SELECT count(*) AS n, coalesce(sum(tag_count = 0), 0) AS untagged, coalesce(sum(size), 0) AS size
       FROM items WHERE is_deleted = 0 AND rowid IN (${LOCKED_ROWIDS})`,
    ),
    lockedTagCounts: db
      .prepare(
        `SELECT t.tag, count(*) AS n FROM items i CROSS JOIN item_tags t ON t.item_rowid = i.rowid
         WHERE i.is_deleted = 0 AND i.rowid IN (${LOCKED_ROWIDS}) GROUP BY t.tag`,
      )
      .raw(),
    tagCounts: db.prepare('SELECT tag, count(*) AS n FROM item_tags GROUP BY tag').raw(),
    trashedTagCounts: db
      .prepare(
        'SELECT t.tag, count(*) AS n FROM items i CROSS JOIN item_tags t ON t.item_rowid = i.rowid WHERE i.is_deleted = 1 GROUP BY t.tag',
      )
      .raw(),

    hashes: db.prepare(
      'SELECT item_id AS id, size, md5, dhash, file_mtime AS fileMtime, computed_at AS computedAt FROM hashes',
    ),
    hashesFor: db.prepare(
      'SELECT item_id AS id, size, md5, dhash, file_mtime AS fileMtime, computed_at AS computedAt FROM hashes WHERE item_id IN (SELECT value FROM json_each(?))',
    ),
    // Same size + mtime: the new hash adds to what we know. Different: the old hashes describe another file, drop them.
    setHash: db.prepare(
      `INSERT INTO hashes (item_id, size, file_mtime, md5, dhash, computed_at) VALUES (@id, @size, @fileMtime, @md5, @dhash, @now)
       ON CONFLICT(item_id) DO UPDATE SET
         md5 = CASE WHEN size = excluded.size AND file_mtime = excluded.file_mtime THEN coalesce(excluded.md5, md5) ELSE excluded.md5 END,
         dhash = CASE WHEN size = excluded.size AND file_mtime = excluded.file_mtime THEN coalesce(excluded.dhash, dhash) ELSE excluded.dhash END,
         size = excluded.size, file_mtime = excluded.file_mtime, computed_at = excluded.computed_at`,
    ),
    deleteHashes: db.prepare(
      'DELETE FROM hashes WHERE item_id IN (SELECT value FROM json_each(?))',
    ),
  };
}

export type Statements = ReturnType<typeof prepare>;
