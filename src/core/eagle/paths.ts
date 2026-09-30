// Where things live inside a `.library` folder. Pure path math, no I/O.
import { basename, dirname, join, relative, sep } from 'node:path';
import type { EagleItemRecord } from '../../shared/types';
import { assertItemId } from './ids';

export const IMAGES_DIR = 'images';
export const BACKUP_DIR = 'backup';
export const ROOT_METADATA = 'metadata.json';
export const MTIME_FILE = 'mtime.json';
export const TAGS_FILE = 'tags.json';
export const SAVED_FILTERS_FILE = 'saved-filters.json';

export function imagesDir(root: string): string {
  return join(root, IMAGES_DIR);
}

export function itemDir(root: string, id: string): string {
  assertItemId(id);
  return join(root, IMAGES_DIR, `${id}.info`);
}

export function metadataPath(root: string, id: string): string {
  return join(itemDir(root, id), 'metadata.json');
}

/** `images/<id>.info/metadata.json`, the form the journal and recentSelfWrites use. */
export function itemMetadataRel(id: string): string {
  assertItemId(id);
  return `${IMAGES_DIR}/${id}.info/metadata.json`;
}

/**
 * Where the journal keeps an item's thumbnail (as base64 text): a key, not a real file, so it
 * doesn't change when the item is renamed. Undo of a custom thumbnail puts those bytes back.
 */
export function thumbnailJournalRel(id: string): string {
  assertItemId(id);
  return `${IMAGES_DIR}/${id}.info/thumbnail`;
}

/** The item id in a thumbnailJournalRel key, or null. */
export function thumbnailJournalId(relPath: string): string | null {
  return /^images\/([^/]+)\.info\/thumbnail$/.exec(relPath)?.[1] ?? null;
}

/** Joins a file name onto a directory, refusing names that would leave it (`../x`, `a/b`). */
export function childPath(dir: string, fileName: string): string {
  if (
    !fileName ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName === '.' ||
    fileName === '..'
  ) {
    throw new Error(`Unsafe file name: ${JSON.stringify(fileName)}`);
  }
  return join(dir, fileName);
}

export function originalFileName(rec: Pick<EagleItemRecord, 'name' | 'ext'>): string {
  return `${rec.name}.${rec.ext}`;
}

export function thumbnailFileName(rec: Pick<EagleItemRecord, 'name'>): string {
  return `${rec.name}_thumbnail.png`;
}

/** Expected path of the original (`<name>.<ext>`), before any fallback search. */
export function originalPath(
  root: string,
  id: string,
  rec: Pick<EagleItemRecord, 'name' | 'ext'>,
): string {
  return childPath(itemDir(root, id), originalFileName(rec));
}

/** Expected path of the thumbnail (`<name>_thumbnail.png`), before any fallback search. */
export function thumbnailPath(
  root: string,
  id: string,
  rec: Pick<EagleItemRecord, 'name'>,
): string {
  return childPath(itemDir(root, id), thumbnailFileName(rec));
}

/** Path relative to the library root with forward slashes. */
export function relFromRoot(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** True if any directory segment of `p` is a `*.library` folder. */
export function isInsideLibraryFolder(p: string): boolean {
  let cur = dirname(p);
  for (;;) {
    if (basename(cur).toLowerCase().endsWith('.library')) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}
