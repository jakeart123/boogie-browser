// The library's root metadata.json against a conflicted copy of it: folders and smart folders by
// id, tag groups and quick access as whole entries. Pure: no fs.
//
// `diff` + `applyChange` are the manual Compare of service/rootConflict.ts (folders by id, every
// difference listed, picked ones applied). `mergeRoot` adds the three-way decision per part of a
// folder (its place, its name, its colour ...), so some parts can be taken at once while the rest
// stay questions.
import type {
  EagleFolderRecord,
  EagleRootRecord,
  EagleSmartFolderRecord,
  RootConflictPlan,
} from '../../shared/types';
import {
  locateFolder,
  locateSmartFolder,
  moveFolder,
  moveSmartFolder,
  removeFolder,
  removeSmartFolder,
} from '../eagle/root';
import { judge, MISSING } from './judge';
import { canon, same, strip } from './normalize';
import { NONE, quoted, shown, type Diff, type Rec, type Verdict } from './types';

export type Kind = 'folder' | 'smartFolder';
type Folder = EagleFolderRecord | EagleSmartFolderRecord;
export type Change = RootConflictPlan['changes'][number];
/** A change and which parts of the folder differ: 'exists' (only one side has it), 'parent', or field names. */
export interface Found extends Change {
  aspects: string[];
}

export interface Node {
  rec: Folder;
  parentId: string | null;
  index: number;
}

/** The fields that make a folder what it is (not its children, and not Eagle's runtime keys). */
export const FIELDS: Record<Kind, string[]> = {
  folder: [
    'name',
    'description',
    'tags',
    'icon',
    'iconColor',
    'password',
    'passwordTips',
    'coverId',
    'orderBy',
    'sortIncrease',
  ],
  smartFolder: [
    'name',
    'description',
    'icon',
    'iconColor',
    'conditions',
    'orderBy',
    'sortIncrease',
  ],
};

export function flatten(
  list: unknown,
  into = new Map<string, Node>(),
  parentId: string | null = null,
) {
  if (!Array.isArray(list)) return into;
  list.forEach((rec: Folder, index) => {
    if (!rec || typeof rec.id !== 'string' || into.has(rec.id)) return;
    into.set(rec.id, { rec, parentId, index });
    flatten(rec.children, into, rec.id);
  });
  return into;
}

const differs = (a: unknown, b: unknown) => !same(strip(a), strip(b));

const FIELD_NAMES: Record<string, string> = {
  tags: 'auto-tags',
  coverId: 'cover',
  orderBy: 'sort',
  sortIncrease: 'sort',
  conditions: 'rules',
  password: 'password',
  passwordTips: 'password hint',
};
const fieldName = (f: string) => FIELD_NAMES[f] ?? f;

const nounOf = (kind: Kind) => (kind === 'folder' ? 'Folder' : 'Smart folder');

// ───────────────────────── listing the differences ─────────────────────────

