// What an outside change to the root metadata.json did, in a few words for History
// ("added folder “Hands”", "renamed folder “A” to “B”", "deleted tag group “Poses”").
import type { EagleRootRecord } from '../../shared/types';
import { quoted } from './labels';

/** Children are their own records; the rest are Eagle's runtime keys, which its first root save drops. */
const IGNORED = new Set(['children', 'extendTags', 'pinyin', 'isExpand']);

interface Node {
  id: string;
  name: string;
  parent: string | null;
  own: string; // the record without its children
}

function flatten(list: unknown, parent: string | null = null, out = new Map<string, Node>()) {
  if (!Array.isArray(list)) return out;
  for (const f of list as Record<string, unknown>[]) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string') continue;
    const own = JSON.stringify(f, (k, v) => (IGNORED.has(k) ? undefined : v));
    out.set(f.id, { id: f.id, name: String(f.name ?? ''), parent, own });
    flatten(f.children, f.id, out);
  }
  return out;
}

function describe(kind: string, before: Map<string, Node>, after: Map<string, Node>): string[] {
  const added = [...after.values()].filter((n) => !before.has(n.id));
  const removed = [...before.values()].filter((n) => !after.has(n.id));
  const renamed: [Node, Node][] = [];
  const moved: Node[] = [];
  const changed: Node[] = [];
  for (const a of after.values()) {
    const b = before.get(a.id);
    if (!b) continue;
    if (b.name !== a.name) renamed.push([b, a]);
    else if (b.parent !== a.parent) moved.push(a);
    else if (b.own !== a.own) changed.push(a);
  }
  const some = (verb: string, list: Node[]) =>
    list.length === 1
      ? `${verb} ${kind} ${quoted(list[0]!.name)}`
      : `${verb} ${list.length} ${kind}s`;
  const parts: string[] = [];
  if (added.length) parts.push(some('added', added));
  if (removed.length) parts.push(some('deleted', removed));
  if (renamed.length === 1)
    parts.push(`renamed ${kind} ${quoted(renamed[0]![0].name)} to ${quoted(renamed[0]![1].name)}`);
  else if (renamed.length) parts.push(`renamed ${renamed.length} ${kind}s`);
  if (moved.length) parts.push(some('moved', moved));
  if (changed.length) parts.push(some('changed', changed));
  // Only the order changed (a reorder moves no record and renames nothing).
  if (!parts.length && [...before.keys()].join() !== [...after.keys()].join())
    parts.push(`reordered ${kind}s`);
  return parts;
}

/** Empty when nothing a person would call a change happened (say only modificationTime moved). */
export function rootChangeParts(
  before: EagleRootRecord | null,
  after: EagleRootRecord | null,
): string[] {
  const b = (before ?? {}) as Partial<EagleRootRecord>;
  const a = (after ?? {}) as Partial<EagleRootRecord>;
  const parts = [
    ...describe('folder', flatten(b.folders), flatten(a.folders)),
    ...describe('smart folder', flatten(b.smartFolders), flatten(a.smartFolders)),
    ...describe('tag group', flatten(b.tagsGroups), flatten(a.tagsGroups)),
  ];
  if (JSON.stringify(b.quickAccess ?? []) !== JSON.stringify(a.quickAccess ?? []))
    parts.push('changed quick access');
  return parts;
}
