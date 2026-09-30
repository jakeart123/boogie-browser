// Batch rename templates (Eagle's tokens). Pure: no I/O.
//   *     the original name
//   %N    running number from `start`, zero-padded to the width of the last number
//   %D    date added as YYYYMMDD        %DD   YYYY-MM-DD        %DDD  YYYY-MM-DD HH.mm.ss
//   %T    the item's tags joined by ", "
// find/replace (plain text, or a regular expression) runs after the template.

export interface RenameSource {
  name: string;
  tags: string[];
  /** Date added, ms. */
  importedAt: number;
}

export interface RenameOptions {
  start?: number;
  find?: string;
  replace?: string;
  regex?: boolean;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function formatDate(ms: number, token: 'D' | 'DD' | 'DDD'): string {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (token === 'DD') return day;
  if (token === 'D') return day.replace(/-/g, '');
  return `${day} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

export function expandRenameTemplate(
  template: string,
  sources: readonly RenameSource[],
  opts: RenameOptions = {},
): string[] {
  const start =
    Number.isInteger(opts.start) && (opts.start as number) >= 0 ? (opts.start as number) : 1;
  const width = String(start + Math.max(0, sources.length - 1)).length;
  let find: RegExp | null = null;
  if (opts.find) {
    try {
      find = opts.regex ? new RegExp(opts.find, 'g') : null;
    } catch {
      throw new Error(`"${opts.find}" is not a valid search pattern.`);
    }
  }

  return sources.map((src, i) => {
    let out = '';
    for (let p = 0; p < template.length;) {
      const rest = template.slice(p);
      if (template[p] === '*') {
        out += src.name;
        p += 1;
      } else if (rest.startsWith('%DDD')) {
        out += formatDate(src.importedAt, 'DDD');
        p += 4;
      } else if (rest.startsWith('%DD')) {
        out += formatDate(src.importedAt, 'DD');
        p += 3;
      } else if (rest.startsWith('%D')) {
        out += formatDate(src.importedAt, 'D');
        p += 2;
      } else if (rest.startsWith('%N')) {
        out += pad(start + i, width);
        p += 2;
      } else if (rest.startsWith('%T')) {
        out += src.tags.join(', ');
        p += 2;
      } else {
        out += template[p];
        p += 1;
      }
    }
    if (opts.find) {
      out = find
        ? out.replace(find, opts.replace ?? '')
        : out.split(opts.find).join(opts.replace ?? '');
    }
    return out;
  });
}
