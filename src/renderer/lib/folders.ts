// Finding folders by typing, for the folder picker, go-to-folder and the folder fields in dialogs.
// Libraries have thousands of folders (6,554 in one real library), so pickers list the best
// matches, never the whole tree.
import { fuzzy, segments, type Segment } from './fuzzy';
import { library } from './stores/library.svelte';
import type { FolderNode, Scope } from '../../shared/types';

export interface FolderHit {
  id: string;
  name: string;
  /** "Parent › Child" */
  path: string;
  segs: Segment[];
  score: number;
}

export const pathText = (path: string[]) => path.join(' › ');

/**
 * Folders matching `query`, best first. A hit in the folder's own name beats one that only
 * matches its parents. An empty query gives the first `limit` folders in tree order.
 */
export function searchFolders(query: string, limit = 60): FolderHit[] {
  const q = query.trim();
  const out: FolderHit[] = [];
  if (!q) {
    for (const [id, f] of library.folders) {
      const path = pathText(f.path);
      out.push({ id, name: f.node.name, path, segs: [{ text: path, hit: false }], score: 0 });
      if (out.length >= limit) break;
    }
    return out;
  }
  for (const [id, f] of library.folders) {
    const path = pathText(f.path);
    const hit = rank(q, f.node.name, path);
    if (hit)
      out.push({
        id,
        name: f.node.name,
        path,
        segs: segments(path, hit.positions),
        score: hit.score,
      });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

/** Score `name` (shown at the end of `path`) against the query; positions are into `path`. */
export function rank(
  q: string,
  name: string,
  path: string,
): { score: number; positions: number[] } | null {
  const inName = fuzzy(q, name);
  const inPath = path === name ? inName : fuzzy(q, path);
  let best: { score: number; positions: number[] } | null = null;
  if (inName)
    best = {
      score: inName.score + 25,
      positions: inName.positions.map((p) => p + path.length - name.length),
    };
  if (inPath && (!best || inPath.score > best.score)) best = inPath;
  return best;
}

/** `id` and every folder under it. */
export function subtreeIds(id: string): string[] {
  const out: string[] = [];
  const walk = (n: FolderNode) => (out.push(n.id), n.children.forEach(walk));
  const node = library.folder(id)?.node;
  if (node) walk(node);
  return out.length ? out : [id];
}

/**
 * The folders a "move" takes items out of: the folder you're looking at and, when the view shows
 * subfolder contents, every folder under it (an item on screen may live only in a subfolder).
 * Never the target, so moving into one of those subfolders still works. Empty outside a folder.
 */
export function leaveFolders(scope: Scope, targetId: string): string[] {
  if (scope.kind !== 'folder' || scope.id === targetId) return [];
  const ids = scope.includeSubfolders ? subtreeIds(scope.id) : [scope.id];
  return ids.filter((id) => id !== targetId);
}

/** The folder or one above it has an Eagle password (Eagle hides its items while locked). */
export function isLocked(id: string): boolean {
  for (let f = library.folder(id); f; f = f.parentId ? library.folder(f.parentId) : undefined)
    if (f.node.hasPassword) return true;
  return false;
}
