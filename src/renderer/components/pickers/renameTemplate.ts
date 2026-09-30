// Client-side preview of batch rename. Mirrors the rules in docs/specs/service.md (`renameItems`) so
// the preview matches what the service will do:
//   *    original name        %N   running number from `start`, zero-padded to the width of the last one
//   %D   YYYYMMDD of date added   %DD  YYYY-MM-DD   %DDD  YYYY-MM-DD HH.mm.ss   %T  tags joined by ", "
// Find/replace (optionally a regex) runs after the template. Dates use local time, like Eagle's UI.

export interface RenameSource {
  name: string;
  tags: string[];
  /** Date added, ms. */
  importedAt: number;
}

export interface RenameOpts {
  /** How many items the whole batch has, when `items` is only a preview of the first few (for %N padding). */
  total?: number;
  start?: number;
  find?: string;
  replace?: string;
  regex?: boolean;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** The service only accepts whole numbers from 0 up; anything else means 1. */
export function normalizeStart(n: unknown): number {
  return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 1;
}

function dateParts(ms: number): { d: string; dd: string; ddd: string } {
  const t = new Date(ms);
  const day = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
  return {
    d: day.replaceAll('-', ''),
    dd: day,
    ddd: `${day} ${p2(t.getHours())}.${p2(t.getMinutes())}.${p2(t.getSeconds())}`,
  };
}

/** Null when the pattern is fine, else the engine's message. */
export function regexError(pattern: string): string | null {
  try {
    new RegExp(pattern, 'g');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Not a valid pattern';
  }
}

/**
 * New names for `items` (in the order given, which is also the numbering order). An empty template
 * means "keep the name". A bad regex leaves the find/replace step out.
 */
export function renamePreview(
  items: RenameSource[],
  template: string,
  opts: RenameOpts = {},
): string[] {
  const tpl = template === '' ? '*' : template;
  const start = normalizeStart(opts.start);
  const width = String(start + Math.max(opts.total ?? items.length, 1) - 1).length;
  let finder: ((s: string) => string) | null = null;
  if (opts.find) {
    if (opts.regex) {
      if (!regexError(opts.find)) {
        const re = new RegExp(opts.find, 'g');
        finder = (s) => s.replace(re, opts.replace ?? '');
      }
    } else {
      finder = (s) => s.split(opts.find!).join(opts.replace ?? '');
    }
  }
  return items.map((it, i) => {
    const date = dateParts(it.importedAt);
    const out = tpl.replace(/%DDD|%DD|%D|%N|%T|\*/g, (tok) => {
      switch (tok) {
        case '*':
          return it.name;
        case '%N':
          return String(start + i).padStart(width, '0');
        case '%D':
          return date.d;
        case '%DD':
          return date.dd;
        case '%DDD':
          return date.ddd;
        default:
          return it.tags.join(', ');
      }
    });
    return finder ? finder(out) : out;
  });
}
