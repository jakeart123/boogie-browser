// Inverse of a change to the library's root metadata.json, computed by folder id (never by
// position alone) so it never clobbers what someone else did to the tree since.
//
// Folders, smart folders and tag groups are all "a list of records with an id", folders and
// smart folders nested through `children`, so one tree routine handles the three. quickAccess
// is restored as a whole array, and only if nobody touched it since.
import { isDeepStrictEqual } from 'node:util';
import {
  asArray,
  CHANGED_SINCE,
  same,
  setOrDelete,
  unionKeys,
  type Conflict,
  type Rec,
} from './util';

interface TreeNode extends Rec {
  id: string;
  children?: TreeNode[];
}

interface Flat {
  node: TreeNode;
  parent: string | null;
}

/** Keys that are bookkeeping, not a change someone would want to undo. */
const OWN_SKIP = new Set(['id', 'children', 'modificationTime']);

/**
 * Mutate `root` (the current, fresh root) so it undoes the change `before` -> `after`.
 * Returns true if it changed anything. Conflicts are appended to `conflicts`.
 */
export function undoRoot(root: Rec, before: Rec, after: Rec, conflicts: Conflict[]): boolean {
  const snapshot = structuredClone(root);

  for (const key of ['folders', 'smartFolders', 'tagsGroups']) {
    if (same(before[key], after[key])) continue;
    if (!Array.isArray(root[key])) root[key] = [];
    undoTree(
      root[key] as TreeNode[],
      asArray(before[key]) as TreeNode[],
      asArray(after[key]) as TreeNode[],
      conflicts,
    );
  }

  if (!same(before.quickAccess, after.quickAccess)) {
    if (same(root.quickAccess, after.quickAccess))
      setOrDelete(root, 'quickAccess', before.quickAccess);
    else conflicts.push({ id: 'quickAccess', field: 'quickAccess', reason: CHANGED_SINCE });
  }

  return !isDeepStrictEqual(snapshot, root);
}

function flatten(
  list: TreeNode[] | undefined,
  parent: string | null,
  out = new Map<string, Flat>(),
): Map<string, Flat> {
  if (!Array.isArray(list)) return out;
  for (const node of list) {
    out.set(node.id, { node, parent });
    flatten(node.children, node.id, out);
  }
  return out;
}

function siblingIds(list: TreeNode[] | undefined): string[] {
  return Array.isArray(list) ? list.map((n) => n.id) : [];
}

function findNode(list: TreeNode[], id: string): TreeNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    const inner = Array.isArray(n.children) ? findNode(n.children, id) : null;
    if (inner) return inner;
  }
  return null;
}

/** Differing own fields (not children / modificationTime) between two records. */
function changedFields(a: TreeNode, b: TreeNode): string[] {
  return unionKeys(a, b).filter((k) => !OWN_SKIP.has(k) && !same(a[k], b[k], k));
}

