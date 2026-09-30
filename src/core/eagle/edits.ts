// Eagle's exact edit semantics as pure functions on a raw item record (format-spec 14, 19.3).
// The service calls these inside `updateItem(id, (rec) => ..., ctx)`. Each returns true if it
// changed the record. They never delete a key except where Eagle does: `star` on unrate and
// `deletedTime` on a single restore. New keys are appended (key order = insertion order).
import type { EagleItemRecord } from '../../shared/types';

const MAX_TAG = 1024;
const MAX_URL = 2000;

/** Trim, cap at 1024 chars, drop empties and repeats. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, MAX_TAG);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ───────────────────────── rating and trash ─────────────────────────

/** 1-5 sets `star` (appended if absent). 0 (or anything else) removes the key, like Eagle. */
export function setStar(rec: EagleItemRecord, n: number): boolean {
  const star = Math.trunc(Number(n));
  if (star >= 1 && star <= 5) {
    if (rec.star === star) return false;
    rec.star = star;
    return true;
  }
  if (!('star' in rec)) return false;
  delete rec.star;
  return true;
}

/** `isDeleted = true` and `deletedTime = now` (appended if absent). Folders stay. */
export function trash(rec: EagleItemRecord, now: number): boolean {
  if (rec.isDeleted === true) return false;
  rec.isDeleted = true;
  rec.deletedTime = now;
  return true;
}

/** Single restore: `isDeleted = false` and `deletedTime` removed. */
export function restore(rec: EagleItemRecord): boolean {
  if (rec.isDeleted !== true && !('deletedTime' in rec)) return false;
  rec.isDeleted = false;
  delete rec.deletedTime;
  return true;
}

// ───────────────────────── tags ─────────────────────────

/** Append tags that aren't there yet. Existing tags keep their order. */
export function addTags(rec: EagleItemRecord, tags: readonly string[]): boolean {
  const current = stringArray(rec.tags);
  const have = new Set(current);
  const add = normalizeTags(tags).filter((t) => !have.has(t));
  if (add.length === 0) return false;
  rec.tags = [...current, ...add];
  return true;
}

export function removeTags(rec: EagleItemRecord, tags: readonly string[]): boolean {
  const drop = new Set(normalizeTags(tags));
  const current = stringArray(rec.tags);
  const kept = current.filter((t) => !drop.has(t));
  if (kept.length === current.length) return false;
  rec.tags = kept;
  return true;
}

/** Make the tag set equal to `tags`: survivors keep their order, new ones go at the end. */
export function setTags(rec: EagleItemRecord, tags: readonly string[]): boolean {
  const want = normalizeTags(tags);
  const wantSet = new Set(want);
  const current = stringArray(rec.tags);
  const kept = current.filter((t) => wantSet.has(t));
  const keptSet = new Set(kept);
  const next = [...kept, ...want.filter((t) => !keptSet.has(t))];
  if (sameList(next, current)) return false;
  rec.tags = next;
  return true;
}

// ───────────────────────── folders ─────────────────────────

/**
 * Put the item in more folders. When at least one folder was really added, also add `autoTags`
 * (those folders' own + ancestors' tags; the caller computes them with root.autoTagsFor).
 */
export function addFolders(
  rec: EagleItemRecord,
  ids: readonly string[],
  autoTags: readonly string[] = [],
): boolean {
  const current = stringArray(rec.folders);
  const have = new Set(current);
  const add = [...new Set(ids)].filter((id) => typeof id === 'string' && id && !have.has(id));
  if (add.length === 0) return false;
  rec.folders = [...current, ...add];
  addTags(rec, autoTags);
  return true;
}

export function removeFolders(rec: EagleItemRecord, ids: readonly string[]): boolean {
  const drop = new Set(ids);
  const current = stringArray(rec.folders);
  const kept = current.filter((id) => !drop.has(id));
  if (kept.length === current.length) return false;
  rec.folders = kept;
  return true;
}

/** Make the folder list equal to `ids` (survivors keep their order). Auto-tags only for folders newly added. */
export function setFolders(
  rec: EagleItemRecord,
  ids: readonly string[],
  autoTags: readonly string[] = [],
): boolean {
  const want = [...new Set(ids)].filter((id) => typeof id === 'string' && id);
  const wantSet = new Set(want);
  const current = stringArray(rec.folders);
  const kept = current.filter((id) => wantSet.has(id));
  const keptSet = new Set(kept);
  const added = want.filter((id) => !keptSet.has(id));
  const next = [...kept, ...added];
  if (sameList(next, current)) return false;
  rec.folders = next;
  if (added.length > 0) addTags(rec, autoTags);
  return true;
}

// ───────────────────────── note, link, manual order ─────────────────────────

export function setAnnotation(rec: EagleItemRecord, text: string): boolean {
  const next = String(text ?? '');
  if (rec.annotation === next) return false;
  rec.annotation = next;
  return true;
}

/** The source URL, cut to 2000 chars like Eagle does on every save. */
export function setUrl(rec: EagleItemRecord, url: string): boolean {
  const next = String(url ?? '').slice(0, MAX_URL);
  if (rec.url === next) return false;
  rec.url = next;
  return true;
}

/** Manual position in one folder (see order.ts). The `order` key is appended if absent. */
export function setOrder(rec: EagleItemRecord, folderId: string, key: string): boolean {
  const current = rec.order && typeof rec.order === 'object' ? rec.order : null;
  if (current && current[folderId] === key) return false;
  rec.order = { ...(current ?? {}), [folderId]: key };
  return true;
}