/** The differences between two flattened trees, by id. A folder only on one side is listed once, for its topmost folder. */
function diffKind(kind: Kind, a: Map<string, Node>, b: Map<string, Node>, whose: string): Found[] {
  const changes: Found[] = [];
  const noun = nounOf(kind);
  const nameIn = (m: Map<string, Node>, id: string | null) =>
    id ? String(m.get(id)?.rec.name ?? '') : '';

  for (const [id, node] of b) {
    const mine = a.get(id);
    if (!mine) {
      if (node.parentId && !a.has(node.parentId) && b.has(node.parentId)) continue; // its parent is listed
      const subs = flatten(node.rec.children).size;
      changes.push({
        id,
        kind,
        change: 'onlyInCopy',
        label: `${noun} ${quoted(node.rec.name)}${subs ? ` (with ${subs} inside)` : ''} is only in ${whose}`,
        aspects: ['exists'],
      });
      continue;
    }
    const parts: string[] = [];
    const aspects: string[] = [];
    let change: Change['change'] | null = null;
    if (mine.parentId !== node.parentId) {
      change = 'moved';
      aspects.push('parent');
      parts.push(node.parentId ? `inside ${quoted(nameIn(b, node.parentId))}` : 'at the top level');
    }
    const diffs = FIELDS[kind].filter((f) => differs(mine.rec[f], node.rec[f]));
    aspects.push(...diffs);
    if (diffs.includes('name')) {
      change ??= 'renamed';
      parts.push(`called ${quoted(node.rec.name)}`);
    }
    if (diffs.includes('iconColor')) {
      change ??= 'recolored';
      parts.push(node.rec.iconColor ? `colored ${String(node.rec.iconColor)}` : 'without a color');
    }
    const other = diffs.filter((f) => f !== 'name' && f !== 'iconColor');
    if (other.length) {
      change ??= 'other';
      parts.push(`with other changes (${other.map(fieldName).join(', ')})`);
    }
    if (change)
      changes.push({
        id,
        kind,
        change,
        label: `${noun} ${quoted(mine.rec.name)} is ${parts.join(', ')} in ${whose}`,
        aspects,
      });
  }
  for (const [id, node] of a) {
    if (b.has(id)) continue;
    if (node.parentId && !b.has(node.parentId) && a.has(node.parentId)) continue;
    // Only what the copy doesn't have goes with it; subfolders the copy kept stay.
    const subs = [...flatten(node.rec.children).keys()].filter((sub) => !b.has(sub)).length;
    changes.push({
      id,
      kind,
      change: 'deletedInCopy',
      label: `${noun} ${quoted(node.rec.name)}${subs ? ` (with ${subs} inside)` : ''} is not in ${whose}`,
      aspects: ['exists'],
    });
  }
  return changes;
}

const treesOf = (root: EagleRootRecord, kind: Kind) =>
  flatten(root[kind === 'folder' ? 'folders' : 'smartFolders']);

/** Folder and smart folder differences between the library's root and a copy of it. */
export function diffRoot(live: EagleRootRecord, copy: EagleRootRecord, whose: string): Found[] {
  return (['folder', 'smartFolder'] as const).flatMap((kind) =>
    diffKind(kind, treesOf(live, kind), treesOf(copy, kind), whose),
  );
}

// ───────────────────────── applying ─────────────────────────

/** A deep copy of `rec` without the subtrees whose ids the live tree already has. */
function cloneWithout(rec: Folder, taken: Set<string>): Folder {
  const copy = structuredClone(rec) as Folder;
  const prune = (r: { children?: Folder[] }) => {
    if (!Array.isArray(r.children)) return;
    r.children = r.children.filter((c) => c && !taken.has(c.id));
    for (const c of r.children) prune(c);
  };
  prune(copy);
  return copy;
}

/**
 * Take away a folder the copy doesn't have. Its subfolders that the copy does have (the
 * partner moved them out before deleting it, say) are lifted out to where it was first, with what
 * they hold.
 */
function removeKeepingCopy(root: EagleRootRecord, kind: Kind, id: string, inCopy: Set<string>) {
  const locate = kind === 'folder' ? locateFolder : locateSmartFolder;
  const move = kind === 'folder' ? moveFolder : moveSmartFolder;
  const at = locate(root, id);
  if (!at) return false;
  const kept: string[] = [];
  const walk = (r: Folder) => {
    for (const child of (r.children ?? []) as Folder[])
      if (inCopy.has(child.id)) kept.push(child.id);
      else walk(child);
  };
  walk(at.node);
  const parentId = at.parent?.id ?? null;
  kept.forEach((sub, i) => move(root, sub, parentId, at.index + 1 + i));
  return (kind === 'folder' ? removeFolder : removeSmartFolder)(root, id).length > 0;
}

/**
 * Make one folder look like it does in the copy. `only`: just these parts of it ('parent' and
 * field names); without it, all of them. A folder that exists on one side only is added or removed whole.
 */
