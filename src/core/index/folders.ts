// Flattens the root metadata.json folder tree into the rows of `folders` and `folder_closure`.
import type { EagleFolderRecord } from '../../shared/types';

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  description: string;
  path: string; // "Parent / Child"
  depth: number;
  position: number; // index among siblings
  auto_tags: string; // own auto-tags, JSON
  order_by: string | null;
  sort_increase: 0 | 1 | null;
  /** Has a password. Boogie never unlocks, so this means "locked". */
  locked: 0 | 1;
}

/**
 * Items in a password-locked folder or anywhere below one. Eagle leaves them out of All, the
 * counts, tags and every view (not the trash, not the folder badges) while the folder is locked,
 * and one locked folder is enough even when the item is also in an unlocked one (app.bundle.js
 * `lockedImages`). Boogie never unlocks.
 */
export const LOCKED_ROWIDS = `SELECT item_rowid FROM item_folders WHERE folder_id IN
  (SELECT c.descendant_id FROM folder_closure c JOIN folders lf ON lf.id = c.ancestor_id WHERE lf.locked = 1)`;

export interface ClosureRow {
  ancestor_id: string;
  descendant_id: string;
  distance: number;
}

/** Duplicate sibling names are normal, so everything is keyed by id. A repeated id (corrupt tree) is skipped. */
export function flattenFolders(tree: unknown): { folders: FolderRow[]; closure: ClosureRow[] } {
  const folders: FolderRow[] = [];
  const closure: ClosureRow[] = [];
  const seen = new Set<string>();

  const walk = (
    nodes: unknown,
    parentId: string | null,
    parentPath: string,
    ancestors: string[],
  ): void => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node: EagleFolderRecord, position) => {
      if (!node || typeof node.id !== 'string' || seen.has(node.id)) return;
      seen.add(node.id);
      const name = typeof node.name === 'string' ? node.name : '';
      const path = parentPath ? `${parentPath} / ${name}` : name;
      folders.push({
        id: node.id,
        parent_id: parentId,
        name,
        description: typeof node.description === 'string' ? node.description : '',
        path,
        depth: ancestors.length,
        position,
        auto_tags: JSON.stringify(
          Array.isArray(node.tags) ? node.tags.filter((t) => typeof t === 'string') : [],
        ),
        order_by: typeof node.orderBy === 'string' ? node.orderBy : null,
        sort_increase: typeof node.sortIncrease === 'boolean' ? (node.sortIncrease ? 1 : 0) : null,
        locked: typeof node.password === 'string' && node.password !== '' ? 1 : 0,
      });
      const chain = [...ancestors, node.id];
      chain.forEach((ancestor, i) =>
        closure.push({
          ancestor_id: ancestor,
          descendant_id: node.id,
          distance: chain.length - 1 - i,
        }),
      );
      walk(node.children, node.id, path, chain);
    });
  };

  walk(tree, null, '', []);
  return { folders, closure };
}
