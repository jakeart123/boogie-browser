// Test-only: the real index (SqliteLibraryIndex) on an in-memory database with schema.sql, filled
// through its own upsertRecords, so fixtures have exactly the rows the real index would write.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EagleFolderRecord,
  EagleItemRecord,
  EagleRootRecord,
  EagleSmartFolderRecord,
} from '../../../shared/types';
import type { LibraryIndex, QueryEngine, UrlBuilder } from '../../contracts';
import { SqliteLibraryIndex } from '../libraryIndex';
import { SqlQueryEngine } from './engine';

const schema = readFileSync(join(import.meta.dirname, '../schema.sql'), 'utf8');

export const urls: UrlBuilder = {
  thumb: (id, v) => `thumb://${id}?v=${v}`,
  file: (id, v) => `file://${id}?v=${v}`,
  preview: (id, ext, v) => `preview://${id}.${ext}?v=${v}`,
};

export const folder = (
  id: string,
  name: string,
  children: EagleFolderRecord[] = [],
  extra: Partial<EagleFolderRecord> = {},
): EagleFolderRecord => ({
  id,
  name,
  description: '',
  children,
  modificationTime: 1,
  tags: [],
  password: '',
  passwordTips: '',
  ...extra,
});

export const makeRoot = (
  folders: EagleFolderRecord[] = [],
  smartFolders: EagleSmartFolderRecord[] = [],
  extra: Partial<EagleRootRecord> = {},
): EagleRootRecord => ({
  folders,
  smartFolders,
  quickAccess: [],
  tagsGroups: [],
  modificationTime: 1,
  applicationVersion: '4.0.0',
  ...extra,
});

export class Fixture {
  readonly ix: SqliteLibraryIndex;
  private seq = 0;

  constructor(root: EagleRootRecord = makeRoot()) {
    const db = new Database(':memory:');
    db.exec(schema);
    this.ix = new SqliteLibraryIndex(db, 'test');
    this.setRoot(root);
  }

  get db(): Database.Database {
    return this.ix.db;
  }

  get root(): EagleRootRecord {
    return this.ix.getRoot()!;
  }

  /** Call before adding items (folder names go into each item's FTS row). */
  setRoot(root: EagleRootRecord): void {
    this.ix.setRoot(root);
  }

  /** Fill in a plausible record around `partial` and index it. Returns the full record. */
  add(partial: Partial<EagleItemRecord> & { name: string }): EagleItemRecord {
    this.seq++;
    const t = 1_700_000_000_000 + this.seq * 1000;
    const rec: EagleItemRecord = {
      id: partial.id ?? `ITEM${String(this.seq).padStart(9, '0')}`,
      size: 1000,
      btime: 0,
      mtime: 0,
      ext: 'png',
      tags: [],
      folders: [],
      isDeleted: false,
      url: '',
      annotation: '',
      modificationTime: t,
      lastModified: t,
      ...partial,
    } as EagleItemRecord;
    this.ix.upsertRecords([rec]);
    return rec;
  }

  index(): LibraryIndex {
    return this.ix;
  }

  engine(): QueryEngine {
    return new SqlQueryEngine(this.index(), urls, (id) => `/lib/images/${id}.info/file`);
  }
}
