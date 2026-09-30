// A flat, searchable view of the folder tree so tools can accept names, paths or ids.
import type { EagleRootRecord, FolderNode } from '../../shared/types';
import { autoTagsFor } from '../eagle/root';
import { UserError } from './errors';

export interface FolderEntry {
  id: string;
  name: string;
  /** "Parent / Child" */
  path: string;
  parentId: string | null;
  depth: number;
  node: FolderNode;
}

/** Edit distance, for "did you mean" hints on misspelled folder names. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

const norm = (s: string): string =>
  s
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' / ')
    .toLowerCase();

export class FolderIndex {
  /** Depth-first, in the order the app shows them. */
  readonly list: FolderEntry[] = [];
  private byId = new Map<string, FolderEntry>();
  /** The tree in the root record's shape, for the app's own folder rules. */
  private readonly root: EagleRootRecord;

  constructor(tree: FolderNode[]) {
    this.root = { folders: tree } as unknown as EagleRootRecord;
    const walk = (nodes: FolderNode[], parent: FolderEntry | null) => {
      for (const node of nodes) {
        const entry: FolderEntry = {
          id: node.id,
          name: node.name,
          path: parent ? `${parent.path} / ${node.name}` : node.name,
          parentId: parent?.id ?? null,
          depth: parent ? parent.depth + 1 : 0,
          node,
        };
        this.list.push(entry);
        this.byId.set(node.id, entry);
        walk(node.children, entry);
      }
    };
    walk(tree, null);
  }

  get(id: string): FolderEntry | undefined {
    return this.byId.get(id);
  }

  /** Readable path for an id; falls back to the id itself for folders that no longer exist. */
  pathOf(id: string): string {
    return this.byId.get(id)?.path ?? id;
  }

  /** The folder and everything under it. */
  subtreeIds(id: string): string[] {
    const out: string[] = [];
    const walk = (n: FolderNode) => {
      out.push(n.id);
      n.children.forEach(walk);
    };
    const e = this.byId.get(id);
    if (e) walk(e.node);
    return out;
  }

  /** Auto-tags a folder gives items added to it (its own and its ancestors'), by the app's rule. */
  autoTags(id: string): string[] {
    return autoTagsFor(this.root, id);
  }

  /** Accepts an id, a full path ("Parent / Child") or a unique folder name. */
  resolve(ref: string): FolderEntry {
    const direct = this.byId.get(ref);
    if (direct) return direct;
    const want = norm(ref);
    const byPath = this.list.filter((e) => norm(e.path) === want);
    if (byPath.length === 1) return byPath[0];
    const byName = this.list.filter((e) => e.name.trim().toLowerCase() === want);
    const found = byPath.length > 1 ? byPath : byName;
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new UserError(
        `"${ref}" matches ${found.length} folders. Use the id or the full path: ${found
          .slice(0, 6)
          .map((e) => `${e.path} (${e.id})`)
          .join('; ')}`,
      );
    }
    const near = this.list
      .filter((e) => {
        const name = e.name.toLowerCase();
        return (
          name.includes(want) ||
          want.includes(name) ||
          distance(name, want) <= Math.max(2, Math.floor(want.length / 4))
        );
      })
      .slice(0, 5);
    const hint = near.length
      ? ` Similar: ${near.map((e) => `${e.path} (${e.id})`).join('; ')}.`
      : '';
    throw new UserError(`No folder matches "${ref}". Use list_folders for ids and paths.${hint}`);
  }

  resolveAll(refs: string[]): FolderEntry[] {
    const seen = new Set<string>();
    return refs.map((r) => this.resolve(r)).filter((e) => !seen.has(e.id) && seen.add(e.id));
  }
}
