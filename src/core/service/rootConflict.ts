// A Dropbox conflicted copy of the root metadata.json ("metadata (Sam Lee's conflicted copy
// 2026-05-25).json"): Eagle ignores these files, so whatever the partner did to folders in that
// copy is silently lost. This lists the folder and smart-folder differences by id and applies the
// ones picked through the normal root write, as one history group. The copy itself is only read:
// never edited or deleted (format-spec 19.2 rule 6); "Reveal" lets the user remove it themselves.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Actor,
  EagleFolderRecord,
  EagleRootRecord,
  EagleSmartFolderRecord,
  MutationResult,
  RootConflictPlan,
} from '../../shared/types';
import {
  conflictedCopyBase,
  locateFolder,
  locateSmartFolder,
  moveFolder,
  moveSmartFolder,
  removeFolder,
  removeSmartFolder,
} from '../eagle';
import { editItems, ensureWritable, runGroup, toResult, writeRoot } from './group';
import { quoted } from './labels';
import { unchanged } from './skips';
import { itemIdsInFolders } from './sql';
import type { Session } from './types';

type Kind = 'folder' | 'smartFolder';
type Rec = EagleFolderRecord | EagleSmartFolderRecord;
type Change = RootConflictPlan['changes'][number];

interface Node {
  rec: Rec;
  parentId: string | null;
  index: number;
}

/** The fields that make a folder what it is (not its children, and not Eagle's runtime keys). */
const FIELDS: Record<Kind, string[]> = {
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

function flatten(list: unknown, into = new Map<string, Node>(), parentId: string | null = null) {
  if (!Array.isArray(list)) return into;
  list.forEach((rec: Rec, index) => {
    if (!rec || typeof rec.id !== 'string' || into.has(rec.id)) return;
    into.set(rec.id, { rec, parentId, index });
    flatten(rec.children, into, rec.id);
  });
  return into;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** "Sam Lee's copy" from Dropbox's file name, else "the conflicted copy". */
function whoseCopy(relPath: string): string {
  const who = /\(([^()]+?)'s conflicted copy/i.exec(relPath)?.[1]?.trim();
  return who ? `${who}'s copy` : 'the conflicted copy';
}

/** Only a conflicted copy of the root file, directly in the library folder. */
function checkPath(relPath: string): void {
  if (!relPath || /[\\/]/.test(relPath) || conflictedCopyBase(relPath) !== 'metadata.json')
    throw new Error("That isn't a conflicted copy of the library's folder list.");
}

async function readCopy(s: Session, relPath: string): Promise<EagleRootRecord> {
  checkPath(relPath);
  let text: string;
  try {
    text = await readFile(join(s.lib.root, relPath), 'utf8');
  } catch {
    throw new Error('That conflicted copy is gone (maybe it was already removed).');
  }
  try {
    const v = JSON.parse(text) as EagleRootRecord;
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v;
  } catch {
    throw new Error("That conflicted copy can't be read (it may be damaged or still syncing).");
  }
}

/** The differences, by id. A folder only on one side is listed once, for its topmost folder. */
function diff(live: EagleRootRecord, copy: EagleRootRecord, relPath: string): Change[] {
  const whose = whoseCopy(relPath);
  const changes: Change[] = [];
  for (const kind of ['folder', 'smartFolder'] as const) {
    const key = kind === 'folder' ? 'folders' : 'smartFolders';
    const a = flatten(live[key]);
    const b = flatten(copy[key]);
    const noun = kind === 'folder' ? 'Folder' : 'Smart folder';
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
        });
        continue;
      }
      const parts: string[] = [];
      let change: Change['change'] | null = null;
      if (mine.parentId !== node.parentId) {
        change = 'moved';
        parts.push(
          node.parentId ? `inside ${quoted(nameIn(b, node.parentId))}` : 'at the top level',
        );
      }
      const differs = FIELDS[kind].filter((f) => !same(mine.rec[f], node.rec[f]));
      if (differs.includes('name')) {
        change ??= 'renamed';
        parts.push(`called ${quoted(node.rec.name)}`);
      }
      if (differs.includes('iconColor')) {
        change ??= 'recolored';
        parts.push(
          node.rec.iconColor ? `colored ${String(node.rec.iconColor)}` : 'without a color',
        );
      }
      const other = differs.filter((f) => f !== 'name' && f !== 'iconColor');
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
      });
    }
  }
  return changes;
}

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

