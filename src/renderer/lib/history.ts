// Undo chains in the history list. An undo is an ordinary history entry whose `undoOf` names the
// entry it reversed; undoing that undo is a redo, and so on. Pure, for the inspector and lib/edit.
import type { HistoryEntry } from '../../shared/types';

/**
 * The action a chain started from and how many undos deep `e` is: 0 for an action, 1 for an undo
 * of it, 2 for a redo... Walks only through entries in `list`; if the chain leaves the loaded
 * page, `root` is the last entry reached.
 */
export function chainRoot(
  e: HistoryEntry,
  list: readonly HistoryEntry[],
): { root: HistoryEntry; depth: number } {
  const byId = new Map(list.map((x) => [x.groupId, x]));
  let root = e;
  let depth = 0;
  while (root.undoOf && depth < 50) {
    const next = byId.get(root.undoOf);
    if (!next) break;
    root = next;
    depth++;
  }
  return { root, depth };
}
