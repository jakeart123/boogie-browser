// Pure: one Eagle item record -> the rows we keep in SQLite. No database access in here, so the
// query agent can use it to build fixtures and tests can call it directly.
import { converter } from 'culori';
import type { EagleItemRecord } from '../../shared/types';

const toLab65 = converter('lab65');

/** Lists in one FTS column are joined with this: a typed phrase never contains it, so it can't match across two entries. */
export const FTS_SEP = '\n';

export interface ItemRow {
  id: string;
  name: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  star: number;
  url: string;
  annotation: string;
  /** Region/timecode comment texts, one per line (keyword search covers them, like Eagle's). */
  comments: string;
  is_deleted: 0 | 1;
  deleted_time: number | null;
  imported_at: number;
  imported_at_str: string;
  last_modified: number;
  btime: number;
  mtime: number;
  duration: number | null;
  no_thumbnail: 0 | 1;
  no_preview: 0 | 1;
  tag_count: number;
  folder_count: number;
  animated: 0 | 1;
  record_json: string;
  /** stat mtimeMs of metadata.json when indexed. 0 here: only the caller that read the file knows it. */
  meta_file_mtime: number;
}

export interface PaletteRow {
  idx: number;
  r: number;
  g: number;
  b: number;
  l: number;
  a: number;
  bb: number;
  ratio: number;
}

export interface FtsRow {
  name: string;
  tags: string;
  annotation: string;
  url: string;
  folder_names: string;
  ext: string;
  comments: string;
  folder_descriptions: string;
}

export interface ProjectedRecord {
  item: ItemRow;
  tags: string[];
  folders: { folderId: string; ord: string | null }[];
  palette: PaletteRow[];
  fts: FtsRow;
  /** item_search.text: the FTS fields one per line, lowercased (short keyword terms scan it). */
  search: string;
}

/** The FTS fields in item_search order (the SQL rebuild in libraryIndex.ts uses the same order). */
export function searchText(f: FtsRow): string {
  return [
    f.name,
    f.tags,
    f.annotation,
    f.url,
    f.folder_names,
    f.ext,
    f.comments,
    f.folder_descriptions,
  ]
    .join(FTS_SEP)
    .toLowerCase();
}

export interface FolderText {
  name: string;
  description: string;
}

/**
 * The folders that exist in the current tree: a Map of id -> name and description (they go into the
 * item's FTS row), or just a Set of ids (folder text is then left out of the FTS row).
 */
export type FolderLookup = ReadonlyMap<string, FolderText> | ReadonlySet<string>;

/** Record text is untrusted: real libraries hold zero-filled files, string dates and junk keys. */
export function projectRecord(
  rec: EagleItemRecord,
  text: string,
  folders: FolderLookup,
): ProjectedRecord {
  const tags = uniqueStrings(rec.tags);
  const folderIds = uniqueStrings(rec.folders);
  const order = rec.order && typeof rec.order === 'object' ? rec.order : {};

  const folderRows = folderIds.map((folderId) => {
    const ord = order[folderId] as unknown;
    return {
      folderId,
      ord: typeof ord === 'string' ? ord : typeof ord === 'number' ? String(ord) : null,
    };
  });
  const known = folderIds.filter((id) => folders.has(id));
  const folderText = folders instanceof Map ? known.map((id) => folders.get(id)!) : [];
  const joined = (list: string[]) => list.filter(Boolean).join(FTS_SEP);

  const width = finiteOrNull(rec.width);
  const height = finiteOrNull(rec.height);
  const name = str(rec.name);
  const ext = str(rec.ext);
  const url = str(rec.url);
  const annotation = str(rec.annotation);
  const comments = Array.isArray(rec.comments)
    ? joined(rec.comments.map((c) => str(c?.annotation))) // untrusted: entries may be junk
    : '';

  const item: ItemRow = {
    id: rec.id,
    name,
    ext,
    size: finiteOr(rec.size, 0),
    width,
    height,
    star: finiteOr(rec.star, 0),
    url,
    annotation,
    comments,
    is_deleted: rec.isDeleted ? 1 : 0,
    deleted_time: finiteOrNull(rec.deletedTime),
    imported_at: Number(rec.modificationTime) || 0,
    imported_at_str: rec.modificationTime == null ? '0' : String(rec.modificationTime),
    last_modified: finiteOr(rec.lastModified, 0),
    btime: finiteOr(rec.btime, 0),
    mtime: finiteOr(rec.mtime, 0),
    duration: finiteOrNull(rec.duration),
    no_thumbnail: rec.noThumbnail ? 1 : 0,
    no_preview: rec.noPreview ? 1 : 0,
    tag_count: tags.length,
    folder_count: known.length,
    animated: rec.animated === true ? 1 : 0,
    record_json: text,
    meta_file_mtime: 0,
  };

  const fts: FtsRow = {
    name,
    tags: joined(tags),
    annotation,
    url,
    folder_names: joined(folderText.map((f) => f.name)),
    ext,
    comments,
    folder_descriptions: joined(folderText.map((f) => f.description)),
  };
  return {
    item,
    tags,
    folders: folderRows,
    palette: paletteRows(rec),
    fts,
    search: searchText(fts),
  };
}

function paletteRows(rec: EagleItemRecord): PaletteRow[] {
  const out: PaletteRow[] = [];
  if (!Array.isArray(rec.palettes)) return out;
  for (const p of rec.palettes) {
    const c = p?.color;
    if (!Array.isArray(c) || c.length < 3) continue;
    const [r, g, b] = [c[0], c[1], c[2]].map((v) =>
      Math.min(255, Math.max(0, Math.round(Number(v)))),
    );
    if (![r, g, b].every(Number.isFinite)) continue;
    const lab = toLab65({ mode: 'rgb', r: r / 255, g: g / 255, b: b / 255 });
    out.push({
      idx: out.length,
      r,
      g,
      b,
      l: round2(lab.l),
      a: round2(lab.a),
      bb: round2(lab.b),
      ratio: finiteOr(p.ratio, 0),
    });
  }
  return out;
}

/** The non-empty strings of a list from an untrusted file (anything else in it is ignored). */
export const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

function uniqueStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string'))];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const finiteOr = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;
const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const round2 = (n: number): number => Math.round(n * 100) / 100;
