// Dropbox conflicted copies get merged, not just listed (docs/specs/merge.md).
//
// When the watcher or the verify pass finds a copy in a library that may be edited, and both the
// copy and its live file have settled (Dropbox says "up to date", or can't say):
//   - thumbnail and mtime copies, and copies that hold nothing the library doesn't, are moved
//     into Boogie's store, tidied in one History group per pass;
//   - an item, the root metadata.json or tags.json is merged field by field against the versions
//     the journal knows (src/core/merge): what is certain is taken from the copy, as one History
//     group per copy that Undo reverses; what isn't stays as the library has it and becomes a
//     question (ConflictFile.questions), until `resolveConflict` settles the copy.
// Questions are worked out again on every pass, from the files, never stored.
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type {
  Actor,
  ConflictFile,
  ConflictQuestion,
  EagleRootRecord,
  MutationResult,
} from '../../shared/types';
import type { ChangeContext } from '../contracts';
import { conflictedCopyBase } from '../eagle';
import {
  basesUntil,
  certain,
  diffRoot,
  foldersLeaving,
  mergeItem,
  mergeRoot,
  mergeTags,
  pickBases,
  questionsOf,
  summarize,
  type Diff,
  type Rec,
} from '../merge';
import { assertWritable } from '../safety/writeGuard';
import {
  applyWrites,
  BOOGIE,
  editItems,
  ensureWritable,
  isItemId,
  runGroup,
  sharedWarning,
  toResult,
  writeRoot,
} from './group';
import { quoted } from './labels';
import { skip, unchanged } from './skips';
import { itemIdsInFolders } from './sql';
import { writeTagsFile } from './tagsFile';
import type { Session, Touch } from './types';
import { plural } from './util';

// ───────────────────────── what a pass remembers ─────────────────────────

/** A difference as the glue sees it: what can be read off it, never applied here. */
type Row = Diff<never>;

interface State {
  /** Questions per copy path, as of the last pass (the status carries them on the ConflictFile). */
  questions: Map<string, { list: ConflictQuestion[]; sig: string }>;
  /**
   * Copies Boogie already merged by itself (or tried to, and part of it couldn't be done) and that
   * stay for their questions. They are never taken from automatically again: after an Undo of
   * that merge the same differences come back as questions instead of being merged once more the
   * next time something looks at the library. Kept in a small file in the store, so a restart
   * doesn't forget (null: not read yet). Keyed by path: a new copy that Dropbox gives the same
   * name is only ever asked about, which is the safe side.
   */
  merged: Set<string> | null;
  running: Promise<void> | null;
  again: boolean;
  timer: NodeJS.Timeout | null;
  retries: number;
}

const states = new WeakMap<Session, State>();

function stateOf(s: Session): State {
  let st = states.get(s);
  if (!st)
    states.set(
      s,
      (st = {
        questions: new Map(),
        merged: null,
        running: null,
        again: false,
        timer: null,
        retries: 0,
      }),
    );
  return st;
}

/** The ConflictFiles for the status: the library's copies, each with its questions when it has some. */
export function conflictFiles(s: Session): ConflictFile[] {
  const all = [...s.conflicts, ...[...s.itemConflicts.values()].flat()];
  const q = states.get(s)?.questions;
  if (!q?.size) return all;
  return all.map((c) => {
    const found = q.get(c.path);
    return found ? { ...c, questions: found.list } : c;
  });
}

/** The copy is gone from the library (moved out, or removed by someone): forget what we knew of it. */
function forget(s: Session, st: State, path: string): void {
  st.questions.delete(path);
  if (st.merged?.delete(path)) void saveMerged(s, st);
  s.conflicts = s.conflicts.filter((c) => c.path !== path);
  for (const [id, list] of s.itemConflicts) {
    const rest = list.filter((c) => c.path !== path);
    if (rest.length === list.length) continue;
    if (rest.length) s.itemConflicts.set(id, rest);
    else s.itemConflicts.delete(id);
  }
}

