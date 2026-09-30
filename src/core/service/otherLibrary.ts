// Another library than the open one, read or added to in the background ("Add to other library",
// the duplicate finder's other libraries). Syncing its index takes in whatever changed there
// while it was closed (the partner's edits, an old copy their Eagle wrote back), so the index
// would match the files and opening the library later would log nothing. Those outside changes go
// in that library's History here instead, the way opening it would have logged them.
import type { EagleRootRecord, LibraryRef } from '../../shared/types';
import type { EagleLibrary, IndexDelta, LibraryIndex, ScanProgress } from '../contracts';
import { itemsText } from './labels';
import { rootChangeParts } from './rootChanges';
import type { Session } from './types';

const OUTSIDE = { kind: 'external' as const, name: 'Outside Boogie' };
const relPath = (id: string) => `images/${id}.info/metadata.json`;

function label(parts: string[]): string {
  const text =
    parts.length <= 1
      ? parts.join('')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Changed outside Boogie: ${text}`;
}

function logItems(s: Session, ref: LibraryRef, index: LibraryIndex, delta: IndexDelta): void {
  const changes = delta.changedText.map((c) => ({
    itemId: c.id,
    relPath: relPath(c.id),
    before: c.before,
    after: c.after,
  }));
  const withText = new Set(changes.map((c) => c.itemId));
  // The index reports text for edits; new items are taken from what it now holds.
  for (const id of [...delta.added, ...delta.changed]) {
    const rec = withText.has(id) ? null : index.getRecord(id);
    if (rec)
      changes.push({ itemId: id, relPath: relPath(id), before: null, after: JSON.stringify(rec) });
  }
  const parts: string[] = [];
  if (delta.added.length) parts.push(`added ${itemsText(delta.added.length)}`);
  if (delta.changed.length) parts.push(`edited ${itemsText(delta.changed.length)}`);
  if (delta.removed.length) parts.push(`removed ${itemsText(delta.removed.length)}`);
  if (parts.length) s.journal.recordExternal(ref.id, OUTSIDE, changes, label(parts));
}

function logRoot(
  s: Session,
  ref: LibraryRef,
  before: EagleRootRecord | null,
  after: EagleRootRecord | null,
): void {
  if (!before || !after) return;
  const parts = rootChangeParts(before, after);
  if (!parts.length) return;
  s.journal.recordExternal(
    ref.id,
    OUTSIDE,
    [
      {
        itemId: null,
        relPath: 'metadata.json',
        before: JSON.stringify(before),
        after: JSON.stringify(after),
      },
    ],
    label(parts),
  );
}

/**
 * Bring another library's index up to date, logging what changed outside Boogie in its History.
 * A first scan finds everything "new": that isn't a change, so nothing is logged.
 */
export async function syncOtherIndex(
  s: Session,
  ref: LibraryRef,
  lib: EagleLibrary,
  index: LibraryIndex,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const rootBefore = index.getRoot();
  const delta = await index.sync(lib, onProgress, signal);
  if (delta.firstScan) return;
  try {
    if (delta.rootChanged) logRoot(s, ref, rootBefore, index.getRoot());
    logItems(s, ref, index, delta);
  } catch (e) {
    console.error(`[boogie] could not log outside changes in ${ref.name}`, e);
  }
}
