// The rules behind the duplicate finder's results list: who can be kept, what a merge would do,
// and the totals. Pure functions so the tricky parts can be tested without a screen.
import { fileSize, plural } from '../../lib/format';
import type { DuplicateGroup, DuplicateMember } from '../../../shared/types';

/** Only items in the open library can be merged; other libraries are read-only. */
export const inLibrary = (m: DuplicateMember, libraryId: string) => m.libraryId === libraryId;

/** Groups you can do something about: at least one copy lives in the open library. */
export function actionableGroups(groups: DuplicateGroup[], libraryId: string): DuplicateGroup[] {
  return groups.filter((g) => g.members.some((m) => inLibrary(m, libraryId)));
}

/** Keep only groups that involve one of `ids` (for "find duplicates of this"). */
export function groupsWith(
  groups: DuplicateGroup[],
  ids: string[],
  libraryId: string,
): DuplicateGroup[] {
  const want = new Set(ids);
  return groups.filter((g) => g.members.some((m) => inLibrary(m, libraryId) && want.has(m.id)));
}

/** The chosen keeper, else the suggestion, else the first member that can be kept. */
export function keeperOf(
  group: DuplicateGroup,
  chosen: string | undefined,
  libraryId: string,
): string {
  const ok = (id: string | undefined) =>
    !!id && group.members.some((m) => m.id === id && inLibrary(m, libraryId));
  if (ok(chosen)) return chosen!;
  if (ok(group.suggestedKeeperId)) return group.suggestedKeeperId;
  return group.members.find((m) => inLibrary(m, libraryId))?.id ?? group.suggestedKeeperId;
}

/** Members a merge would move to the trash: same library, not the keeper. */
export function removable(
  group: DuplicateGroup,
  keeperId: string,
  libraryId: string,
): DuplicateMember[] {
  return group.members.filter((m) => m.id !== keeperId && inLibrary(m, libraryId));
}

export interface MergePreview {
  folders: number; // folders the kept item ends up in
  tags: number; // tags it ends up with
  trashed: number; // copies moved to the trash
  left: number; // copies in other libraries, left alone
}

/** Same defaults the core uses: tags and folders are unioned. */
export function mergePreview(
  group: DuplicateGroup,
  keeperId: string,
  libraryId: string,
): MergePreview {
  const keeper = group.members.find((m) => m.id === keeperId);
  const gone = removable(group, keeperId, libraryId);
  const folders = new Set(keeper?.folders ?? []);
  const tags = new Set(keeper?.tags ?? []);
  for (const m of gone) {
    m.folders.forEach((f) => folders.add(f));
    m.tags.forEach((t) => tags.add(t));
  }
  return {
    folders: folders.size,
    tags: tags.size,
    trashed: gone.length,
    left: group.members.filter((m) => !inLibrary(m, libraryId)).length,
  };
}

/** "Keeps one item in 3 folders with 5 tags; moves 2 copies to the trash." */
export function mergeSentence(p: MergePreview): string {
  const keeps = ['Keeps one item'];
  if (p.folders) keeps.push(`in ${plural(p.folders, 'folder')}`);
  if (p.tags) keeps.push(`with ${plural(p.tags, 'tag')}`);
  const parts = [keeps.join(' ')];
  if (p.trashed) parts.push(`moves ${plural(p.trashed, 'copy', 'copies')} to the trash`);
  let text = parts.join('; ') + '.';
  if (p.left)
    text += ` ${plural(p.left, 'copy', 'copies')} in other libraries ${p.left === 1 ? 'is' : 'are'} left alone.`;
  return text;
}

export interface Totals {
  groups: number;
  extraCopies: number; // what merging would trash
  bytes: number; // what that frees
}

export function totals(
  groups: DuplicateGroup[],
  keeperFor: (g: DuplicateGroup) => string,
  libraryId: string,
): Totals {
  let extraCopies = 0;
  let bytes = 0;
  for (const g of groups) {
    for (const m of removable(g, keeperFor(g), libraryId)) {
      extraCopies++;
      bytes += m.size;
    }
  }
  return { groups: groups.length, extraCopies, bytes };
}

/** "38 groups, 91 extra copies, 1.2 GB" */
export function summaryLine(t: Totals): string {
  return `${plural(t.groups, 'group')}, ${plural(t.extraCopies, 'extra copy', 'extra copies')}, ${fileSize(t.bytes)}`;
}

/**
 * The strictness slider's range: the core compares 64-bit picture hashes and can only guarantee
 * finding matches up to a distance of 7 (MAX_THRESHOLD in src/core/dupes/cluster.ts), so the slider
 * stops there. Its default is 6, like the core's.
 */
export const STRICTNESS = { min: 1, max: 7, initial: 6 };

/** Threshold names for the strictness slider (a smaller distance means a closer match). */
export function strictnessLabel(threshold: number): string {
  if (threshold <= 2) return 'Very strict: nearly identical pictures';
  if (threshold <= 6) return 'Balanced: same picture, another size or quality';
  return 'Loose: also finds light edits (may include false matches)';
}

/** How alike two pictures are, from the hash distance (0 to 64). */
export function likeness(distance: number): string {
  if (distance <= 0) return 'Identical';
  return `${Math.max(0, Math.round((1 - distance / 64) * 100))}% alike`;
}
