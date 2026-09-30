// "Skipped" lines of a MutationResult: which ids an action left alone, and why. `kind` lets the UI
// tell "already that way" (no warning) from a real problem without matching the reason's words.
import type { MutationResult } from '../../shared/types';
import { isItemId } from './group';
import type { Touch } from './types';

export type Skip = MutationResult['skipped'][number];

export const skip = (id: string, reason: string, kind: Skip['kind'] = 'other'): Skip => ({
  id,
  reason,
  kind,
});

export const unchanged = (id: string, reason = 'Nothing to change.'): Skip =>
  skip(id, reason, 'unchanged');

export const notFound = (id: string): Skip => skip(id, 'Item not found.', 'missing');

/** De-duplicated valid ids, plus a "skipped" line for each bad one. */
export function cleanIds(raw: readonly string[]): { ids: string[]; bad: Skip[] } {
  const ids: string[] = [];
  const bad: Skip[] = [];
  for (const id of new Set(raw)) {
    if (isItemId(id)) ids.push(id);
    else bad.push(skip(id, 'Not a valid item id.'));
  }
  return { ids, bad };
}

/** Everything in `ids` that no write touched becomes a "skipped" line saying why. */
export function skipUntouched(
  t: Touch,
  ids: readonly string[],
  existing: ReadonlySet<string>,
  reason?: string,
): void {
  for (const id of ids) {
    if (t.changed.has(id) || t.added.has(id) || t.removed.has(id)) continue;
    if (t.skipped.some((x) => x.id === id)) continue;
    t.skipped.push(existing.has(id) ? unchanged(id, reason) : notFound(id));
  }
}