const mergedFile = (s: Session) => join(s.journal.storeDirFor(s.ref.id), 'merged-copies.json');

/** The copies already merged (see State.merged). A missing or damaged file is just an empty list. */
async function mergedCopies(s: Session, st: State): Promise<Set<string>> {
  if (st.merged) return st.merged;
  let list: unknown = [];
  try {
    list = JSON.parse(await readFile(mergedFile(s), 'utf8'));
  } catch {
    /* none yet */
  }
  return (st.merged ??= new Set(
    Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [],
  ));
}

async function saveMerged(s: Session, st: State): Promise<void> {
  try {
    await writeFile(mergedFile(s), JSON.stringify([...(st.merged ?? [])]));
  } catch (e) {
    console.error("[boogie] couldn't remember which conflicted copies were merged", e);
  }
}

// ───────────────────────── paths ─────────────────────────

type CopyKind = 'item' | 'root' | 'tags' | 'mtime' | 'thumbnail';

interface CopyPath {
  kind: CopyKind;
  itemId: string | null;
  /** The file the copy is a copy of, relative to the library. */
  liveRel: string;
}

const NOT_A_COPY = "That isn't a conflicted copy Boogie can settle.";

/**
 * A conflicted copy at the library root or inside one item folder, nothing else: no escapes
 * (`..`, absolute paths, backslashes), no other folders. Throws a plain-English error.
 */
export function parseCopyPath(relPath: string): CopyPath {
  if (!relPath || relPath.includes('\\') || relPath.includes('\0')) throw new Error(NOT_A_COPY);
  const parts = relPath.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(NOT_A_COPY);
  if (parts.length === 1) {
    const base = conflictedCopyBase(parts[0]!);
    const kind =
      base === 'metadata.json'
        ? 'root'
        : base === 'tags.json'
          ? 'tags'
          : base === 'mtime.json'
            ? 'mtime'
            : null;
    if (!base || !kind) throw new Error(NOT_A_COPY);
    return { kind, itemId: null, liveRel: base };
  }
  const id =
    parts.length === 3 && parts[0] === 'images' ? /^(.+)\.info$/.exec(parts[1]!)?.[1] : null;
  if (!id || !isItemId(id)) throw new Error(NOT_A_COPY);
  const base = conflictedCopyBase(parts[2]!);
  if (base === 'metadata.json')
    return { kind: 'item', itemId: id, liveRel: `images/${id}.info/metadata.json` };
  if (base?.endsWith('_thumbnail.png'))
    return { kind: 'thumbnail', itemId: id, liveRel: `images/${id}.info/${base}` };
  throw new Error(NOT_A_COPY);
}

