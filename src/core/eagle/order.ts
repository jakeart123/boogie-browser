// Manual order inside a folder (format-spec 9). Each item stores `order[folderId]` as a decimal
// string. Eagle sorts by comparing those STRINGS (JS `<`), and a folder in MANUAL mode shows the
// biggest first. Values are timestamp-sized numbers with up to ~20 fractional digits, so all the
// arithmetic here is exact (BigInt, scaled by 10^20) and never goes through a float.
import type { EagleItemRecord } from '../../shared/types';

const FRAC_DIGITS = 20;
const SCALE = 10n ** BigInt(FRAC_DIGITS);

/** The item's sort key in a folder: its stored order, else its "date added" as a string. */
export function orderKey(
  rec: Pick<EagleItemRecord, 'order' | 'modificationTime'>,
  folderId: string,
): string {
  const o = rec.order;
  if (o && typeof o === 'object') {
    const v = (o as Record<string, unknown>)[folderId];
    if (typeof v === 'string') return v;
  }
  return String(rec.modificationTime);
}

/** String comparison, exactly like Eagle. Sort DESCENDING (b vs a) for "top first". */
export function compareOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse a plain decimal string ("1708727558963.56655092592592592596", ".5", "12") exactly. */
export function parseDecimal(s: string): bigint {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === ''))
    throw new Error(`Not a decimal order value: ${JSON.stringify(s)}`);
  const whole = BigInt(m[2] || '0') * SCALE;
  const frac = BigInt((m[3] ?? '').padEnd(FRAC_DIGITS, '0').slice(0, FRAC_DIGITS) || '0');
  const v = whole + frac;
  return m[1] === '-' ? -v : v;
}

/** Plain decimal string: no exponent, no trailing zeros, no trailing dot. */
export function formatDecimal(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(FRAC_DIGITS, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

export interface PlaceOptions {
  /** Display direction: true (default) = biggest value shown first, like Eagle's MANUAL sort. */
  descending?: boolean;
  /** Only used when the folder is empty (both neighbors null). */
  now?: number;
}

/**
 * Keys for `count` items dropped between two neighbors. `above` is the neighbor shown just before
 * the drop position and `below` the one just after (null at an edge). Returns `count` strictly
 * in-between keys in display order (the first is nearest `above`), evenly spaced; with one item
 * that is the midpoint (A+B)/2 that Eagle uses. At an edge the missing neighbor is taken as the
 * other one plus or minus 1, like Eagle.
 * Throws when there is no room (the neighbors share a value, or precision ran out): call
 * `spreadDuplicates` on the folder's keys first.
 */
export function placeBetween(
  above: string | null,
  below: string | null,
  count: number,
  opts: PlaceOptions = {},
): string[] {
  if (count <= 0) return [];
  const dir = opts.descending === false ? -1n : 1n;
  let a: bigint;
  let b: bigint;
  if (above !== null && below !== null) {
    a = parseDecimal(above);
    b = parseDecimal(below);
  } else if (above !== null) {
    a = parseDecimal(above);
    b = a - dir * SCALE;
  } else if (below !== null) {
    b = parseDecimal(below);
    a = b + dir * SCALE;
  } else {
    b = BigInt(Math.trunc(opts.now ?? Date.now())) * SCALE;
    a = b + dir * SCALE;
  }
  const gap = (a - b) / BigInt(count + 1);
  if (gap === 0n)
    throw new Error('No room between these two order values; spread the duplicates first.');
  const out: string[] = [];
  for (let k = 1; k <= count; k++) out.push(formatDecimal(a - gap * BigInt(k)));
  return out;
}

/**
 * Eagle's fix for items that share an order value: give each one its own. `keys` are the folder's
 * keys in display order; returns keys of the same length and order where every run of equal values
 * is respread evenly between its neighbors. Untouched entries come back as the same string.
 */
export function spreadDuplicates(keys: string[], opts: PlaceOptions = {}): string[] {
  const out = [...keys];
  let i = 0;
  while (i < out.length) {
    let j = i;
    const v = parseDecimal(out[i]);
    while (j + 1 < out.length && parseDecimal(out[j + 1]) === v) j++;
    if (j > i) {
      // At a list edge stay within 1 of the shared value instead of running off to the other neighbor.
      const dir = opts.descending === false ? -1n : 1n;
      const above = i > 0 ? out[i - 1] : formatDecimal(v + dir * SCALE);
      const below = j + 1 < out.length ? out[j + 1] : formatDecimal(v - dir * SCALE);
      const spread = placeBetween(above, below, j - i + 1, opts);
      for (let k = i; k <= j; k++) out[k] = spread[k - i];
    }
    i = j + 1;
  }
  return out;
}
