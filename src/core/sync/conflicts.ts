// Dropbox "conflicted copy" detection. Eagle ignores these files (and Boogie must never index them
// as items), but they mean two people changed the same file before Dropbox synced, so the user should
// hear about them. See research/format-spec.md §13.6 and research/live-behavior.md §2.7.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConflictFile } from '../../shared/types';
import { conflictedCopyBase } from '../eagle';

/** If `name` is a Dropbox conflicted copy, the file name it was a copy of; otherwise null. */
export const conflictBaseName = conflictedCopyBase; // one pattern for the whole app, in eagle/read.ts

function rootKind(base: string): ConflictFile['kind'] {
  if (base === 'metadata.json') return 'root';
  if (base === 'mtime.json') return 'mtime';
  if (base === 'tags.json') return 'tags';
  return 'other';
}

function itemKind(base: string): ConflictFile['kind'] {
  if (base === 'metadata.json') return 'item';
  if (base.endsWith('_thumbnail.png')) return 'thumbnail';
  return 'other';
}

function sortByPath(list: ConflictFile[]): ConflictFile[] {
  return list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return []; // missing folder, unmounted drive, or a folder Dropbox is mid-way through replacing
  }
}

/**
 * Root-level conflicted copies. Unlike findConflictFiles this THROWS when the root can't be read,
 * so the watcher can tell "no conflicts" from "drive briefly gone" and not clear the list.
 */
export async function rootConflicts(root: string): Promise<ConflictFile[]> {
  const detectedAt = Date.now();
  const out: ConflictFile[] = [];
  for (const name of await readdir(root)) {
    const base = conflictBaseName(name);
    if (base !== null) out.push({ path: name, kind: rootKind(base), itemId: null, detectedAt });
  }
  return sortByPath(out);
}

/**
 * Conflicted copies of the library's own files at the library root (one readdir, cheap enough to
 * run every few seconds). Item folders are NOT scanned here: see scanItemConflicts. Pass
 * `{ items: true }` to also scan every item folder, which is one readdir per item and slow on an HDD.
 */
export async function findConflictFiles(
  root: string,
  opts: { items?: boolean } = {},
): Promise<ConflictFile[]> {
  const out = await rootConflicts(root).catch(() => [] as ConflictFile[]);
  if (opts.items) {
    const ids = (await listNames(join(root, 'images')))
      .filter((n) => n.endsWith('.info'))
      .map((n) => n.slice(0, -5));
    out.push(...(await scanItemConflicts(root, ids)));
  }
  return sortByPath(out);
}

/**
 * Conflicted copies inside the given items' folders. Meant to be called lazily by the service
 * (a few ids after a change, or all ids during a full scan). Reads at most `concurrency`
 * folders at once so a spinning disk isn't asked for thousands of seeks in parallel.
 */
export async function scanItemConflicts(
  root: string,
  ids: string[],
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<ConflictFile[]> {
  const detectedAt = Date.now();
  const out: ConflictFile[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !opts.signal?.aborted) {
      const id = ids[next++]!;
      if (!id || /[\\/]/.test(id)) continue; // ids come from the caller; never let one point outside images/
      const rel = `images/${id}.info`;
      for (const name of await listNames(join(root, 'images', `${id}.info`))) {
        const base = conflictBaseName(name);
        if (base !== null)
          out.push({ path: `${rel}/${name}`, kind: itemKind(base), itemId: id, detectedAt });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 8, ids.length)) }, worker),
  );
  return sortByPath(out);
}