/** "Sam's conflicted copy", from Dropbox's file name; "the conflicted copy" when it names nobody. */
function whoseCopy(relPath: string): string {
  const who = /\(([^()]+?)'s conflicted copy/i.exec(relPath)?.[1]?.trim();
  return who ? `${who}'s conflicted copy` : 'the conflicted copy';
}

// ───────────────────────── moving a copy into the store ─────────────────────────

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Move a copy out of the library into `<store>/conflicts/<group id>/<relPath>` and note it in the
 * group. The removal inside the library goes through the write guard like every other write there.
 * It is not recorded as a moved-out item folder (that list is for items "deleted for good", and
 * Undo would try to put the folder back): the group just says where the file went. Never deletes:
 * across filesystems it is copied, checked, and only then removed.
 */
async function moveToStore(
  s: Session,
  ctx: ChangeContext,
  relPath: string,
  itemId: string | null,
): Promise<void> {
  const src = join(s.lib.root, relPath);
  const dest = join(
    s.journal.storeDirFor(s.ref.id),
    'conflicts',
    ctx.group.id,
    ...relPath.split('/'),
  );
  if (inside(resolve(dest), resolve(s.lib.root)))
    throw new Error("The journal store can't be inside a library.");
  // The library may have stopped being editable while this pass was at work (Eagle opened it here,
  // it was closed): nothing more is moved then.
  ensureWritable(s);
  assertWritable(src);
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await copyFile(src, dest, constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([stat(src), stat(dest)]);
    if (a.size !== b.size) {
      await unlink(dest).catch(() => undefined); // our own half copy, in our own store
      throw new Error("A conflicted copy couldn't be moved out safely, so it was left in place.");
    }
    assertWritable(src);
    await unlink(src);
  }
  s.journal.recordFile(ctx.group, {
    relPath,
    before: `Moved out of the library to ${dest}`,
    after: null,
    itemId,
  });
}

// ───────────────────────── reading a copy and its live file ─────────────────────────

/** One copy read against its live file: what differs, and how to write what is taken. */
interface Loaded {
  /** "“Portrait study”", "the folder list", "the starred tags": for labels. */
  subject: string;
  /** Every difference, as of the files read now. */
  diffs: Row[];
  /**
   * The normal write path for this kind of file. `pick` chooses which of the differences (worked
   * out again on a fresh read of the live file) are taken from the copy.
   */
  write(ctx: ChangeContext, t: Touch, pick: (d: Row) => boolean): Promise<Written>;
}

interface Written {
  wrote: boolean;
  /** What really was taken from the copy. */
  applied: Row[];
  /** Picked, but it couldn't be done here (a rename onto a file that exists, a folder move into itself). */
  failed: Row[];
  /** Still open: the questions nobody answered, and what failed. */
  left: Row[];
}

type Loading = Loaded | 'gone' | 'waiting';

function parseObject(text: string): Rec | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** As many versions as the journal hands over at once. A plain object so a test can change it. */
export const VERSIONS = { max: 500 };

/** The journal's versions of the live file that existed by the time of the copy. */
function basesFor(s: Session, liveRel: string, copyTime: number | null): Rec[] {
  if (copyTime === null || !s.journal.versionsOf) return [];
  const versions = s.journal.versionsOf(s.ref.id, liveRel, {
    until: basesUntil(copyTime),
    limit: VERSIONS.max,
  });
  // Every old version counts: an Eagle that saves from an old one is only caught by that one being
  // here to disagree. When the list was cut short the oldest are out of sight, so nothing is certain.
  if (versions.length >= VERSIONS.max) return [];
  return pickBases(versions, copyTime);
}

/**
 * What `write` does for every kind: recompute on the fresh file, take the picked, report the rest.
 * Only what really changed the file counts as applied; a picked difference that couldn't be taken
 * is `failed`, and stays open.
 */
async function writeDiffs<T>(
  compute: (live: T) => Diff<T>[],
  pick: (d: Row) => boolean,
  run: (go: (fresh: T) => boolean) => Promise<boolean>,
  apply: (d: Diff<T>, fresh: T) => boolean = (d, fresh) => d.apply(fresh),
): Promise<Written> {
  let last: Diff<T>[] = [];
  let picked: Diff<T>[] = [];
  let applied: Diff<T>[] = [];
  const wrote = await run((fresh) => {
    last = compute(fresh);
    picked = last.filter(pick);
    applied = picked.filter((d) => apply(d, fresh));
    return applied.length > 0;
  });
  const failed = picked.filter((d) => !applied.includes(d));
  const left = last.filter(
    (d) => failed.includes(d) || (d.verdict === 'ask' && !picked.includes(d)),
  );
  return { wrote, applied, failed, left };
}

async function load(s: Session, relPath: string, auto: boolean): Promise<Loading> {
  const where = parseCopyPath(relPath);
  const file = join(s.lib.root, relPath);
  let text: string;
  let fileTime: number;
  try {
    [text, fileTime] = await Promise.all([
      readFile(file, 'utf8'),
      stat(file).then((st) => st.mtimeMs),
    ]);
  } catch {
    return 'gone';
  }
  const copy = parseObject(text);
  if (!copy) return 'waiting'; // damaged, or Dropbox is still delivering it

  if (where.kind === 'item') {
    const id = where.itemId!;
    const doc = await s.lib.readItem(id);
    if (!doc) return 'waiting';
    // Not this item's record (an empty or foreign file under a copy's name): everything it lacks
    // would look like something to take away.
    if (copy.id !== id) return 'waiting';
    const live = doc.value as Rec;
    const bases = basesFor(s, where.liveRel, finite(copy.lastModified) ?? fileTime);
    const folderName = (fid: string) => s.env.deps.helpers.tree.findFolder(s.root, fid)?.name;
    const compute = (rec: Rec) => mergeItem(rec, copy, bases, { folderName, auto });
    return {
      subject: quoted(String(live.name ?? id)),
      diffs: compute(live),
      async write(ctx, t, pick) {
        // The name goes through the adapter's rename (the files follow), so the edit leaves it out.
        const out = await writeDiffs(
          compute,
          pick,
          async (go) => (await editItems(s, ctx, t, [id], go)) > 0,
          (d, fresh) => d.id !== 'name' && d.apply(fresh),
        );
        const nameDiff = out.failed.find((d) => d.id === 'name');
        if (nameDiff) {
          // The name stays, and stays a question, when the rename can't be done (a file with that
          // name is already in the folder) or comes to the name it has (Windows-unsafe characters).
          try {
            const w = await s.lib.renameItem(id, String(copy.name), ctx);
            if (w) {
              applyWrites(s, t, [w]);
              out.wrote = true;
              out.applied.push(nameDiff);
              out.failed = out.failed.filter((d) => d !== nameDiff);
              out.left = out.left.filter((d) => d !== nameDiff);
            }
          } catch (e) {
            t.skipped.push(skip(id, `The name couldn't be changed: ${(e as Error).message}`));
          }
        }
        return out;
      },
    };
  }

  if (where.kind === 'root') {
    if (!Array.isArray(copy.folders)) return 'waiting'; // not a folder list
    const live = (await s.lib.readRoot()).value;
    const bases = basesFor(
      s,
      where.liveRel,
      finite(copy.modificationTime) ?? fileTime,
    ) as unknown as EagleRootRecord[];
    const copyRoot = copy as unknown as EagleRootRecord;
    // Only asked for two folders with one name. (A folder only the copy has isn't counted by the
    // index: its items are looked up.)
    let counts: Record<string, { deep: number }> | undefined;
    const itemCount = (fid: string) =>
      (counts ??= s.index.counts().folders)[fid]?.deep ?? itemIdsInFolders(s.index, [fid]).length;
    const compute = (root: EagleRootRecord) =>
      mergeRoot(root, copyRoot, bases, { auto, itemCount });
    return {
      subject: 'the folder list',
      diffs: compute(live),
      async write(ctx, t, pick) {
        // Folders that go away come off their items first, so no item points at a missing folder.
        // Only a person ever picks that (a removal is never certain enough to be automatic).
        const picked = new Set(
          compute(live)
            .filter(pick)
            .map((d) => d.id),
        );
        const gone = foldersLeaving(
          live,
          copyRoot,
          diffRoot(live, copyRoot, '')
            .filter((c) => c.kind === 'folder' && c.change === 'deletedInCopy' && picked.has(c.id))
            .map((c) => c.id),
        );
        if (gone.length) {
          const goneSet = new Set(gone);
          await editItems(s, ctx, t, itemIdsInFolders(s.index, gone), (rec) => {
            if (!(rec.folders ?? []).some((f) => goneSet.has(f))) return false;
            s.env.deps.helpers.edits.removeFolders(rec, gone);
          });
        }
        return writeDiffs(compute, pick, (go) => writeRoot(s, ctx, t, go)).then((out) => {
          if (out.wrote) t.warning ??= sharedWarning(s);
          return out;
        });
      },
    };
  }

  if (where.kind === 'tags') {
    if (!s.lib.readTagsFile || !s.lib.updateTagsFile) return 'gone';
    let doc;
    try {
      doc = await s.lib.readTagsFile();
    } catch {
      return 'waiting';
    }
    // A copy without its tags.json: Dropbox moved ours aside and the other one isn't here yet.
    if (!doc) return 'waiting';
    const live = doc.value as unknown as Rec;
    const bases = basesFor(s, where.liveRel, fileTime);
    const compute = (file: Rec) => mergeTags(file, copy, bases, { auto });
    return {
      subject: 'the starred tags',
      diffs: compute(live),
      write: (ctx, t, pick) =>
        writeDiffs(compute, pick, (go) =>
          writeTagsFile(s, ctx, t, (file) => go(file as unknown as Rec)),
        ),
    };
  }

  return 'gone';
}

// ───────────────────────── the automatic pass ─────────────────────────

const RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

/** May Boogie touch the library's files for this right now? */
function ready(s: Session): boolean {
  // Never during the first scan (a copy is judged against an index that isn't finished).
  return !s.closed && !s.readOnly && !s.syncPromise && !s.indexing;
}

const toQuestion = (d: Row): ConflictQuestion => ({
  id: d.id,
  label: d.label,
  live: d.live,
  copy: d.copy,
});

function setQuestions(st: State, path: string, asks: Row[]): boolean {
  const list = [...new Map(asks.map((d) => [d.id, toQuestion(d)])).values()];
  const sig = JSON.stringify(list);
  if (st.questions.get(path)?.sig === sig) return false;
  st.questions.set(path, { list, sig });
  return true;
}

/**
 * Look at the library's conflicted copies and deal with the ones that can be dealt with. Safe to
 * call from anywhere, any number of times: calls that overlap are folded into one more pass.
 */
export function runConflictPass(s: Session, opts: { retry?: boolean } = {}): Promise<void> {
  const st = stateOf(s);
  if (!opts.retry) {
    // A fresh look starts the retry backoff over.
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.retries = 0;
  }
  if (st.running) {
    st.again = true;
    return st.running;
  }
  const run: Promise<void> = (async () => {
    try {
      do {
        st.again = false;
        if (await pass(s, st)) scheduleRetry(s, st);
      } while (st.again && !s.closed);
    } catch (e) {
      if (!s.closed) console.error('[boogie] looking at conflicted copies failed', e);
    }
  })().finally(() => {
    if (st.running === run) st.running = null;
  });
  st.running = run;
  return run;
}

/** A copy that wasn't ready (still syncing, unreadable): look again soon, a few times. */
function scheduleRetry(s: Session, st: State): void {
  if (st.timer || st.retries >= RETRY_MS.length || s.closed) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    if (!s.closed) void runConflictPass(s, { retry: true });
  }, RETRY_MS[st.retries++]);
  st.timer.unref();
}

