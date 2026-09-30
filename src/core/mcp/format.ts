// How items, folders and history look to an agent. Snake_case, plain values, ISO dates.
import { basename, dirname } from 'node:path';
import type { HistoryEntry, Item, JobProgress } from '../../shared/types';
import type { FolderIndex } from './folders';
import { iso } from './kit';

const NOTE_PREVIEW_CHARS = 300;

export const hex = (rgb: readonly number[]): string =>
  '#' +
  rgb
    .map((n) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

export function itemOut(item: Item, folders: FolderIndex, noteChars = NOTE_PREVIEW_CHARS) {
  const note =
    item.annotation.length > noteChars
      ? item.annotation.slice(0, noteChars) + '...'
      : item.annotation;
  return {
    id: item.id,
    name: item.name,
    ext: item.ext,
    size: item.size,
    width: item.width,
    height: item.height,
    tags: item.tags,
    folders: item.folders.map((id) => ({ id, name: folders.get(id)?.name ?? id })),
    rating: item.star,
    url: item.url,
    note,
    ...(item.isDeleted ? { in_trash: true } : {}),
    imported_at: iso(item.importedAt),
  };
}

/** get_item: everything, including the note in full and where the original lives on disk. */
export function fullItemOut(item: Item, folders: FolderIndex) {
  return {
    ...itemOut(item, folders, Infinity),
    in_trash: item.isDeleted,
    deleted_at: iso(item.deletedTime),
    modified_at: iso(item.modifiedAt),
    file_created_at: iso(item.btime),
    file_modified_at: iso(item.mtime),
    duration_seconds: item.duration,
    colors: item.palettes.map((p) => ({
      hex: hex(p.color),
      percent: Math.round(p.ratio * 10) / 10,
    })),
    has_thumbnail: !item.noThumbnail,
    comments: item.comments.map((c) => ({ id: c.id, text: c.annotation, at: iso(c.lastModified) })),
    // Built from the record's name and ext, which a library can craft to point anywhere: only a
    // path inside the item's own folder is shown.
    file_path: basename(dirname(item.filePath)) === `${item.id}.info` ? item.filePath : null,
  };
}

export const historyOut = (h: HistoryEntry) => ({
  group_id: h.groupId,
  actor: h.actor.name,
  actor_kind: h.actor.kind,
  label: h.label,
  at: iso(h.at),
  kind: h.kind,
  item_count: h.itemCount,
  undoable: h.undoable,
  undone_by: h.undoneBy,
});

export const jobOut = (j: JobProgress) => ({
  job_id: j.jobId,
  kind: j.kind,
  label: j.label,
  state: j.state,
  done: j.done,
  total: j.total,
  error: j.error,
});
