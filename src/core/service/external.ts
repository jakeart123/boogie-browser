// Changes that arrive from outside (the partner's Eagle through Dropbox, a Boogie on another
// computer, or anything else that edits the library): reflect them in the index, log them in
// History, and tell the UI. In a shared library, outside writes over changes of ours the partner's
// Eagle may not have shown are judged by service/partner and logged as "may have written an old
// copy" (the user then puts their change back or keeps the partner's); this file does the rest:
// plain logging, the verify pass, and the watcher's hints.
import type {
  Actor,
  ConflictFile,
  EagleItemRecord,
  EagleRootRecord,
  HistoryEntry,
} from '../../shared/types';
import type { IndexDelta } from '../contracts';
import { scanItemConflicts } from '../sync';
import { runConflictPass } from './conflicts';
import { currentCounts } from './group';
import { itemsText, quoted } from './labels';
import {
  OTHER_BOOGIE,
  afterShared,
  attribute,
  onlyStampChanged,
  recordJudged,
  sortShared,
} from './partner';
import { rootChangeParts } from './rootChanges';
import { allItemIds } from './sql';
import { buildLibraryState } from './state';
import { verifyPlan } from './storage';
import type { Session } from './types';

/** Above this many new ids the UI is better off re-querying than getting a giant id list. */
const MAX_ADDED_IDS = 5000;

function parse(text: string | null | undefined): Partial<EagleItemRecord> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Partial<EagleItemRecord>;
  } catch {
    return null;
  }
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * "Sam added 12 items to Prix de Rome versions", "Sam edited 3 items", ... A library that
 * isn't shared has nobody to name: "Changed outside Boogie: edited 3 items".
 */
export function externalLabel(s: Session, who: string | null, delta: IndexDelta): string {
  const changedText = new Map(delta.changedText.map((c) => [c.id, c]));
  let edited = 0;
  let trashed = 0;
  let restored = 0;
  for (const id of delta.changed) {
    const c = changedText.get(id);
    const before = parse(c?.before);
    const after = parse(c?.after);
    if (before && after && !before.isDeleted && after.isDeleted) trashed++;
    else if (before && after && before.isDeleted && !after.isDeleted) restored++;
    else edited++;
  }

  const parts: string[] = [];
  if (delta.added.length) {
    // Name the folder most of the new items went into, if there is one.
    const tally = new Map<string, number>();
    for (const id of delta.added) {
      const folders =
        parse(changedText.get(id)?.after)?.folders ?? s.index.getRecord(id)?.folders ?? [];
      for (const f of folders) tally.set(f, (tally.get(f) ?? 0) + 1);
    }
    const [top] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const name =
      top && top[1] * 2 >= delta.added.length
        ? s.env.deps.helpers.tree.findFolder(s.root, top[0])?.name
        : undefined;
    parts.push(`added ${itemsText(delta.added.length)}${name ? ` to ${quoted(name)}` : ''}`);
  }
  if (edited) parts.push(`edited ${itemsText(edited)}`);
  if (trashed) parts.push(`moved ${itemsText(trashed)} to trash`);
  if (restored) parts.push(`restored ${itemsText(restored)} from trash`);
  if (delta.removed.length) parts.push(`removed ${itemsText(delta.removed.length)}`);
  return who ? `${who} ${joinParts(parts)}` : `Changed outside Boogie: ${joinParts(parts)}`;
}

/** A shared library's outside changes come through Dropbox, from the partner (named, or not yet). */
const whoOf = (s: Session): string | null => (s.shared ? (s.partnerName ?? 'Your partner') : null);
const actorOf = (s: Session): Actor => ({ kind: 'external', name: whoOf(s) ?? 'Outside Boogie' });
const relPath = (id: string) => `images/${id}.info/metadata.json`;