function listCopies(s: Session): ConflictFile[] {
  return [...s.conflicts, ...[...s.itemConflicts.values()].flat()].filter(
    (c) => c.kind !== 'other',
  );
}

/** The files Dropbox must be done with before a copy is judged: the copy, and what it is a copy of. */
function filesToSettle(c: ConflictFile): string[] {
  try {
    const where = parseCopyPath(c.path);
    return where.kind === 'mtime' ? [c.path] : [c.path, where.liveRel];
  } catch {
    return [];
  }
}

/**
 * Which copies are settled: Dropbox says nothing it needs is still syncing, or can't say (no
 * client, a timeout, odd output, a folder it doesn't sync: never a reason to wait).
 */
async function settle(
  s: Session,
  copies: ConflictFile[],
): Promise<{ settled: ConflictFile[]; waiting: boolean }> {
  const dropbox = s.env.deps.dropbox;
  if (!dropbox.fileStatus) return { settled: copies, waiting: false };
  const files = new Map(copies.map((c) => [c, filesToSettle(c).map((p) => join(s.lib.root, p))]));
  const status = await dropbox
    .fileStatus([...new Set([...files.values()].flat())])
    .catch(() => ({}) as Record<string, string>);
  const settled = copies.filter((c) => files.get(c)!.every((p) => status[p] !== 'syncing'));
  return { settled, waiting: settled.length < copies.length };
}

