// localStorage that never throws (private windows, tests, disabled or full storage). Everything
// kept here is a convenience (open folders, recent picks, the viewer background), so a failure is
// silently ignored. Keys are prefixed with "boogie.".
const PREFIX = 'boogie.';

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* not worth surfacing */
  }
}

/** A list of strings (anything else stored under the key reads as empty). */
export function readList(key: string): string[] {
  const v = readJSON<unknown>(key, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Put `value` first in a recently-used list, drop repeats, keep at most `max`. Returns the list. */
export function pushRecent(key: string, value: string, max = 12): string[] {
  const next = [value, ...readList(key).filter((x) => x !== value)].slice(0, max);
  writeJSON(key, next);
  return next;
}
