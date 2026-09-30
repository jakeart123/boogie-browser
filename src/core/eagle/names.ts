// Names Boogie writes into a library. Eagle's own chain (format-spec 5.5) plus two Linux/Dropbox
// rules Eagle doesn't need: no trailing dots (Windows can't sync them) and a byte cap so
// `<name>_thumbnail.png` always fits Linux's 255-byte file name limit.

const MAX_NAME_BYTES = 200;

// Characters Windows (and so the partner's Eagle) can't have in a file name.
const ILLEGAL = /[/?<>\\:*|"]/g;
// Controls, format chars (ZWSP, ZWJ, bidi marks, soft hyphen, BOM...), private use, lone
// surrogates, line/paragraph separators, U+FFFE/FFFF, and every astral character (all emoji).
const NON_PRINTABLE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029\u2060-\u206f\ufffe\uffff\u{10000}-\u{10ffff}]/gu;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// What Eagle's auto-repair treats as "needs unescaping". A name holding these gets renamed on
// the partner's side the first time a thumbnail fails to load, so we never write them.
const ENTITY = /&(amp|lt|gt|quot|#39);/g;
const ENTITY_CHAR: Record<string, string> = { amp: '&', quot: '"', '#39': "'" };

/** Cut to at most `maxChars` characters and `maxBytes` UTF-8 bytes, on a character boundary. */
export function capUtf8(s: string, maxChars: number, maxBytes: number): string {
  let out = '';
  let chars = 0;
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (chars + 1 > maxChars || bytes + b > maxBytes) break;
    out += ch;
    chars++;
    bytes += b;
  }
  return out;
}

function stripEntitiesAndPercent(s: string): string {
  let prev: string;
  // Repeat: unescaping "&amp;lt;" makes a fresh "&lt;". Every pass only ever shortens the string.
  do {
    prev = s;
    s = s
      .replace(/%/g, '')
      .replace(/&lt;/g, '')
      .replace(/&gt;/g, '')
      .replace(ENTITY, (_m, name: string) => ENTITY_CHAR[name] ?? '');
  } while (s !== prev);
  return s;
}

/**
 * The base name (no extension) for a NEW item's original file and thumbnail.
 * Never returns an empty string.
 */
export function sanitizeItemName(input: string, nameMaxChars = 120): string {
  const cap = Number.isFinite(nameMaxChars) && nameMaxChars >= 1 ? Math.floor(nameMaxChars) : 120;
  let s = stripEntitiesAndPercent(String(input ?? ''));
  s = s.replace(ILLEGAL, '').replace(NON_PRINTABLE, '');
  s = s
    .trim()
    .replace(/[\s.]+$/u, '')
    .normalize('NFC');
  s = capUtf8(s, cap, MAX_NAME_BYTES).replace(/[\s.]+$/u, '');
  if (RESERVED.test(s)) s = '';
  return s || '_';
}

/**
 * A folder, smart folder, tag group or library name. Folder names only live in JSON, so unlike
 * item names emoji are fine; the rest follows Eagle's `sanitizeFolderName` (Windows rules).
 * `maxBytes` is for library folder names, which are real directories.
 */
export function sanitizeFolderName(
  input: string,
  opts: { maxChars?: number; maxBytes?: number } = {},
): string {
  let s = String(input ?? '')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[<>:"/\\|?*\p{Cc}]/gu, '');
  s = s.replace(/[\s.]+$/u, '').trim();
  if (RESERVED.test(s)) s += '_';
  s = s.normalize('NFC');
  s = capUtf8(s, opts.maxChars ?? 1024, opts.maxBytes ?? Infinity).replace(/[\s.]+$/u, '');
  return s || '_';
}