/** A thumbnail copy is redundant when the item's own thumbnail is there and isn't empty. */
async function hasLiveThumbnail(s: Session, c: ConflictFile): Promise<boolean> {
  const where = parseCopyPath(c.path);
  const candidates = [join(s.lib.root, where.liveRel)];
  const rec = (await s.lib.readItem(where.itemId!))?.value;
  const located = rec ? await s.lib.locateThumbnail(where.itemId!, rec) : null;
  if (located) candidates.unshift(located);
  for (const f of candidates) {
    try {
      const st = await stat(f);
      if (st.isFile() && st.size > 0) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

const takeCopy = (d: Row) => d.verdict === 'copy';

/** The copies still in the library that are in `tidy`; each goes to the store in one group. */
async function tidyCopies(s: Session, st: State, tidy: ConflictFile[]): Promise<boolean> {
  if (!tidy.length) return false;
  let moved = 0;
  const { entry } = await runGroup(
    s,
    BOOGIE,
    `Tidied ${plural(tidy.length, 'conflicted copy', 'conflicted copies')} (nothing new in them)`,
    'other',
    async (ctx, t) => {
      for (const c of tidy) {
        if (s.closed || s.readOnly) break;
        try {
          await moveToStore(s, ctx, c.path, c.itemId);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            forget(s, st, c.path); // already gone
          else console.error(`[boogie] couldn't tidy a conflicted copy (${c.path})`, e);
          continue;
        }
        forget(s, st, c.path);
        moved++;
        if (moved % 50 === 0) await t.pause();
      }
      t.label = `Tidied ${plural(moved, 'conflicted copy', 'conflicted copies')} (nothing new in them)`;
    },
    { lock: false },
  );
  return !!entry || moved > 0;
}

/** One copy: tidy it, merge what is certain, or leave it with its questions. `retry`: not ready yet, look again later. */
async function handle(
  s: Session,
  st: State,
  c: ConflictFile,
  tidy: ConflictFile[],
): Promise<{ retry: boolean; changed: boolean }> {
  if (c.kind === 'mtime') {
    tidy.push(c); // Eagle deletes these itself on its next load
    return { retry: false, changed: false };
  }
  if (c.kind === 'thumbnail') {
    if (await hasLiveThumbnail(s, c)) tidy.push(c);
    return { retry: false, changed: false };
  }

  const merged = await mergedCopies(s, st);
  const loaded = await load(s, c.path, !merged.has(c.path));
  if (loaded === 'gone') {
    forget(s, st, c.path);
    return { retry: false, changed: true };
  }
  if (loaded === 'waiting') return { retry: true, changed: false };

  const asks = questionsOf(loaded.diffs);
  if (!certain(loaded.diffs).length) {
    if (asks.length) return { retry: false, changed: setQuestions(st, c.path, asks) };
    tidy.push(c); // nothing here the library doesn't already have (or has better)
    return { retry: false, changed: false };
  }

  // Something is certain: merge it, one group for this copy.
  const whose = whoseCopy(c.path);
  let written: Written | null = null;
  let moved = false;
  await runGroup(
    s,
    BOOGIE,
    `Merged ${whose} of ${loaded.subject}`,
    'merge',
    async (ctx, t) => {
      written = await loaded.write(ctx, t, takeCopy);
      if (!written.wrote) return;
      if (!written.left.length) {
        await moveToStore(s, ctx, c.path, c.itemId);
        moved = true;
      }
      t.label =
        `Merged ${whose} of ${loaded.subject}: ${summarize(written.applied)}` +
        (written.left.length ? `; ${plural(written.left.length, 'question')} left` : '');
    },
    { lock: false },
  );
  const w = written as Written | null;
  if (moved) {
    forget(s, st, c.path);
    return { retry: false, changed: true };
  }
  // The file changed under us and nothing differs any more: look again (it will be tidied).
  if (!w || (!w.wrote && !w.left.length)) return { retry: true, changed: false };
  // Never taken from by itself again: after an Undo, and for what couldn't be done here (a rename
  // onto a file that exists, a folder move into itself), the differences are questions.
  if (w.wrote || w.failed.length) {
    merged.add(c.path);
    await saveMerged(s, st);
  }
  const asked = setQuestions(st, c.path, w.left);
  return { retry: false, changed: w.wrote || asked };
}

/** One look at the library's copies. Returns true when some were not ready and are worth another look. */
async function pass(s: Session, st: State): Promise<boolean> {
  // An index sync is running (the first scan, say): look again soon. A closed or read-only library
  // has nothing to do (becoming editable starts a pass).
  if (!ready(s)) return !s.closed && !s.readOnly;
  const copies = listCopies(s);
  if (!copies.length) return false;

  const { settled, waiting } = await settle(s, copies);
  let retry = waiting;
  let changed = false;
  await s.lock.run(async (step) => {
    const tidy: ConflictFile[] = [];
    for (const c of settled) {
      if (!ready(s)) {
        retry ||= !s.closed && !s.readOnly;
        return;
      }
      try {
        const r = await handle(s, st, c, tidy);
        retry ||= r.retry;
        changed ||= r.changed;
      } catch (e) {
        // A write that failed (disk, guard) is logged; the copy is looked at again later.
        if (!s.closed && !s.readOnly)
          console.error(`[boogie] couldn't merge a conflicted copy (${c.path})`, e);
        retry = true;
      }
      await step();
    }
    if (ready(s)) {
      try {
        changed = (await tidyCopies(s, st, tidy)) || changed;
      } catch (e) {
        if (!s.closed && !s.readOnly) console.error("[boogie] couldn't tidy conflicted copies", e);
        retry = true;
      }
    }
  });
  if (changed) s.env.statusChanged();
  return retry;
}

// ───────────────────────── settling a copy by hand ─────────────────────────

/**
 * The user's answers to a copy's questions: take the copy's value for `takeCopy` (question ids),
 * keep the library's for the rest, and move the copy out of the library. Everything is worked out
 * again from the files as they are now, so an id that has gone stale is skipped.
 */
export async function resolveConflict(
  s: Session,
  actor: Actor,
  relPath: string,
  takeIds: string[],
): Promise<MutationResult> {
  ensureWritable(s);
  const where = parseCopyPath(relPath);
  if (where.kind !== 'item' && where.kind !== 'root' && where.kind !== 'tags')
    throw new Error('There is nothing to settle in that file.');
  const picked = new Set(takeIds);
  const whose = whoseCopy(relPath);
  const st = stateOf(s);
  const { entry, t } = await runGroup(s, actor, `Settled ${whose}`, 'merge', async (ctx, t) => {
    // Nothing is certain by itself here: whatever differs is a question (auto: false).
    const loaded = await load(s, relPath, false);
    if (loaded === 'gone')
      throw new Error('That conflicted copy is gone (maybe it was already removed).');
    if (loaded === 'waiting')
      throw new Error("That conflicted copy can't be read (it may be damaged or still syncing).");
    const asks = new Set(questionsOf(loaded.diffs).map((d) => d.id));
    for (const id of picked)
      if (!asks.has(id)) t.skipped.push(unchanged(id, 'Nothing to settle for this one any more.'));
    const skips = t.skipped.length;
    const w = await loaded.write(ctx, t, (d) => d.verdict === 'ask' && picked.has(d.id));
    // What couldn't be taken stays as the library has it, and the person is told (once).
    if (w.failed.length && t.skipped.length === skips)
      t.skipped.push(
        skip(w.failed[0]!.id, `${w.failed[0]!.label} couldn't be taken from the copy.`),
      );
    await moveToStore(s, ctx, relPath, where.itemId);
    t.count = w.applied.length;
    t.label = `Settled ${whose} of ${loaded.subject}: ${summarize(w.applied) || 'kept everything as it is'}`;
  });
  forget(s, st, relPath);
  s.env.statusChanged();
  return toResult(entry, t);
}
