// Opening a library's index file: create it, upgrade an older schema in place, or start over when
// it belongs to another schema, another library path, or was left torn by a crash.
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LibraryRef } from '../../shared/types';
import { appPaths } from '../paths';
import { SqliteLibraryIndex, type IndexOpenOptions } from './libraryIndex';
import schemaSql from './schema.sql?raw';
import { registerFunctions, SEARCH_SQL } from './statements';

/**
 * The version is written in schema.sql's header comment: "schema_version ('4')". Bumping it there
 * rebuilds every index, and a rebuild is a first scan: whatever changed in a library while Boogie
 * was closed (a partner's edits, an old copy written over ours) is then taken in without a History
 * entry, that one time (and Master takes ~14 minutes over USB). So an older version with an entry
 * in MIGRATIONS is upgraded in place instead.
 */
export const SCHEMA_VERSION = /schema_version\s*\('(\d+)'\)/.exec(schemaSql)?.[1] ?? '1';

/** In-place upgrades from older schema versions (run after schema.sql made the new tables and indexes). */
const MIGRATIONS: Record<string, (db: Database.Database) => void> = {
  // v4: covering index for All and counts, item_search for short keywords.
  '3': (db) => {
    db.exec('DROP INDEX IF EXISTS items_imported');
    db.exec(
      `INSERT OR REPLACE INTO item_search (item_rowid, text) SELECT i.rowid, ${SEARCH_SQL} FROM items i`,
    );
    db.exec('ANALYZE');
  },
};

export function openIndex(ref: LibraryRef, opts: IndexOpenOptions = {}): SqliteLibraryIndex {
  const dir = opts.dir ?? join(appPaths().cache, 'index'); // the service passes its own cache dir
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ref.id}.sqlite`);

  // A database from another schema version, another library path, or a damaged file is just deleted.
  let db = tryOpen(file, ref);
  if (!db) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
    db = new Database(file);
    db.exec(schemaSql);
  }
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    SCHEMA_VERSION,
  );
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('library_path', ref.path);
  return new SqliteLibraryIndex(db, ref.id, opts);
}

/** null means "start over". */
function tryOpen(file: string, ref: LibraryRef): Database.Database | null {
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    let migrate: ((db: Database.Database) => void) | undefined;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meta'").get()) {
      const get = db.prepare('SELECT value FROM meta WHERE key = ?').pluck();
      const version = get.get('schema_version') as string | undefined;
      const path = get.get('library_path');
      if (version !== SCHEMA_VERSION) migrate = version ? MIGRATIONS[version] : undefined;
      if ((version !== SCHEMA_VERSION && !migrate) || (path !== undefined && path !== ref.path))
        throw new Error('stale index');
      // A big load ran with syncs off and never finished properly (crash or power cut during a
      // scan): the file may be torn. It's a cache, so start over.
      if (get.get('unsynced') !== undefined) throw new Error('unsynced index');
    }
    db.exec(schemaSql);
    if (migrate) {
      registerFunctions(db);
      db.transaction(() => migrate(db))();
    }
    return db;
  } catch {
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    return null;
  }
}
