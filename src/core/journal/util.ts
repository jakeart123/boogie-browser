// Small helpers shared by the item and root undo planners.
import { isDeepStrictEqual } from 'node:util';

export type Rec = Record<string, unknown>;

/** Same shape as UndoPlan['conflicts'] entries. */
export interface Conflict {
  id: string;
  field: string;
  reason: string;
}

export const CHANGED_SINCE = 'changed since';

/**
 * Eagle's UI leaks an AngularJS "$$hashKey" into every palette entry on the first edit of an
 * item (live-behavior.md §1). It is noise: a tag change must not look like a palette change.
 */
function withoutHashKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutHashKeys);
  if (v && typeof v === 'object') {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) if (k !== '$$hashKey') out[k] = withoutHashKeys(x);
    return out;
  }
  return v;
}

/** Deep equality where "absent" equals undefined and palettes ignore $$hashKey. */
export function same(a: unknown, b: unknown, key?: string): boolean {
  if (key === 'palettes') return isDeepStrictEqual(withoutHashKeys(a), withoutHashKeys(b));
  return isDeepStrictEqual(a, b);
}

/** Put `value` back under `key`; undefined means the key did not exist, so delete it. */
export function setOrDelete(target: Rec, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = structuredClone(value);
}

export function unionKeys(a: Rec, b: Rec): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asObject(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}
