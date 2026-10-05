// Comparing two versions of a file without the fields that change on every save. Pure: no fs.
import type { Rec } from './types';

/**
 * Fields that move whenever Eagle or Boogie saves, or that are derived from the picture
 * (docs/specs/merge.md section 1). They are dropped, at any depth, before anything is compared.
 */
const NOISE = new Set([
  'lastModified',
  'btime',
  'mtime',
  'modificationTime',
  'palettes',
  'processingPalette',
  '$$hashKey',
]);

export const isNoise = (key: string): boolean => NOISE.has(key);

/** A deep copy without the noise fields. */
export function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) if (!NOISE.has(k)) out[k] = strip(v);
    return out;
  }
  return value;
}

/** A stable text for a value: object keys sorted, absent and undefined alike. */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Rec;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : (JSON.stringify(value) ?? 'undefined');
}

export const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

/** Nothing but noise differs: the copy holds nothing the live file doesn't. */
export const redundant = (live: unknown, copy: unknown): boolean => same(strip(live), strip(copy));