function recordInHistory(
  s: Session,
  delta: IndexDelta,
  actor: Actor,
  who: string | null,
): HistoryEntry | null {
  if (!delta.added.length && !delta.changed.length && !delta.removed.length) return null;
  const seen = new Set<string>();
  const changes: {
    itemId: string;
    relPath: string;
    before: string | null;
    after: string | null;
  }[] = [];
  for (const c of delta.changedText) {
    seen.add(c.id);
    changes.push({ itemId: c.id, relPath: relPath(c.id), before: c.before, after: c.after });
  }
  // The index may only report text for edits; new items are rebuilt from what it now holds.
  for (const id of [...delta.added, ...delta.changed]) {
    if (seen.has(id)) continue;
    const rec = s.index.getRecord(id);
    if (rec)
      changes.push({ itemId: id, relPath: relPath(id), before: null, after: JSON.stringify(rec) });
  }
  return s.journal.recordExternal(s.ref.id, actor, changes, externalLabel(s, who, delta));
}

/** The part of `delta` about `ids` (keep = true) or about the rest (keep = false). */
function pick(delta: IndexDelta, ids: ReadonlySet<string>, keep: boolean): IndexDelta {
  const on = (id: string) => ids.has(id) === keep;
  return {
    ...delta,
    added: delta.added.filter(on),
    changed: delta.changed.filter(on),
    removed: keep ? [] : delta.removed,
    changedText: delta.changedText.filter((c) => on(c.id)),
  };
}

// ───────────────────────── root metadata.json ─────────────────────────

/** Folders, smart folders, tag groups and quick access changed outside: one History entry. */
function recordRoot(
  s: Session,
  before: EagleRootRecord | null,
  after: EagleRootRecord,
  actor: Actor,
  who: string | null,
): HistoryEntry | null {
  const parts = rootChangeParts(before, after);
  if (!before || !parts.length) return null; // nothing a person would call a change
  const label = who ? `${who} ${joinParts(parts)}` : `Changed outside Boogie: ${joinParts(parts)}`;
  return s.journal.recordExternal(
    s.ref.id,
    actor,
    [
      {
        itemId: null,
        relPath: 'metadata.json',
        before: JSON.stringify(before),
        after: JSON.stringify(after),
      },
    ],
    label,
  );
}

/**
 * Log an outside delta: writes over changes of ours judged apart (shared libraries), another
 * Boogie's writes apart from the partner's, and changes that only moved lastModified not at all
 * (a touch changes nothing a person could see or undo; review should-fix 3).
 */
function logOutside(
  s: Session,
  delta: IndexDelta,
  rootBefore: EagleRootRecord | null,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const sort = s.shared ? sortShared(s, delta) : null;
  const skip = new Set(
    delta.changedText
      .filter((c) => onlyStampChanged(parse(c.before), parse(c.after)))
      .map((c) => c.id),
  );
  const judged = sort
    ? recordJudged(s, delta, sort, (w) => (w === 'boogie' ? OTHER_BOOGIE : actorOf(s)))
    : [];
  for (const id of sort?.judged.keys() ?? []) skip.add(id);

  const rest = pick(delta, skip, false);
  const { byBoogie, rootByBoogie } = attribute(
    s,
    delta,
    [...rest.added, ...rest.changed],
    delta.rootChanged ? { before: rootBefore, after: s.root } : null,
  );
  if (delta.rootChanged) {
    const e = rootByBoogie
      ? recordRoot(s, rootBefore, s.root, OTHER_BOOGIE, OTHER_BOOGIE.name)
      : recordRoot(s, rootBefore, s.root, actorOf(s), whoOf(s));
    if (e) entries.push(e);
  }
  for (const e of [
    recordInHistory(s, pick(rest, byBoogie, false), actorOf(s), whoOf(s)),
    recordInHistory(s, pick(rest, byBoogie, true), OTHER_BOOGIE, OTHER_BOOGIE.name),
  ])
    if (e) entries.push(e);
  entries.push(...judged);
  if (sort)
    afterShared(s, sort, {
      byPartner:
        delta.rootChanged && !rootByBoogie ? Number(s.root.modificationTime) || null : null,
    });
  return entries;
}

/**
 * Take an index delta from outside and make it visible. `journal: false` for a first scan of a
 * fresh index (everything would look "added"). `quiet` skips per-item events (nothing cached yet).
 * `rootBefore`: the root as the index had it before this delta (default: our last copy).
 */
