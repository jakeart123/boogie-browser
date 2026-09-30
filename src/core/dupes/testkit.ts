// Small fakes for the dupes tests: a real SQLite index (from schema.sql), a library folder of real
// files, and a media service that counts calls. Not used outside tests.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EagleItemRecord, LibraryRef } from '../../shared/types';
import type { DupeSource, EagleLibrary, LibraryIndex, MediaService } from '../contracts';

const SCHEMA = readFileSync(resolve('src/core/index/schema.sql'), 'utf8');

export interface FakeSource extends DupeSource {
  db: Database.Database;
  /** Put a file in the library and index its record. Returns the record. */
  add(spec: ItemSpec): EagleItemRecord;
  /** Remove nothing: mark an item trashed in the index. */
  trash(id: string): void;
}

export interface ItemSpec {
  id: string;
  name: string;
  ext?: string;
  bytes?: Buffer;
  from?: string; // copy this file in instead of writing bytes
  thumbFrom?: string; // give the item an Eagle-style thumbnail
  tags?: string[];
  folders?: string[];
  order?: Record<string, string>;
  annotation?: string;
  url?: string;
  star?: number;
  width?: number;
  height?: number;
  added?: number; // modificationTime
  noPreview?: boolean;
}

/** `root` may be a fake path (to test disk classification); files really live in `dir`. */
export function makeSource(dir: string, name: string, root?: string): FakeSource {
  const libDir = join(dir, `${name}.library`);
  mkdirSync(join(libDir, 'images'), { recursive: true });
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const ref: LibraryRef = {
    id: createHash('sha256').update(libDir).digest('hex').slice(0, 16),
    path: libDir,
    name,
  };
  const itemDir = (id: string) => join(libDir, 'images', `${id}.info`);

  const index = {
    db,
    libraryId: ref.id,
    getRecord: (id: string) => {
      const row = db.prepare('SELECT record_json FROM items WHERE id = ?').get(id) as
        { record_json: string } | undefined;
      return row ? (JSON.parse(row.record_json) as EagleItemRecord) : null;
    },
    getHashes: (ids?: string[]) => {
      const rows = db
        .prepare('SELECT item_id AS id, size, file_mtime AS fileMtime, md5, dhash FROM hashes')
        .all() as ReturnType<LibraryIndex['getHashes']>;
      return ids ? rows.filter((r) => ids.includes(r.id)) : rows;
    },
    // Replace semantics: the strictest reading of the contract.
    setHash: (id: string, h: { size: number; fileMtime: number; md5?: string; dhash?: string }) => {
      db.prepare(
        'INSERT OR REPLACE INTO hashes (item_id, size, file_mtime, md5, dhash, computed_at) VALUES (?,?,?,?,?,?)',
      ).run(id, h.size, h.fileMtime, h.md5 ?? null, h.dhash ?? null, Date.now());
    },
  } as unknown as LibraryIndex;

  const lib = {
    root: root ?? libDir,
    readOnly: true,
    itemDir,
    locateOriginal: async (id: string, rec: EagleItemRecord) => {
      const p = join(itemDir(id), `${rec.name}.${rec.ext}`);
      return existsSync(p) ? p : null;
    },
    locateThumbnail: async (id: string, rec: EagleItemRecord) => {
      const p = join(itemDir(id), `${rec.name}_thumbnail.png`);
      return existsSync(p) ? p : null;
    },
  } as unknown as EagleLibrary;

  const src: FakeSource = {
    ref,
    lib,
    index,
    db,
    urls: {
      thumb: (id, v) => `boogie://thumb/${ref.id}/${id}?v=${v}`,
      file: (id, v) => `boogie://file/${ref.id}/${id}?v=${v}`,
      preview: (id, ext, v) => `boogie://preview/${ref.id}/${id}.${ext}?v=${v}`,
    },
    add(spec) {
      const ext = spec.ext ?? 'png';
      mkdirSync(itemDir(spec.id), { recursive: true });
      const file = join(itemDir(spec.id), `${spec.name}.${ext}`);
      if (spec.from) copyFileSync(spec.from, file);
      else writeFileSync(file, spec.bytes ?? Buffer.from(spec.id));
      if (spec.thumbFrom)
        copyFileSync(spec.thumbFrom, join(itemDir(spec.id), `${spec.name}_thumbnail.png`));
      const size = readFileSync(file).length;
      const added = spec.added ?? 1_700_000_000_000;
      const rec: EagleItemRecord = {
        id: spec.id,
        name: spec.name,
        size,
        btime: 1_700_000_000_000,
        mtime: 1_700_000_000_000,
        ext,
        tags: spec.tags ?? [],
        folders: spec.folders ?? [],
        isDeleted: false,
        url: spec.url ?? '',
        annotation: spec.annotation ?? '',
        modificationTime: added,
        ...(spec.star ? { star: spec.star } : {}),
        ...(spec.width ? { width: spec.width, height: spec.height } : {}),
        ...(spec.order ? { order: spec.order } : {}),
        lastModified: added,
      };
      const info = db
        .prepare(
          `INSERT INTO items (id, name, ext, size, width, height, star, url, annotation, is_deleted, imported_at, imported_at_str,
             last_modified, btime, mtime, tag_count, folder_count, no_preview, record_json)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          spec.id,
          spec.name,
          ext,
          size,
          rec.width ?? null,
          rec.height ?? null,
          spec.star ?? 0,
          rec.url,
          rec.annotation,
          added,
          String(added),
          added,
          rec.btime,
          rec.mtime,
          rec.tags.length,
          rec.folders.length,
          spec.noPreview ? 1 : 0,
          JSON.stringify(rec),
        );
      const rowid = Number(info.lastInsertRowid);
      for (const t of rec.tags)
        db.prepare('INSERT INTO item_tags (item_rowid, tag) VALUES (?,?)').run(rowid, t);
      for (const f of rec.folders)
        db.prepare('INSERT INTO item_folders (item_rowid, folder_id, ord) VALUES (?,?,?)').run(
          rowid,
          f,
          rec.order?.[f] ?? null,
        );
      return rec;
    },
    trash(id) {
      db.prepare('UPDATE items SET is_deleted = 1 WHERE id = ?').run(id);
    },
  };
  return src;
}

export interface FakeMedia extends MediaService {
  md5Calls: string[];
  dhashCalls: string[];
  /** Highest number of md5 reads in flight at once, per fake-path prefix. */
  maxInFlight: number;
}

/** md5 is real (streams nothing fancy); dhash is the 9x8 difference hash via ImageMagick. */
export function fakeMedia(opts: { md5DelayMs?: number } = {}): FakeMedia {
  let inFlight = 0;
  const m = {
    md5Calls: [] as string[],
    dhashCalls: [] as string[],
    maxInFlight: 0,
    async md5(path: string) {
      m.md5Calls.push(path);
      inFlight++;
      m.maxInFlight = Math.max(m.maxInFlight, inFlight);
      try {
        if (opts.md5DelayMs) await new Promise((r) => setTimeout(r, opts.md5DelayMs));
        return createHash('md5').update(readFileSync(path)).digest('hex');
      } finally {
        inFlight--;
      }
    },
    async dhash(path: string) {
      m.dhashCalls.push(path);
      return dhashOf(path);
    },
    async probe() {
      throw new Error('unused');
    },
    isBrowserViewable: () => true,
    close: async () => {},
  };
  return m as unknown as FakeMedia;
}

export function dhashOf(path: string): string {
  const px = execFileSync(
    'magick',
    [`${path}[0]`, '-colorspace', 'Gray', '-resize', '9x8!', '-depth', '8', 'gray:-'],
    {
      maxBuffer: 1 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
