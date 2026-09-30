-- Boogie Browser per-library index. One SQLite file per library at
-- ~/.cache/boogie-browser/index/<libraryId>.sqlite. Disposable: rebuilt from the library's
-- JSON files at any time. Owned by the orchestrator; index agent implements load/migrate,
-- query agent reads it. Bump schema_version in `meta` when this changes: the index is rebuilt,
-- unless libraryIndex.ts has a migration from the old version (3 -> 4 has one).

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
-- keys: schema_version ('4'), library_path, root_modification_time, root_text (last root JSON),
--       last_full_scan (ms), mtime_json_text_hash, unreadable, images_dir_stamp (skip listing
--       images/ when unchanged), verify_stamp (service/storage: when the stat pass last ran)

CREATE TABLE IF NOT EXISTS items (
  rowid            INTEGER PRIMARY KEY,         -- stable per id within this db (the FTS key)
  id               TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  ext              TEXT NOT NULL,
  size             INTEGER NOT NULL DEFAULT 0,
  width            INTEGER,                     -- NULL when unknown
  height           INTEGER,
  star             INTEGER NOT NULL DEFAULT 0,  -- 0 = unrated
  url              TEXT NOT NULL DEFAULT '',
  annotation       TEXT NOT NULL DEFAULT '',
  comments         TEXT NOT NULL DEFAULT '',     -- region/timecode comment texts, one per line
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_time     INTEGER,
  imported_at      REAL NOT NULL,               -- Number(modificationTime)
  imported_at_str  TEXT NOT NULL,               -- String(modificationTime): MANUAL-order fallback key
  last_modified    INTEGER NOT NULL DEFAULT 0,
  btime            INTEGER NOT NULL DEFAULT 0,
  mtime            INTEGER NOT NULL DEFAULT 0,
  duration         REAL,
  no_thumbnail     INTEGER NOT NULL DEFAULT 0,
  no_preview       INTEGER NOT NULL DEFAULT 0,
  tag_count        INTEGER NOT NULL DEFAULT 0,
  folder_count     INTEGER NOT NULL DEFAULT 0,  -- counts only folder ids that exist in the tree
  animated         INTEGER NOT NULL DEFAULT 0,  -- the record says `animated: true` (Eagle writes it for animated webp/avif)
  record_json      TEXT NOT NULL,               -- exact metadata.json text last indexed
  meta_file_mtime  INTEGER NOT NULL DEFAULT 0   -- stat mtimeMs of metadata.json when indexed
);
-- Covering index for the All view in its default order (newest first, ties by id) and for the
-- totals in counts(): both read this narrow index instead of the wide rows (v4 replaced
-- items_imported(is_deleted, imported_at)).
CREATE INDEX IF NOT EXISTS items_all
  ON items(is_deleted, imported_at DESC, id, width, height, size, tag_count, folder_count);
CREATE INDEX IF NOT EXISTS items_name ON items(is_deleted, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS items_star ON items(is_deleted, star);
CREATE INDEX IF NOT EXISTS items_ext ON items(is_deleted, ext);
CREATE INDEX IF NOT EXISTS items_size ON items(size);

CREATE TABLE IF NOT EXISTS item_tags (
  item_rowid INTEGER NOT NULL REFERENCES items(rowid) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (item_rowid, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag, item_rowid);

CREATE TABLE IF NOT EXISTS item_folders (
  item_rowid INTEGER NOT NULL REFERENCES items(rowid) ON DELETE CASCADE,
  folder_id  TEXT NOT NULL,
  ord        TEXT,                               -- item.order[folder_id] if present (compare as TEXT)
  PRIMARY KEY (item_rowid, folder_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS item_folders_folder ON item_folders(folder_id, item_rowid);

-- Folder tree flattened from root metadata.json (rebuilt on every root change).
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL,                     -- "Parent / Child" for display and fuzzy search
  depth       INTEGER NOT NULL,
  position    INTEGER NOT NULL,                  -- index among siblings
  auto_tags   TEXT NOT NULL DEFAULT '[]',        -- own tags JSON
  order_by    TEXT,
  sort_increase INTEGER,
  locked      INTEGER NOT NULL DEFAULT 0         -- has a password: Eagle hides its items (and its subfolders') while locked
) WITHOUT ROWID;
-- Ancestor closure (includes self at distance 0) for "show subfolder contents".
CREATE TABLE IF NOT EXISTS folder_closure (
  ancestor_id   TEXT NOT NULL,
  descendant_id TEXT NOT NULL,
  distance      INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
) WITHOUT ROWID;

-- Full-text search over what Eagle's keyword search covers (name, tags, note, URL, comments,
-- folder names and descriptions, extension). contentless-delete so we can update by rowid.
-- trigram gives substring matching (also CJK); queries under 3 chars fall back to instr() on
-- the tables. Lists (tags, folder names, ...) are joined with newlines, which a typed phrase
-- never contains, so a quoted phrase can't match across two tags.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name, tags, annotation, url, folder_names, ext, comments, folder_descriptions,
  content = '', contentless_delete = 1, tokenize = 'trigram'
);

-- The same text as the FTS row, one field per line, lowercased (JS toLowerCase, so every script
-- folds, not just ASCII). Keyword terms under 3 characters, which the trigram index can't serve,
-- scan this narrow table with instr() instead of the item rows.
CREATE TABLE IF NOT EXISTS item_search (
  item_rowid INTEGER PRIMARY KEY REFERENCES items(rowid) ON DELETE CASCADE,
  text       TEXT NOT NULL
);

-- Palette colors in CIELAB for color search (query/color.ts scans this table). One row per palette entry.
CREATE TABLE IF NOT EXISTS palette (
  item_rowid INTEGER NOT NULL REFERENCES items(rowid) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  r INTEGER NOT NULL, g INTEGER NOT NULL, b INTEGER NOT NULL,
  l REAL NOT NULL, a REAL NOT NULL, bb REAL NOT NULL,
  ratio REAL NOT NULL,
  PRIMARY KEY (item_rowid, idx)
) WITHOUT ROWID;

-- Content hashes for the duplicate finder. Valid while size + file_mtime match the original.
CREATE TABLE IF NOT EXISTS hashes (
  item_id    TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL,
  md5        TEXT,
  dhash      TEXT,                               -- 16 hex chars (64-bit)
  computed_at INTEGER NOT NULL
) WITHOUT ROWID;