export async function applyDelta(
  s: Session,
  delta: IndexDelta,
  opts: { journal: boolean; quiet: boolean; rootBefore?: EagleRootRecord | null },
): Promise<void> {
  const total = delta.added.length + delta.changed.length + delta.removed.length;
  if (!total && !delta.rootChanged) return;
  const { emit } = s.env;

  const rootBefore = opts.rootBefore !== undefined ? opts.rootBefore : s.root;
  if (delta.rootChanged) {
    try {
      s.root = s.index.getRoot() ?? (await s.lib.readRoot()).value;
    } catch {
      /* mid-sync root: the next change will bring it */
    }
  }

  let entries: HistoryEntry[] = [];
  if (opts.journal) {
    try {
      entries = logOutside(s, delta, rootBefore);
    } catch (e) {
      console.error('[boogie] could not log an outside change', e);
    }
  }

  if (!opts.quiet) {
    if (delta.added.length && delta.added.length <= MAX_ADDED_IDS)
      emit('itemsAdded', { ids: delta.added, source: 'external' });
    if (delta.changed.length) emit('itemsChanged', { ids: delta.changed, source: 'external' });
    if (delta.removed.length) emit('itemsRemoved', { ids: delta.removed, source: 'external' });
  }
  if (delta.rootChanged) emit('library', buildLibraryState(s));
  if (s.env.hasListener('counts')) emit('counts', currentCounts(s));
  for (const e of entries) emit('history', e);
  if (entries.length) s.env.setLastExternal(entries[entries.length - 1]!);
  if (opts.journal) void checkItemConflicts(s, [...delta.added, ...delta.changed], delta.removed);
}

/** Dropbox conflicted copies inside these items' folders (they arrive with outside edits). */
async function checkItemConflicts(s: Session, ids: string[], gone: string[] = []): Promise<void> {
  let dirty = false;
  for (const id of gone) dirty = s.itemConflicts.delete(id) || dirty;
  if (ids.length) {
    const found = await scanItemConflicts(s.lib.root, ids, { signal: s.abort.signal }).catch(
      () => null,
    );
    if (!found || s.closed) return;
    const byId = new Map<string, ConflictFile[]>();
    for (const c of found) if (c.itemId) byId.set(c.itemId, [...(byId.get(c.itemId) ?? []), c]);
    for (const id of ids) {
      const now = byId.get(id);
      if (now) s.itemConflicts.set(id, now);
      else if (!s.itemConflicts.delete(id)) continue;
      dirty = true;
    }
  }
  if (dirty) s.env.statusChanged();
  if (dirty && !s.closed) void runConflictPass(s); // new copies next to an item that just changed
}

/**
 * The slow background pass after the first sync (and on a full refresh): re-reads item files whose
 * mtime changed without mtime.json saying so, then lists conflicted copies in every item folder.
 * Low priority (it pauses between chunks) and it stops when the library closes.
 */
export function startVerify(s: Session, opts: { pauseMs?: number } = {}): Promise<void> {
  s.verifying?.stop.abort();
  const stop = new AbortController();
  const signal = AbortSignal.any([s.abort.signal, stop.signal]);
  const previous = s.verifying?.done ?? Promise.resolve();
  const done = (async () => {
    await previous;
    if (signal.aborted) return;
    // Which passes this library needs, and how often, depends on where it lives (service/storage).
    const plan = await verifyPlan(s, opts);
    if (plan.statPass) {
      await s.index.verify?.(s.lib, {
        signal,
        pauseMs: opts.pauseMs,
        onDelta: (d) =>
          void applyVerifyDelta(s, d).catch((e: unknown) => {
            if (!s.closed) console.error('[boogie] reading an outside change failed', e);
          }),
      });
      if (signal.aborted) return;
      plan.finished();
    }
    if (!plan.conflictScan) return;
    const found = await scanItemConflicts(s.lib.root, allItemIds(s.index), {
      concurrency: 2,
      signal,
    });
    if (signal.aborted) return;
    s.itemConflicts.clear();
    for (const c of found)
      if (c.itemId) s.itemConflicts.set(c.itemId, [...(s.itemConflicts.get(c.itemId) ?? []), c]);
    s.env.statusChanged();
    // Merge or tidy what was found (the pass is the one place that checks the library may be edited).
    await runConflictPass(s);
  })()
    .catch((e: unknown) => {
      if (!signal.aborted) console.error('[boogie] checking the library failed', e);
    })
    .finally(() => {
      if (s.verifying?.stop === stop) s.verifying = null;
    });
  s.verifying = { stop, done };
  return done;
}

