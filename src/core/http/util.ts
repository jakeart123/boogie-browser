// Small helpers shared by the Eagle-compatible HTTP routes: errors, reply types, and the
// forgiving argument readers (GET values are strings, form posts flatten arrays to `tags[0]`).
import { FOLDER_COLORS, type FolderColor } from '../../shared/types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Arguments of one request: query string merged with the parsed body. No prototype, so a
 * key like `__proto__` from a form post is just data. */
export type Args = Record<string, unknown>;

/** A reply the router sends as-is (raw bytes, HTML, or a hand-shaped JSON body). */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

export function newArgs(): Args {
  return Object.create(null) as Args;
}

/** Only keep keys whose value is defined, so calls to the core carry no `key: undefined`. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ───────────────────────── argument readers ─────────────────────────

/** Trimmed non-empty string (numbers are accepted, since query values arrive as text). */
export function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return undefined;
}

/** A list from a JSON array, a repeated/indexed form field, a JSON-array string or a comma list.
 * Repeats are dropped unless `unique` is false (addFromPaths answers one id per path given). */
export function list(v: unknown, unique = true): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(v)) raw = v;
  else if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(t);
        raw = Array.isArray(parsed) ? parsed : [t];
      } catch {
        raw = t.split(',');
      }
    } else raw = t.split(',');
  } else if (typeof v === 'number') raw = [v];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const s = str(x);
    if (s === undefined || (unique && seen.has(s))) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Tags keep commas inside a name, so a plain string is one tag; only arrays split. */
export function tagList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out = new Set<string>();
  for (const x of raw) {
    const s = str(x)?.slice(0, 1024);
    if (s !== undefined) out.add(s);
  }
  return [...out];
}

/**
 * A color from the request (folders, smart folders and tag groups share Eagle's eight names):
 * '' or null clears it, a known name sets it, and anything else (or no key) is left alone.
 */
export function colorArg(a: Args, key: string): FolderColor | null | undefined {
  if (!(key in a)) return undefined;
  if (a[key] === null || a[key] === '') return null;
  const c = str(a[key]);
  return c !== undefined && Object.hasOwn(FOLDER_COLORS, c) ? (c as FolderColor) : undefined;
}

/** 1-5 stars; anything else means "no rating given". */
export function stars(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 1 && n <= 5 ? Math.round(n) : undefined;
}

// ───────────────────────── body parsing ─────────────────────────

/** application/x-www-form-urlencoded with the extension's `tags[0]=a&tags[1]=b` arrays. */
export function parseForm(text: string): Args {
  const out = newArgs();
  const indexed = new Map<string, string[]>();
  for (const [k, v] of new URLSearchParams(text)) {
    const m = /^(.+?)\[(\d*)\]$/.exec(k);
    if (m) {
      const arr = indexed.get(m[1]) ?? [];
      // Cap the index so `tags[999999999]=x` can't allocate a giant sparse array.
      const i = m[2] === '' || Number(m[2]) > 10000 ? arr.length : Number(m[2]);
      arr[i] = v;
      indexed.set(m[1], arr);
    } else if (k in out) {
      const prev = out[k];
      out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else out[k] = v;
  }
  for (const [k, arr] of indexed) out[k] = arr.filter((x) => x !== undefined);
  return out;
}

export function parseBody(buf: Buffer, contentType: string): Args {
  const text = buf.toString('utf8');
  if (text.trim() === '') return newArgs();
  const form = /x-www-form-urlencoded/i.test(contentType);
  if (form) return parseForm(text);
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.assign(newArgs(), v);
  } catch {
    // With no content type at all (some curl uses), a form body is still fair.
    if (contentType === '' && text.includes('=')) return parseForm(text);
  }
  throw new HttpError(400, 'Bad Request: the body must be a JSON object or a form.');
}

// ───────────────────────── small shared bits ─────────────────────────

/** Eagle's cleanup of a client-supplied name: cut to 128 chars, drop `%` and HTML escapes.
 * Windows-illegal characters are handled later by the Eagle adapter. */
export function cleanName(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const t = s.slice(0, 128).replace(/%/g, '').replace(/&lt;/g, '').replace(/&gt;/g, '').trim();
  return t === '' ? undefined : t;
}

/** Offset/limit paging of the v2 API: default 50, max 1000. */
export function pageArgs(a: Args): { offset: number; limit: number } {
  const offset = Math.max(0, Math.trunc(num(a.offset) ?? 0));
  const raw = Math.trunc(num(a.limit) ?? 0);
  return { offset, limit: Math.min(1000, raw > 0 ? raw : 50) };
}

export function paged<T>(
  all: T[],
  a: Args,
): { data: T[]; total: number; offset: number; limit: number } {
  const { offset, limit } = pageArgs(a);
  return { data: all.slice(offset, offset + limit), total: all.length, offset, limit };
}
