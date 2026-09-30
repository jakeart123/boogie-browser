import { describe, expect, it } from 'vitest';
import {
  ROW_H,
  VIRTUAL_MIN,
  ancestorIds,
  ancestorsInTree,
  branchIds,
  countDescendants,
  flatten,
  isSelfOrDescendant,
  moveTarget,
  scrollToReveal,
  siblingMove,
  windowRange,
  zoneAt,
} from './tree';

interface N {
  id: string;
  name: string;
  children: N[];
}
const n = (id: string, ...children: N[]): N => ({ id, name: id, children });

// a
//   a1
//   a2
//     a2x
// b
// c   (two folders can share a name, ids are what count)
const roots = [n('a', n('a1'), n('a2', n('a2x'))), n('b'), n('c')];

function lookup(rs: N[]) {
  const map = new Map<string, { node: N; parentId: string | null }>();
  const walk = (nodes: N[], parentId: string | null) =>
    nodes.forEach((node) => (map.set(node.id, { node, parentId }), walk(node.children, node.id)));
  walk(rs, null);
  return map;
}
const folders = lookup(roots);

describe('flatten', () => {
  it('lists only rows under open branches, with depth', () => {
    expect(flatten(roots, new Set()).map((r) => r.node.id)).toEqual(['a', 'b', 'c']);
    const rows = flatten(roots, new Set(['a', 'a2']));
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a2', 1],
      ['a2x', 2],
      ['b', 0],
      ['c', 0],
    ]);
    expect(rows[0]).toMatchObject({ open: true, hasChildren: true, parentId: null });
    expect(rows[1]).toMatchObject({ open: false, hasChildren: false, parentId: 'a' });
  });
  it('keeps a repeated id from crashing a keyed list', () => {
    const dup = [n('x'), n('x')];
    expect(flatten(dup, new Set()).length).toBe(1);
  });
  it('branchIds is every node that has children', () => {
    expect(branchIds(roots)).toEqual(['a', 'a2']);
  });
});

describe('folder relations', () => {
  it('finds ancestors and refuses descendants', () => {
    expect(ancestorIds(folders, 'a2x')).toEqual(['a', 'a2']);
    expect(ancestorIds(folders, 'b')).toEqual([]);
    expect(ancestorsInTree(roots, 'a2x')).toEqual(['a', 'a2']);
    expect(ancestorsInTree(roots, 'nope')).toBeNull();
    expect(isSelfOrDescendant(folders, 'a', 'a2x')).toBe(true);
    expect(isSelfOrDescendant(folders, 'a', 'a')).toBe(true);
    expect(isSelfOrDescendant(folders, 'a2', 'a')).toBe(false);
    expect(countDescendants(roots[0])).toBe(3);
  });
});

describe('moveTarget', () => {
  it('nests on the middle of a row, at the end of its children', () => {
    expect(moveTarget(folders, roots, 'b', 'a', 'inside')).toEqual({ parentId: 'a', index: 2 });
  });
  it('reorders using the final position after the folder leaves its old spot', () => {
    // a, b, c: drag a after c -> [b, c, a] so a ends at index 2
    expect(moveTarget(folders, roots, 'a', 'c', 'after')).toEqual({ parentId: null, index: 2 });
    // drag c before a -> [c, a, b]
    expect(moveTarget(folders, roots, 'c', 'a', 'before')).toEqual({ parentId: null, index: 0 });
    // drag a before c -> [b, a, c]
    expect(moveTarget(folders, roots, 'a', 'c', 'before')).toEqual({ parentId: null, index: 1 });
  });
  it('moves between levels', () => {
    expect(moveTarget(folders, roots, 'b', 'a2x', 'before')).toEqual({ parentId: 'a2', index: 0 });
    expect(moveTarget(folders, roots, 'a2x', 'c', 'after')).toEqual({ parentId: null, index: 3 });
  });
  it('refuses itself and its own descendants', () => {
    expect(moveTarget(folders, roots, 'a', 'a', 'inside')).toBeNull();
    expect(moveTarget(folders, roots, 'a', 'a2x', 'inside')).toBeNull();
    expect(moveTarget(folders, roots, 'a', 'a1', 'after')).toBeNull();
  });
  it('returns null when nothing would change', () => {
    expect(moveTarget(folders, roots, 'b', 'c', 'before')).toBeNull(); // already right before c
    expect(moveTarget(folders, roots, 'b', 'a', 'after')).toBeNull(); // already right after a
    expect(moveTarget(folders, roots, 'a2', 'a', 'inside')).toBeNull(); // already the last child of a
    expect(moveTarget(folders, roots, 'a1', 'a', 'inside')).toEqual({ parentId: 'a', index: 1 }); // to the end of its own parent
  });
});

describe('siblingMove', () => {
  it('moves one step or to the ends, and stops at the edges', () => {
    expect(siblingMove(folders, roots, 'b', 'up')).toEqual({ parentId: null, index: 0 });
    expect(siblingMove(folders, roots, 'b', 'down')).toEqual({ parentId: null, index: 2 });
    expect(siblingMove(folders, roots, 'a', 'up')).toBeNull();
    expect(siblingMove(folders, roots, 'c', 'down')).toBeNull();
    expect(siblingMove(folders, roots, 'a', 'bottom')).toEqual({ parentId: null, index: 2 });
    expect(siblingMove(folders, roots, 'a2', 'top')).toEqual({ parentId: 'a', index: 0 });
  });
});

describe('zoneAt', () => {
  it('quarters a row', () => {
    expect(zoneAt(2, 26)).toBe('before');
    expect(zoneAt(13, 26)).toBe('inside');
    expect(zoneAt(24, 26)).toBe('after');
  });
});

describe('virtual window', () => {
  it('renders everything for small lists', () => {
    expect(windowRange(VIRTUAL_MIN, 5000, 600, 100)).toEqual([0, VIRTUAL_MIN]);
  });
  it('renders the rows in view plus overscan for big lists', () => {
    const [s, e] = windowRange(6554, 26000 + 300, 600, 300);
    expect(s).toBe(1000 - 12);
    expect(e).toBe(1000 + Math.ceil(600 / ROW_H) + 12);
  });
  it('is empty when the list is entirely off screen, and clamps at the end', () => {
    expect(windowRange(2000, 0, 600, 100000)).toEqual([0, 0]);
    expect(windowRange(2000, 999999, 600, 0)).toEqual([2000, 2000]);
  });
  it('scrolls only as far as needed to reveal a row', () => {
    expect(scrollToReveal(10, 0, 600, 300)).toBeNull(); // row at 560..586, inside
    expect(scrollToReveal(50, 0, 600, 300)).toBe(300 + 50 * ROW_H + ROW_H + 6 - 600);
    expect(scrollToReveal(0, 900, 600, 300)).toBe(294);
  });
});