export function applyChange(
  root: EagleRootRecord,
  copy: EagleRootRecord,
  c: Change,
  only?: ReadonlySet<string>,
): boolean {
  const key = c.kind === 'folder' ? 'folders' : 'smartFolders';
  const locate = c.kind === 'folder' ? locateFolder : locateSmartFolder;
  const copyNodes = flatten(copy[key]);
  const theirs = copyNodes.get(c.id);
  if (c.change === 'deletedInCopy')
    return removeKeepingCopy(root, c.kind, c.id, new Set(copyNodes.keys()));
  if (!theirs) return false;
  const liveNodes = flatten(root[key]);
  // Under the same parent as in the copy if that parent exists here, else at the top level.
  const parentId = theirs.parentId && liveNodes.has(theirs.parentId) ? theirs.parentId : null;

  if (c.change === 'onlyInCopy') {
    if (liveNodes.has(c.id)) return false;
    const rec = cloneWithout(theirs.rec, new Set(liveNodes.keys()));
    const list = parentId
      ? ((locate(root, parentId)!.node.children ??= []) as Folder[])
      : ((root[key] ??= []) as Folder[]);
    list.splice(Math.min(theirs.index, list.length), 0, rec);
    return true;
  }

  const mine = locate(root, c.id)?.node as Folder | undefined;
  if (!mine) return false;
  let changed = false;
  for (const f of FIELDS[c.kind]) {
    if (only && !only.has(f)) continue;
    if (same(strip(mine[f]), strip(theirs.rec[f]))) continue;
    if (theirs.rec[f] === undefined) delete mine[f];
    else mine[f] = structuredClone(theirs.rec[f]);
    changed = true;
  }
  if ((!only || only.has('parent')) && (liveNodes.get(c.id)?.parentId ?? null) !== parentId) {
    try {
      changed =
        (c.kind === 'folder' ? moveFolder : moveSmartFolder)(root, c.id, parentId, theirs.index) ||
        changed;
    } catch {
      /* the copy's place would be inside itself here: leave it where it is */
    }
  }
  return changed;
}

/**
 * The folders that go away when `ids` (deletedInCopy changes) are applied: each one and its
 * descendants the copy doesn't have. They have to come off their items first.
 */
export function foldersLeaving(
  live: EagleRootRecord,
  copy: EagleRootRecord,
  ids: readonly string[],
): string[] {
  const inCopy = flatten(copy.folders);
  const nodes = flatten(live.folders);
  const out: string[] = [];
  for (const id of ids) {
    const node = nodes.get(id);
    if (!node) continue;
    out.push(id, ...flatten(node.rec.children).keys());
  }
  return [...new Set(out)].filter((id) => !inCopy.has(id));
}

/** Additions first (a moved folder may go inside a new one), removals last. */
const ORDER: Change['change'][] = [
  'onlyInCopy',
  'renamed',
  'recolored',
  'other',
  'moved',
  'deletedInCopy',
];
export const byApplyOrder = <T extends Change>(changes: T[]): T[] =>
  [...changes].sort((a, b) => ORDER.indexOf(a.change) - ORDER.indexOf(b.change));

// ───────────────────────── the three-way merge ─────────────────────────

function aspectText(kind: Kind, nodes: Map<string, Node>, id: string, aspect: string): string {
  const node = nodes.get(id);
  if (aspect === 'exists') {
    if (!node) return NONE;
    const subs = flatten(node.rec.children).size;
    return `${quoted(node.rec.name)}${subs ? ` (with ${subs} inside)` : ''}`;
  }
  if (!node) return NONE;
  if (aspect === 'parent')
    return node.parentId
      ? `inside ${quoted(String(nodes.get(node.parentId)?.rec.name ?? ''))}`
      : 'at the top level';
  if (aspect === 'name') return quoted(node.rec.name);
  if (aspect === 'iconColor') return node.rec.iconColor ? String(node.rec.iconColor) : 'no color';
  return `${fieldName(aspect)}: ${shown(strip(node.rec[aspect]), 60)}`;
}

