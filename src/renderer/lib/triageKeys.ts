// Triage keys: number keys file into folders, letter keys tag. Each queue (the place you started
// from: Untagged, a folder, a smart folder...) has its own map, kept in this computer's local
// storage per library, never in the library. A queue without one starts from the map you used
// last in that library, and the very first one from the library's busiest folders and tags. That
// first map is saved at once, so a key never changes meaning unless you change it.
import { readJSON, writeJSON } from './storage';
import type { Scope } from '../../shared/types';

/** Number keys file (0 is "another folder"); letters tag. S, T, U, X and Z are triage's own. */
export const FILE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export const TAG_KEYS = ['A', 'D', 'F', 'G', 'H', 'J', 'K', 'L'] as const;

export interface KeyMap {
  /** Folder id per number key (FILE_KEYS order), or null. */
  folders: (string | null)[];
  /** Tag name per letter key (TAG_KEYS order), or null. */
  tags: (string | null)[];
}

/** Which queue this is, for its key map: the scope, without the filter or sort. */
export function queueKey(scope: Scope): string {
  switch (scope.kind) {
    case 'folder':
      return `folder:${scope.id}`;
    case 'smartFolder':
      return `smart:${scope.id}`;
    case 'tag':
      return `tag:${scope.name}`;
    default:
      return scope.kind;
  }
}

const slots = (v: unknown, n: number): (string | null)[] =>
  Array.from({ length: n }, (_, i) => {
    const x = Array.isArray(v) ? v[i] : null;
    return typeof x === 'string' && x ? x : null;
  });

/** A stored map, cleaned up (anything malformed reads as empty keys); null when there is none. */
export function parseKeyMap(v: unknown): KeyMap | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { folders?: unknown; tags?: unknown };
  if (!Array.isArray(o.folders) && !Array.isArray(o.tags)) return null;
  return { folders: slots(o.folders, FILE_KEYS.length), tags: slots(o.tags, TAG_KEYS.length) };
}

/**
 * First-run keys: the folders holding the most items of their own (where things get filed, not
 * the big parents) and the most used tags. The queue's own folder is left out: filing an item
 * where it already is does nothing.
 */
export function seedKeys(
  folderCounts: Record<string, { own: number }>,
  tags: { name: string; count: number }[],
  skipFolder: string | null,
): KeyMap {
  const folders = Object.entries(folderCounts)
    .filter(([id, c]) => id !== skipFolder && c.own > 0)
    .sort((a, b) => b[1].own - a[1].own)
    .map(([id]) => id);
  const names = [...tags].sort((a, b) => b.count - a.count).map((t) => t.name);
  return { folders: slots(folders, FILE_KEYS.length), tags: slots(names, TAG_KEYS.length) };
}

const storeKey = (libraryId: string, queue: string) => `triage.keys.${libraryId}.${queue}`;

/**
 * This queue's keys, else the last ones used in the library, else `seed()`. A map this queue
 * didn't have yet is saved for it now: seeded keys rank folders by size, and would move once
 * items land in them.
 */
export function loadKeys(libraryId: string, queue: string, seed: () => KeyMap): KeyMap {
  const own = parseKeyMap(readJSON<unknown>(storeKey(libraryId, queue), null));
  if (own) return own;
  const map = parseKeyMap(readJSON<unknown>(storeKey(libraryId, '_last'), null)) ?? seed();
  saveKeys(libraryId, queue, map);
  return map;
}

export function saveKeys(libraryId: string, queue: string, map: KeyMap): void {
  const plain = { folders: [...map.folders], tags: [...map.tags] };
  writeJSON(storeKey(libraryId, queue), plain);
  writeJSON(storeKey(libraryId, '_last'), plain);
}

/**
 * A tag was renamed (or merged into another, or deleted: `to` null) in this library: every saved
 * key for it follows, so pressing it never brings the old name back.
 */
export function renameTagInKeys(libraryId: string, from: string, to: string | null): void {
  const prefix = `boogie.${storeKey(libraryId, '')}`;
  const names: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) names.push(k);
    }
  } catch {
    return; // no storage: nothing saved to fix
  }
  for (const full of names) {
    const queue = full.slice(prefix.length);
    const map = parseKeyMap(readJSON<unknown>(storeKey(libraryId, queue), null));
    if (!map?.tags.includes(from)) continue;
    const tags = map.tags.map((t) => (t === from ? to : t));
    writeJSON(storeKey(libraryId, queue), { folders: map.folders, tags });
  }
}