function undoTree(
  top: TreeNode[],
  beforeList: TreeNode[],
  afterList: TreeNode[],
  conflicts: Conflict[],
): void {
  const B = flatten(beforeList, null);
  const A = flatten(afterList, null);
  const created = new Set([...A.keys()].filter((id) => !B.has(id)));
  const removed = new Set([...B.keys()].filter((id) => !A.has(id)));

  // 1. Own fields (name, color, tags, ...) of records that still exist: restore where the
  //    current value is still what the group wrote, report where it is not.
  let C = flatten(top, null);
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const cur = C.get(id);
    const differs = changedFields(b.node, a.node);
    const moved = b.parent !== a.parent;
    if (!cur) {
      if (differs.length || moved)
        conflicts.push({ id, field: 'folder', reason: 'no longer exists' });
      continue;
    }
    for (const key of differs) {
      if (same(cur.node[key], a.node[key], key)) setOrDelete(cur.node, key, b.node[key]);
      else conflicts.push({ id, field: key, reason: CHANGED_SINCE });
    }
  }

  // 2. Records the group moved to another parent: lift them out now, put them back in step 5.
  const reinsert: { id: string; node: TreeNode }[] = [];
  for (const [id, b] of B) {
    const a = A.get(id);
    const cur = C.get(id);
    if (!a || !cur || b.parent === a.parent) continue;
    if (cur.parent !== a.parent) {
      conflicts.push({ id, field: 'parent', reason: CHANGED_SINCE });
      continue;
    }
    const list = cur.parent === null ? top : C.get(cur.parent)!.node.children!;
    list.splice(list.indexOf(cur.node), 1);
    reinsert.push({ id, node: cur.node });
  }

  // 3. Records the group created: remove them. Anything that is not ours but sits inside
  //    (a subfolder someone added since) is lifted into the place where the record was.
  const dropCreated = (list: TreeNode[]): void => {
    for (let i = 0; i < list.length;) {
      const n = list[i];
      if (created.has(n.id)) {
        const ours = A.get(n.id)!.node;
        for (const key of changedFields(n, ours))
          conflicts.push({ id: n.id, field: key, reason: CHANGED_SINCE });
        const kids = Array.isArray(n.children) ? n.children : [];
        if (kids.some((k) => !created.has(k.id)))
          conflicts.push({ id: n.id, field: 'children', reason: CHANGED_SINCE });
        list.splice(i, 1, ...kids); // re-examine what was spliced in
      } else {
        if (Array.isArray(n.children)) dropCreated(n.children);
        i++;
      }
    }
  };
  dropCreated(top);

  // 4. Sibling order: if the group reordered records that kept their parent, put them back in
  //    the old relative order, but only if their order is still what the group left. This runs
  //    BEFORE the records below go back in, so they land next to neighbours already in order.
  C = flatten(top, null);
  const childrenOf = (tree: Map<string, Flat>, roots: TreeNode[], parentId: string | null) =>
    parentId === null ? roots : tree.get(parentId)?.node.children;
  for (const parentId of new Set([...B.values()].map((f) => f.parent))) {
    const stayed = [...B.keys()].filter(
      (id) =>
        B.get(id)!.parent === parentId &&
        A.get(id)?.parent === parentId &&
        C.get(id)?.parent === parentId,
    );
    if (stayed.length < 2) continue;
    const orderIn = (list: TreeNode[] | undefined) =>
      siblingIds(list).filter((id) => stayed.includes(id));
    const bOrder = orderIn(childrenOf(B, beforeList, parentId));
    const aOrder = orderIn(childrenOf(A, afterList, parentId));
    if (isDeepStrictEqual(bOrder, aOrder)) continue;
    const list = childrenOf(C, top, parentId)!;
    if (!isDeepStrictEqual(orderIn(list), aOrder)) {
      conflicts.push({ id: parentId ?? 'root', field: 'order', reason: CHANGED_SINCE });
      continue;
    }
    // Same slots, old order: records that are not ours keep their places.
    const slots = list.flatMap((n, i) => (stayed.includes(n.id) ? [i] : []));
    const byId = new Map(list.filter((n) => stayed.includes(n.id)).map((n) => [n.id, n]));
    bOrder.forEach((id, k) => (list[slots[k]] = byId.get(id)!));
  }

  // 5. Records the group removed or moved: put back the subtree it removed, at the old parent
  //    (top level if that parent is gone) right after the sibling it followed.
  C = flatten(top, null);
  for (const id of removed) {
    const b = B.get(id)!;
    if (b.parent !== null && removed.has(b.parent)) continue; // comes back with its parent
    if (C.has(id)) continue; // somebody already re-created it
    reinsert.push({ id, node: subtreeRemoved(b.node, removed) });
  }
  const beforeOrder = [...B.keys()];
  reinsert.sort((x, y) => beforeOrder.indexOf(x.id) - beforeOrder.indexOf(y.id));
  for (const { id, node } of reinsert) {
    const parentId = B.get(id)!.parent;
    const parent = parentId === null ? null : findNode(top, parentId);
    let target = top;
    if (parent) {
      if (!Array.isArray(parent.children)) parent.children = [];
      target = parent.children;
    }
    const wanted =
      parentId === null ? siblingIds(beforeList) : siblingIds(B.get(parentId)!.node.children);
    insertAfterNeighbour(target, node, wanted, id);
  }
}

/** A copy of `node` that keeps only the children the group removed (the rest live elsewhere now). */
function subtreeRemoved(node: TreeNode, removed: Set<string>): TreeNode {
  const copy = structuredClone(node);
  const prune = (n: TreeNode) => {
    if (!Array.isArray(n.children)) return;
    n.children = n.children.filter((c) => removed.has(c.id));
    n.children.forEach(prune);
  };
  prune(copy);
  return copy;
}

/** Insert right after the nearest earlier sibling that is still there, else before the nearest later one. */
function insertAfterNeighbour(
  target: TreeNode[],
  node: TreeNode,
  wanted: string[],
  id: string,
): void {
  const at = wanted.indexOf(id);
  for (let i = at - 1; i >= 0; i--) {
    const pos = target.findIndex((n) => n.id === wanted[i]);
    if (pos >= 0) return void target.splice(pos + 1, 0, node);
  }
  for (let i = at + 1; i < wanted.length; i++) {
    const pos = target.findIndex((n) => n.id === wanted[i]);
    if (pos >= 0) return void target.splice(pos, 0, node);
  }
  target.push(node);
}