export async function planRootConflict(s: Session, relPath: string): Promise<RootConflictPlan> {
  const copy = await readCopy(s, relPath);
  const live = (await s.lib.readRoot()).value;
  return { relPath, changes: diff(live, copy, relPath) };
}

// ───────────────────────── applying ─────────────────────────

/** A deep copy of `rec` without the subtrees whose ids the live tree already has. */
function cloneWithout(rec: Rec, taken: Set<string>): Rec {
  const copy = structuredClone(rec) as Rec;
  const prune = (r: { children?: Rec[] }) => {
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
  const walk = (r: Rec) => {
    for (const child of (r.children ?? []) as Rec[])
      if (inCopy.has(child.id)) kept.push(child.id);
      else walk(child);
  };
  walk(at.node);
  const parentId = at.parent?.id ?? null;
  kept.forEach((sub, i) => move(root, sub, parentId, at.index + 1 + i));
  return (kind === 'folder' ? removeFolder : removeSmartFolder)(root, id).length > 0;
}

function applyChange(root: EagleRootRecord, copy: EagleRootRecord, c: Change): boolean {
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
      ? ((locate(root, parentId)!.node.children ??= []) as Rec[])
      : ((root[key] ??= []) as Rec[]);
    list.splice(Math.min(theirs.index, list.length), 0, rec);
    return true;
  }

  const mine = locate(root, c.id)?.node as Rec | undefined;
  if (!mine) return false;
  let changed = false;
  for (const f of FIELDS[c.kind]) {
    if (same(mine[f], theirs.rec[f])) continue;
    if (theirs.rec[f] === undefined) delete mine[f];
    else mine[f] = structuredClone(theirs.rec[f]);
    changed = true;
  }
  if ((liveNodes.get(c.id)?.parentId ?? null) !== parentId) {
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
 * Apply the picked differences (by id) so those folders look like they do in the conflicted
 * copy. Worked out again against the files as they are now; a folder that goes away comes off
 * its items first, like a normal folder delete (the items themselves stay).
 */
export async function applyRootConflict(
  s: Session,
  actor: Actor,
  relPath: string,
  pickedIds: string[],
): Promise<MutationResult> {
  ensureWritable(s);
  const whose = whoseCopy(relPath);
  const picked = new Set(pickedIds);
  const { entry, t } = await runGroup(
    s,
    actor,
    `Merged changes from ${whose}`,
    'folders',
    async (ctx, t) => {
      const copy = await readCopy(s, relPath);
      const live = (await s.lib.readRoot()).value;
      const changes = diff(live, copy, relPath).filter((c) => picked.has(c.id));
      for (const id of picked)
        if (!changes.some((c) => c.id === id))
          t.skipped.push(unchanged(id, 'Nothing to merge for this one any more.'));
      if (!changes.length) return;

      // Folders that go away come off their items first, so no item points at a missing folder.
      // Subfolders the copy still has stay (removeKeepingCopy), and so do their items.
      const inCopy = flatten(copy.folders);
      const gone = changes
        .filter((c) => c.kind === 'folder' && c.change === 'deletedInCopy')
        .flatMap((c) => s.env.deps.helpers.tree.descendantIds(live, c.id))
        .filter((id) => !inCopy.has(id));
      if (gone.length) {
        const goneSet = new Set(gone);
        await editItems(s, ctx, t, itemIdsInFolders(s.index, gone), (rec) => {
          if (!(rec.folders ?? []).some((f) => goneSet.has(f))) return false;
          s.env.deps.helpers.edits.removeFolders(rec, gone);
        });
      }
      // Additions first (a moved folder may go inside a new one), removals last.
      const order: Change['change'][] = [
        'onlyInCopy',
        'renamed',
        'recolored',
        'other',
        'moved',
        'deletedInCopy',
      ];
      changes.sort((a, b) => order.indexOf(a.change) - order.indexOf(b.change));
      let merged = 0;
      await writeRoot(s, ctx, t, (root) => {
        for (const c of changes) if (applyChange(root, copy, c)) merged++;
        return merged > 0;
      });
      t.count = merged;
      t.label = `Merged ${merged === 1 ? 'a change' : `${merged} changes`} from ${whose}`;
    },
  );
  return toResult(entry, t);
}