function folderDiffs(
  kind: Kind,
  live: EagleRootRecord,
  copy: EagleRootRecord,
  bases: readonly EagleRootRecord[],
  opts: MergeRootOptions,
): Diff<EagleRootRecord>[] {
  const { auto } = opts;
  const L = treesOf(live, kind);
  const C = treesOf(copy, kind);
  const B = bases.map((b) => treesOf(b, kind));
  const out: Diff<EagleRootRecord>[] = [];

  // Two folders can share a name (two "Hands"). Then the label says how many items each holds,
  // so a person can tell which one a question is about.
  const named = new Map<string, number>();
  for (const node of new Map([...C, ...L]).values())
    named.set(String(node.rec.name), (named.get(String(node.rec.name)) ?? 0) + 1);
  const which = (id: string, name: string): string => {
    const n = kind === 'folder' && (named.get(name) ?? 0) > 1 ? opts.itemCount?.(id) : undefined;
    return n === undefined ? '' : ` (${n === 0 ? 'no items' : n === 1 ? '1 item' : `${n} items`})`;
  };

  const value = (nodes: Map<string, Node>, id: string, aspect: string): unknown => {
    const node = nodes.get(id);
    if (aspect === 'exists') return !!node;
    if (!node) return MISSING;
    return aspect === 'parent' ? node.parentId : strip(node.rec[aspect]);
  };

  /** The subfolders the copy has inside this folder that the library doesn't have. */
  const inside = (id: string) =>
    [...flatten(C.get(id)!.rec.children).keys()].filter((x) => !L.has(x));

  for (const c of byApplyOrder(diffKind(kind, L, C, ''))) {
    const by: Record<Verdict, string[]> = { copy: [], live: [], ask: [] };
    // A base from before the folder existed can't say who changed it: only the others count.
    const withIt = B.filter((m) => m.has(c.id));
    for (const aspect of c.aspects) {
      let v = judge(
        value(L, c.id, aspect),
        value(C, c.id, aspect),
        (aspect === 'exists' ? B : withIt).map((m) => value(m, c.id, aspect)),
      );
      if (v === 'same') v = 'live';
      if (v === 'copy') {
        // Never certain enough to apply by itself: a folder (and its items' membership) going away,
        // a new folder whose subfolders the library deliberately removed, a move to a place that isn't here.
        if (c.change === 'deletedInCopy') v = 'ask';
        else if (c.change === 'onlyInCopy') {
          if (inside(c.id).some((x) => B.some((m) => m.has(x)))) v = 'ask';
        } else if (aspect === 'parent') {
          const target = C.get(c.id)!.parentId;
          if (target !== null && !L.has(target)) v = 'ask';
        }
      } else if (v === 'live' && c.change === 'onlyInCopy') {
        // The library took this folder away, but the copy has a subfolder in it that no version
        // ever had: someone made it since, and it would go unseen with the copy.
        if (inside(c.id).some((x) => !B.some((m) => m.has(x)))) v = 'ask';
      }
      by[v === 'copy' && !auto ? 'ask' : v].push(aspect);
    }
    const name = String((L.get(c.id) ?? C.get(c.id))!.rec.name);
    for (const verdict of ['copy', 'ask', 'live'] as const) {
      const aspects = by[verdict];
      if (!aspects.length) continue;
      const set = new Set(aspects);
      out.push({
        id: c.id,
        label: `${nounOf(kind)} ${quoted(name)}${which(c.id, name)}`,
        live: aspects.map((a) => aspectText(kind, L, c.id, a)).join(', '),
        copy: aspects.map((a) => aspectText(kind, C, c.id, a)).join(', '),
        // A folder that goes away is named as one in the merge's label ("removed 1 folder").
        topic: c.change === 'deletedInCopy' ? kind : 'change',
        verdict,
        apply: (root) => applyChange(root, copy, c, set),
      });
    }
  }
  return out;
}

interface UnitKind {
  list: 'tagsGroups' | 'quickAccess';
  /** What one is called in a merge's label when it is taken away. */
  topic: string;
  noun: string;
  prefix: string;
  key(r: Rec): string;
  /** The entry's own name for the question's label (names: folder id -> folder name). */
  name(r: Rec, names: Map<string, string>): string;
  text(r: Rec): string;
}

