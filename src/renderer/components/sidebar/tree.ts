// Pure tree logic for the sidebar: flattening, drop targets, sibling moves, virtual window.
// No Svelte and no DOM here so it can be unit tested.

export const ROW_H = 26;
/** Above this many visible rows the folder list only renders the rows in view. */
export const VIRTUAL_MIN = 800;

export interface Row<T> {
  node: T;
  depth: number;
  parentId: string | null;
  open: boolean;
  hasChildren: boolean;
}

/** The visible rows of a tree, top to bottom, given which branches are open. */
export function flatten<T extends { id: string; children: T[] }>(
  roots: T[],
  expanded: ReadonlySet<string>,
): Row<T>[] {
  const out: Row<T>[] = [];
  const seen = new Set<string>(); // a broken library with a repeated id must not crash the keyed list
  const walk = (nodes: T[], depth: number, parentId: string | null) => {
    for (const node of nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const hasChildren = node.children.length > 0;
      const open = hasChildren && expanded.has(node.id);
      out.push({ node, depth, parentId, open, hasChildren });
      if (open) walk(node.children, depth + 1, node.id);
    }
  };
  walk(roots, 0, null);
  return out;
}

/** Ids of every node that has children (what "expand all" opens). */
export function branchIds<T extends { id: string; children: T[] }>(roots: T[]): string[] {
  const out: string[] = [];
  const walk = (nodes: T[]) =>
    nodes.forEach((n) => {
      if (n.children.length) (out.push(n.id), walk(n.children));
    });
  walk(roots);
  return out;
}

export interface FolderLookup {
  get(id: string): { node: { children: { id: string }[] }; parentId: string | null } | undefined;
}

/** Ids from the top level down to (not including) `id`. */
export function ancestorIds(folders: FolderLookup, id: string): string[] {
  const out: string[] = [];
  for (let cur = folders.get(id)?.parentId ?? null; cur; cur = folders.get(cur)?.parentId ?? null)
    out.unshift(cur);
  return out;
}

/** Same as ancestorIds, for trees with no id lookup (smart folders). Null if `id` isn't in the tree. */
export function ancestorsInTree<T extends { id: string; children: T[] }>(
  roots: T[],
  id: string,
): string[] | null {
  for (const node of roots) {
    if (node.id === id) return [];
    const below = ancestorsInTree(node.children, id);
    if (below) return [node.id, ...below];
  }
  return null;
}

/** True when `id` is `ancestorId` itself or sits anywhere below it. */
export function isSelfOrDescendant(folders: FolderLookup, ancestorId: string, id: string): boolean {
  for (let cur: string | null = id; cur; cur = folders.get(cur)?.parentId ?? null)
    if (cur === ancestorId) return true;
  return false;
}

export function countDescendants(node: { children: { children: unknown[] }[] }): number {
  let n = 0;
  const walk = (kids: { children: unknown[] }[]) => {
    n += kids.length;
    kids.forEach((k) => walk(k.children as { children: unknown[] }[]));
  };
  walk(node.children);
  return n;
}

export type Zone = 'before' | 'inside' | 'after';

/** Where on a row a dragged folder is: the top quarter is "before", the bottom quarter "after". */
export function zoneAt(offsetY: number, height: number): Zone {
  const f = offsetY / height;
  return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside';
}

export interface MoveTarget {
  parentId: string | null;
  /** Final position among the new parent's children once the folder has been moved. */
  index: number;
}

function siblingIds(
  folders: FolderLookup,
  roots: { id: string }[],
  parentId: string | null,
): string[] {
  return (parentId ? (folders.get(parentId)?.node.children ?? []) : roots).map((c) => c.id);
}

/**
 * Turn "dropped `dragId` on `targetId` at `zone`" into a moveFolder call. Returns null when the
 * drop is refused (onto itself or its own descendant) or would change nothing.
 */
export function moveTarget(
  folders: FolderLookup,
  roots: { id: string }[],
  dragId: string,
  targetId: string,
  zone: Zone,
): MoveTarget | null {
  if (isSelfOrDescendant(folders, dragId, targetId)) return null;
  const drag = folders.get(dragId);
  const target = folders.get(targetId);
  if (!drag || !target) return null;
  let parentId: string | null;
  let index: number;
  if (zone === 'inside') {
    parentId = targetId;
    index = siblingIds(folders, roots, targetId).filter((id) => id !== dragId).length;
  } else {
    parentId = target.parentId;
    const others = siblingIds(folders, roots, parentId).filter((id) => id !== dragId);
    index = others.indexOf(targetId) + (zone === 'after' ? 1 : 0);
  }
  if (parentId === drag.parentId && siblingIds(folders, roots, parentId).indexOf(dragId) === index)
    return null;
  return { parentId, index };
}

/** Ctrl+[ / Ctrl+] (and with Shift, top / bottom): a new position among the same siblings. */
export function siblingMove(
  folders: FolderLookup,
  roots: { id: string }[],
  id: string,
  how: 'up' | 'down' | 'top' | 'bottom',
): MoveTarget | null {
  const info = folders.get(id);
  if (!info) return null;
  const sibs = siblingIds(folders, roots, info.parentId);
  const at = sibs.indexOf(id);
  const to = how === 'up' ? at - 1 : how === 'down' ? at + 1 : how === 'top' ? 0 : sibs.length - 1;
  if (at < 0 || to < 0 || to >= sibs.length || to === at) return null;
  return { parentId: info.parentId, index: to };
}

/** Rows [start, end) to render. Small lists render whole. */
export function windowRange(
  count: number,
  scrollTop: number,
  viewH: number,
  treeTop: number,
  overscan = 12,
): [number, number] {
  if (count <= VIRTUAL_MIN) return [0, count];
  const first = Math.floor((scrollTop - treeTop) / ROW_H) - overscan;
  const last = Math.ceil((scrollTop + viewH - treeTop) / ROW_H) + overscan;
  const clamp = (n: number) => Math.min(count, Math.max(0, n));
  return [clamp(first), clamp(last)];
}

/** The scrollTop that brings row `index` fully into view, or null if it already is. */
export function scrollToReveal(
  index: number,
  scrollTop: number,
  viewH: number,
  treeTop: number,
  pad = 6,
): number | null {
  const top = treeTop + index * ROW_H;
  if (top - pad < scrollTop) return Math.max(0, top - pad);
  if (top + ROW_H + pad > scrollTop + viewH) return top + ROW_H + pad - viewH;
  return null;
}
