// Pure merge planning: how one keeper absorbs its duplicates. The service applies the returned
// mutate function to a FRESH read of the keeper (the partner may have edited it since the scan), so
// every union is computed against `rec`, and the plan is safe to apply twice.
import type { EagleItemRecord, MergeOptions } from '../../shared/types';

/** A record's list field (tags, folders): its strings, whatever else the file holds. */
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The note as a whole plus each blank-line separated block, so a re-merge doesn't add it again. */
function noteBlocks(note: string): Set<string> {
  const blocks = new Set<string>([note.trim()]);
  for (const b of note.split(/\n\s*\n/)) blocks.add(b.trim());
  return blocks;
}

export function planMerge(
  keeper: EagleItemRecord,
  others: EagleItemRecord[],
  opts: MergeOptions,
  folderAutoTags: (folderId: string) => string[],
): { keeper: (rec: EagleItemRecord) => boolean; trashIds: string[] } {
  // Only records the caller named in otherIds (same library) take part: they are the only ones
  // trashed, and the only ones whose folders count (another library's folder ids mean nothing
  // here). An empty list merges nothing. The keeper never absorbs or trashes itself.
  const allowed = new Set(opts.otherIds ?? []);
  const seen = new Set<string>([keeper.id]);
  const merged: EagleItemRecord[] = [];
  for (const o of others) {
    if (seen.has(o.id) || !allowed.has(o.id)) continue;
    seen.add(o.id);
    merged.push(o);
  }

  const unionTags = opts.unionTags !== false;
  const unionFolders = opts.unionFolders !== false;
  const mergeNotes = opts.mergeNotes !== false;

  const mutate = (rec: EagleItemRecord): boolean => {
    let changed = false;

    // Folders first: added folders bring their auto-tags and any hand-placed order.
    const haveFolders = new Set(strings(rec.folders));
    const added: string[] = [];
    if (unionFolders) {
      for (const o of merged) {
        for (const f of strings(o.folders)) {
          if (!haveFolders.has(f)) {
            haveFolders.add(f);
            added.push(f);
          }
        }
      }
      if (added.length) {
        rec.folders = [...strings(rec.folders), ...added];
        changed = true;
      }
    }

    // Tags: keeper's order first, then new ones in member order, then auto-tags of added folders.
    const tags = strings(rec.tags);
    const haveTags = new Set(tags);
    const addTag = (t: string) => {
      if (t !== '' && !haveTags.has(t)) {
        haveTags.add(t);
        tags.push(t);
      }
    };
    if (unionTags) for (const o of merged) strings(o.tags).forEach(addTag);
    for (const f of added) folderAutoTags(f).forEach(addTag);
    if (tags.length !== strings(rec.tags).length) {
      rec.tags = tags;
      changed = true;
    }

    // Notes: distinct non-empty notes of the others go after the keeper's, blank line between.
    if (mergeNotes) {
      const current = text(rec.annotation);
      const known = noteBlocks(current);
      const extra: string[] = [];
      for (const o of merged) {
        const n = text(o.annotation).trim();
        if (n && !known.has(n)) {
          known.add(n);
          extra.push(n);
        }
      }
      if (extra.length) {
        rec.annotation = current.trim()
          ? `${current.trimEnd()}\n\n${extra.join('\n\n')}`
          : extra.join('\n\n');
        changed = true;
      }
    }

    // URL: keep the keeper's when set, else the first other's.
    if (opts.keepUrl !== 'keeper' && !text(rec.url).trim()) {
      const url = merged.map((o) => text(o.url)).find((u) => u.trim() !== '');
      if (url) {
        rec.url = url;
        changed = true;
      }
    }

    // Star: the best rating wins. Only ever raises; an unrated result stays absent.
    if (opts.keepStar !== 'keeper') {
      const best = Math.max(0, ...merged.map((o) => Number(o.star) || 0));
      if (best > (Number(rec.star) || 0)) {
        rec.star = best;
        changed = true;
      }
    }

    // Manual order: for folders the keeper just joined, take the first copy's hand-placed
    // position. Values stay strings (Eagle compares them as text).
    if (added.length) {
      const addedSet = new Set(added);
      const assigned = new Set<string>();
      for (const o of merged) {
        if (!o.order || typeof o.order !== 'object') continue;
        const inFolders = new Set(strings(o.folders));
        for (const [folderId, value] of Object.entries(o.order)) {
          if (!addedSet.has(folderId) || assigned.has(folderId) || !inFolders.has(folderId))
            continue;
          if (typeof value !== 'string') continue;
          rec.order = { ...(rec.order ?? {}), [folderId]: value };
          assigned.add(folderId);
          changed = true;
        }
      }
    }

    return changed;
  };

  // opts.keepName: the keeper's name stays; an explicit new name is a file rename the service
  // does through the Eagle adapter, so there is nothing to change on the record here.
  return { keeper: mutate, trashIds: merged.map((o) => o.id) };
}
