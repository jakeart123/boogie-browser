// Small URL rules shared by the window code, the AppApi and the eagle:// handler.
// Plain Node (no electron import).

/** Only web pages may be handed to the desktop's browser. Never file:, javascript:, or app schemes. */
export function isWebUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `eagle://` links from a command line (first launch or a second instance). */
export function eagleUrlsFromArgv(argv: readonly string[]): string[] {
  return argv.filter((a) => /^eagle:\/\//i.test(a));
}

export interface RevealTarget {
  kind: 'item' | 'folder' | 'smartFolder';
  id: string;
}

const LINK_KINDS: Record<string, RevealTarget['kind']> = {
  item: 'item',
  folder: 'folder',
  'smart-folder': 'smartFolder',
};

/**
 * What an Eagle link points at: `eagle://item/<id>`, `eagle://folder/<id>` or
 * `eagle://smart-folder/<id>` (what Eagle's http://localhost:41595/item?id= links redirect to).
 * Anything else, like the browser extension's `eagle://open`, only brings the window up: null.
 */
export function revealFromEagleUrl(raw: string): RevealTarget | null {
  const m = /^eagle:\/\/([a-z-]+)\/([A-Za-z0-9]{1,64})\/?(?:[?#].*)?$/i.exec(raw.trim());
  const kind = m && LINK_KINDS[m[1].toLowerCase()];
  return kind ? { kind, id: m[2] } : null;
}

/** Item ids are Eagle's 13-character base-36 ids; anything else can't be in a comma list. */
const ITEM_ID = /^[A-Za-z0-9]{1,64}$/;
/** Enough to step through any real selection, small enough for a URL. */
const MAX_REFERENCE_IDS = 5000;

/** The list a reference window steps through: the ids given (itemId always in it), capped. */
export function referenceList(itemId: string, ids: readonly string[] | undefined): string[] {
  const list = [...new Set((ids ?? []).filter((id) => ITEM_ID.test(id)))];
  if (!list.includes(itemId)) list.unshift(itemId);
  if (list.length <= MAX_REFERENCE_IDS) return list;
  // Too many: keep a window of them around the one opened.
  const at = list.indexOf(itemId);
  const start = Math.max(0, Math.min(at - MAX_REFERENCE_IDS / 2, list.length - MAX_REFERENCE_IDS));
  return list.slice(start, start + MAX_REFERENCE_IDS);
}

const MAX_PASTED_URLS = 1000;

/**
 * Web links to import from clipboard text: every non-empty line must be an http(s) or data: URL
 * (a pasted sentence that merely contains a link is not an import). A uri-list may also carry
 * comments and file:// entries, which are skipped here (files are read as paths).
 */
export function urlsFromClipboardText(text: string, uriList = false): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (uriList && (l.startsWith('#') || l.startsWith('file:')))) continue;
    if (/^data:/i.test(l) || isWebUrl(l)) out.push(l);
    else if (!uriList) return []; // plain text with a line that isn't a link: not a list of links
  }
  return [...new Set(out)].slice(0, MAX_PASTED_URLS);
}
