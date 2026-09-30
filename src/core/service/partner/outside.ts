// Outside writes in a shared library: who wrote them (the partner's Eagle, or a Boogie on another
// computer), and which of them put back a change of ours their Eagle may not have shown (judge.ts).
// Those are logged as "may have written an old copy", each resolved later by you: "Put my change
// back" (undo of the entry) or "Keep theirs" (keepTheirs below). Nothing is ever repaired by itself.
import type { Actor, EagleRootRecord, HistoryEntry } from '../../../shared/types';
import type { IndexDelta } from '../../contracts';
import { itemsText, quoted } from '../labels';
import type { Session } from '../types';
import { judgeOutsideWrite, writerOf } from './judge';

/** How a Boogie on another computer (the user's second machine) shows up in History. */
export const OTHER_BOOGIE: Actor = { kind: 'external', name: 'Boogie on another computer' };

export type Writer = 'partner' | 'boogie';

export interface SharedSort {
  /** Writes that put back a pending change of ours: id -> who wrote it and the base judged on. */
  judged: Map<string, { writer: Writer; base: string }>;
  /** Items another Boogie wrote (judge.ts isBoogieValue). */
  boogie: Set<string>;
  /** Pending ids the partner's Eagle saved: it holds some version of them now. */
  delivered: string[];
  /** Their save stamps (Eagle's Date.now()), for "their Eagle is running" and their clock. */
  stamps: number[];
}

function parse(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Who wrote this record (a Boogie elsewhere, or the partner's Eagle); `prev`: its value before. */
function writer(
  s: Session,
  id: string,
  rec: Record<string, unknown> | null,
  prev?: unknown,
): Writer {
  const lm = rec?.lastModified;
  if (s.partner) return s.partner.byOtherBoogie(lm, id, prev) ? 'boogie' : 'partner';
  return writerOf(rec, Date.now(), [prev as number]);
}

/** Sort a shared library's outside item writes (see judge.ts). */
export function sortShared(s: Session, delta: IndexDelta): SharedSort {
  const out: SharedSort = { judged: new Map(), boogie: new Set(), delivered: [], stamps: [] };
  const note = (id: string, rec: Record<string, unknown> | null, prev?: unknown): Writer => {
    const w = writer(s, id, rec, prev);
    if (w === 'boogie') out.boogie.add(id);
    else if (typeof rec?.lastModified === 'number') out.stamps.push(rec.lastModified);
    return w;
  };
  const texts = new Set(delta.changedText.map((c) => c.id));
  for (const id of delta.added)
    if (!texts.has(id)) note(id, s.index.getRecord(id) as Record<string, unknown> | null);
  for (const c of delta.changedText) {
    const theirs = parse(c.after);
    if (!theirs) continue;
    const ours = parse(c.before);
    const w = note(c.id, theirs, ours?.lastModified);
    const state = s.journal.partnerPendingState?.(s.ref.id, c.id);
    if (!state) continue;
    // A Boogie elsewhere isn't the partner's Eagle: what that Eagle holds hasn't changed.
    if (w === 'partner') out.delivered.push(c.id);
    if (!ours || state.base === null) continue;
    if (judgeOutsideWrite({ base: parse(state.base), ours, theirs }) === 'stale')
      out.judged.set(c.id, { writer: w, base: state.base });
  }
  return out;
}

const relPath = (id: string) => `images/${id}.info/metadata.json`;
const writerName = (s: Session, w: Writer) =>
  w === 'boogie'
    ? OTHER_BOOGIE.name
    : s.partnerName
      ? `${s.partnerName}'s Eagle`
      : "Your partner's Eagle";

function whatText(s: Session, ids: string[]): string {
  const one = ids.length === 1 ? s.index.getRecord(ids[0]!)?.name : undefined;
  return one !== undefined
    ? `your change to ${quoted(one)}`
    : `your changes to ${itemsText(ids.length)}`;
}

/** One History entry per writer ("may have written an old copy"), so each is one decision. */
export function recordJudged(
  s: Session,
  delta: IndexDelta,
  sort: SharedSort,
  actorFor: (w: Writer) => Actor,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const w of ['partner', 'boogie'] as const) {
    const ids = [...sort.judged].filter(([, j]) => j.writer === w);
    if (!ids.length) continue;
    const bases = Object.fromEntries(ids.map(([id, j]) => [id, j.base]));
    const changes = delta.changedText
      .filter((c) => c.id in bases)
      .map((c) => ({ itemId: c.id, relPath: relPath(c.id), before: c.before, after: c.after }));
    const label = `${writerName(s, w)} may have written an old copy over ${whatText(
      s,
      ids.map(([id]) => id),
    )}`;
    const entry = s.journal.recordExternal(s.ref.id, actorFor(w), changes, label, {
      staleBases: bases,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * "Keep theirs": the user decided the partner's version of a "may have written an old copy" entry
 * stands. Nothing on disk changes (the partner's version is what's there); the entry is marked
 * resolved in the journal, so it survives restarts and stops counting in the status notice.
 */
export function keepTheirs(s: Session, groupId: string): HistoryEntry {
  if (s.closed) throw new Error('That library was closed.');
  const entry = s.journal.getEntry(groupId);
  if (!entry || entry.libraryId !== s.ref.id)
    throw new Error('That change is not in this library.');
  if (!entry.staleOverwrite)
    throw new Error('Only a change that may have been overwritten can be kept that way.');
  if (entry.undoneBy) throw new Error('Your change was already put back.');
  const kept = s.journal.markKeptTheirs?.(groupId) ?? entry;
  s.env.emit('history', kept);
  s.env.statusChanged();
  return kept;
}

/** The partner-side effects of a sorted delta: pending cleared where their Eagle saved, activity. */
export function afterShared(
  s: Session,
  sort: SharedSort,
  root: { byPartner: number | null },
): void {
  const p = s.partner;
  if (!p) return;
  p.clearPending(sort.delivered);
  for (const at of sort.stamps) p.noteWrite(at, { sample: true });
  if (root.byPartner !== null) p.noteWrite(root.byPartner, { sample: true });
}

/**
 * Which items of an outside delta another Boogie wrote, and whether the root change was its
 * (`rootBefore`: the root as it was, whose time + 1 is what a Boogie builds on). The rest is the
 * partner's. Remembers the new root time either way.
 */
export function attribute(
  s: Session,
  delta: IndexDelta,
  ids: readonly string[],
  root: { before: EagleRootRecord | null; after: EagleRootRecord } | null,
): { byBoogie: Set<string>; rootByBoogie: boolean } {
  const before = new Map(delta.changedText.map((c) => [c.id, parse(c.before)?.lastModified]));
  const byBoogie = new Set(
    ids.filter(
      (id) =>
        writer(s, id, s.index.getRecord(id) as Record<string, unknown> | null, before.get(id)) ===
        'boogie',
    ),
  );
  let rootByBoogie = false;
  if (root) {
    const t = root.after.modificationTime;
    rootByBoogie = s.partner
      ? s.partner.byOtherBoogie(t, null, root.before?.modificationTime)
      : writerOf({ lastModified: t }, Date.now(), [root.before?.modificationTime]) === 'boogie';
    s.partner?.noteRoot(t);
  }
  return { byBoogie, rootByBoogie };
}