const TAG_GROUPS: UnitKind = {
  list: 'tagsGroups',
  topic: 'tagGroup',
  noun: 'Tag group',
  prefix: 'tagGroup:',
  key: (r) => String(r.id),
  name: (r) => String(r.name),
  text: (r) =>
    `${quoted(String(r.name))}${Array.isArray(r.tags) && r.tags.length ? `: ${r.tags.join(', ')}` : ''}`,
};
const QUICK_ACCESS: UnitKind = {
  list: 'quickAccess',
  topic: 'quickAccess',
  noun: 'Quick access',
  prefix: 'quickAccess:',
  key: (r) => `${String(r.type)}:${String(r.id)}`,
  name: (r, names) => names.get(String(r.id)) ?? 'a folder',
  text: () => 'In quick access',
};

/** Tag groups and quick access entries: each is one unit, added, removed or replaced whole. */
function unitDiffs(
  what: UnitKind,
  live: EagleRootRecord,
  copy: EagleRootRecord,
  bases: readonly EagleRootRecord[],
  auto: boolean,
): Diff<EagleRootRecord>[] {
  const mapOf = (root: EagleRootRecord) => {
    const list = Array.isArray(root[what.list]) ? (root[what.list] as unknown as Rec[]) : [];
    return new Map(list.filter((r) => r && typeof r === 'object').map((r) => [what.key(r), r]));
  };
  const L = mapOf(live);
  const C = mapOf(copy);
  const B = bases.map(mapOf);
  const names = new Map<string, string>();
  for (const root of [copy, live])
    for (const kind of ['folder', 'smartFolder'] as const)
      for (const [id, n] of treesOf(root, kind)) names.set(id, n.rec.name);
  const out: Diff<EagleRootRecord>[] = [];
  const value = (m: Map<string, Rec>, key: string) => (m.has(key) ? strip(m.get(key)) : MISSING);

  for (const key of new Set([...L.keys(), ...C.keys()])) {
    const l = L.get(key);
    const c = C.get(key);
    // An entry for a folder the library no longer has is never put back.
    if (
      !l &&
      c &&
      what.list === 'quickAccess' &&
      !treesOf(live, c.type === 'smartFolder' ? 'smartFolder' : 'folder').has(String(c.id))
    )
      continue;
    // Same for an entry both sides have: a base from before it existed can't say who changed it.
    const bs = l && c ? B.filter((m) => m.has(key)) : B;
    let verdict = judge(
      value(L, key),
      value(C, key),
      bs.map((m) => value(m, key)),
    );
    if (verdict === 'same') continue;
    if (verdict === 'copy' && (!c || !auto)) verdict = 'ask'; // taking something away is never automatic
    out.push({
      id: `${what.prefix}${key}`,
      label: `${what.noun} ${quoted(what.name((l ?? c)!, names))}`,
      live: l ? what.text(l) : NONE,
      copy: c ? what.text(c) : NONE,
      topic: c ? 'change' : what.topic,
      verdict,
      apply: (root) => {
        const list = ((root as Rec)[what.list] ??= []) as Rec[];
        const at = list.findIndex((r) => what.key(r) === key);
        if (!c) {
          if (at < 0) return false;
          list.splice(at, 1);
          return true;
        }
        if (at < 0) {
          list.push(structuredClone(c));
          return true;
        }
        if (canon(strip(list[at])) === canon(strip(c))) return false;
        list[at] = structuredClone(c);
        return true;
      },
    });
  }
  return out;
}

export interface MergeRootOptions {
  /** false: nothing is certain enough to apply (every difference that isn't the library's is a question). */
  auto: boolean;
  /** How many items a folder holds, for telling two folders with one name apart in a label. */
  itemCount?(folderId: string): number | undefined;
}

/** Every difference between the library's root and a copy of it, with what the bases say about each. */
export function mergeRoot(
  live: EagleRootRecord,
  copy: EagleRootRecord,
  bases: readonly EagleRootRecord[],
  opts: MergeRootOptions,
): Diff<EagleRootRecord>[] {
  return [
    ...folderDiffs('folder', live, copy, bases, opts),
    ...folderDiffs('smartFolder', live, copy, bases, opts),
    ...unitDiffs(TAG_GROUPS, live, copy, bases, opts.auto),
    ...unitDiffs(QUICK_ACCESS, live, copy, bases, opts.auto),
  ];
}