/**
 * What verify found is already in the index. Items we wrote ourselves in the last few seconds may
 * have been read just before our write landed: those are read again (never logged as outside
 * changes); the rest are outside changes.
 */
async function applyVerifyDelta(s: Session, d: IndexDelta): Promise<void> {
  await s.lock.run(async () => {
    if (s.closed) return;
    const recent = s.lib.recentSelfWrites();
    const ours = (id: string) => recent.has(`images/${id}.info/metadata.json`);
    const mine = [...d.added, ...d.changed].filter(ours);
    if (mine.length) {
      // What we wrote (the index had it until this pass read the file).
      const written = new Map(d.changedText.filter((c) => ours(c.id)).map((c) => [c.id, c.before]));
      const fixed = await s.index.refresh(s.lib, { ids: mine });
      await applyDelta(s, fixed, { journal: false, quiet: false });
      // Read again, it's still not what we wrote: someone saved over it (a partner's Eagle racing
      // our write), which is an outside change like any other.
      const overwritten = mine.flatMap((id) => {
        const before = written.get(id);
        const now = s.index.getRecord(id);
        const after = now ? JSON.stringify(now) : null;
        return before && after && after !== before ? [{ id, before, after }] : [];
      });
      if (overwritten.length)
        await applyDelta(
          s,
          {
            added: [],
            changed: overwritten.map((c) => c.id),
            removed: [],
            rootChanged: false,
            changedText: overwritten,
          },
          { journal: true, quiet: true },
        );
    }
    const theirs: IndexDelta = {
      ...d,
      added: d.added.filter((id) => !ours(id)),
      changed: d.changed.filter((id) => !ours(id)),
      changedText: d.changedText.filter((c) => !ours(c.id)),
    };
    await applyDelta(s, theirs, { journal: true, quiet: false });
  });
}

/** The watcher saw item folders or mtime.json entries change. */
export function handleItemsHint(
  s: Session,
  hint: { ids: string[]; listDir: boolean },
): Promise<void> {
  if (s.closed) return Promise.resolve();
  if (s.syncPromise) {
    s.needsResync = true; // the running sync will be followed by another one
    return Promise.resolve();
  }
  return s.lock.run(async () => {
    if (s.closed) return;
    const delta = await s.index.refresh(s.lib, { ids: hint.ids, listDir: hint.listDir });
    // Items the unfinished first scan hadn't reached yet aren't outside changes.
    await applyDelta(s, delta, { journal: !delta.firstScan, quiet: !!delta.firstScan });
  });
}

/** The partner's Eagle rewrote mtime.json (FINDINGS 2): our recent raises may need sending again. */
export function handleForeignMtime(
  s: Session,
  info: {
    at: number;
    raisedByUs: string[];
    values?: Record<string, number>;
    previous?: Record<string, number | null>;
    byBoogie?: boolean;
  },
): void {
  if (s.closed) return;
  void s.partner?.onForeignMtime(info).catch((e: unknown) => {
    if (!s.closed) console.error("[boogie] answering the partner's Eagle failed", e);
  });
}

/** The watcher saw the root metadata.json change. */
export function handleRootHint(s: Session): Promise<void> {
  if (s.closed) return Promise.resolve();
  if (s.syncPromise) {
    s.needsResync = true;
    return Promise.resolve();
  }
  return s.lock.run(async () => {
    if (s.closed) return;
    const rootBefore = s.index.getRoot();
    const delta = await s.index.refresh(s.lib, { root: true });
    // The index says whether it took a newer root; either way our copy should match the file.
    if (!delta.rootChanged) return;
    await applyDelta(s, delta, { journal: true, quiet: false, rootBefore });
  });
}
