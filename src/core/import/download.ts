// Getting bytes from a URL into a temp file: data: URLs and http(s) downloads, plus the small
// parsers for a file name (Content-Disposition, URL path). Files land in `tmpDir` only.
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3; // 2 GB
export const IDLE_TIMEOUT_MS = 60_000; // no bytes for a minute = give up (a slow big file may run longer)
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export interface Downloaded {
  path: string;
  /** File name suggested by the server (Content-Disposition), if any. */
  headerName: string | null;
}

/**
 * The link is a web page, not a file. Eagle saves such links as bookmarks, so the importer does
 * too: this carries what the page says about itself (its title and preview picture).
 */
export class WebPageLink extends Error {
  constructor(
    readonly url: string,
    readonly title: string | null,
    readonly imageUrl: string | null,
  ) {
    super('that link is a web page, not a file');
  }
}

/** How much of a page is read to find its title and preview picture (both live in <head>). */
const PAGE_HEAD_BYTES = 512 * 1024;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** `<meta property|name="…" content="…">`, in either attribute order. */
function metaContent(html: string, names: string[]): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !names.includes(key)) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const v = content?.[1] ?? content?.[2];
    if (v?.trim()) return decodeEntities(v.trim());
  }
  return null;
}

/** A page's title (og:title, else <title>) and preview picture (og:image / twitter:image), absolute. */
export function readPageHead(
  html: string,
  pageUrl: string,
): { title: string | null; image: string | null } {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title =
    metaContent(html, ['og:title', 'twitter:title']) ??
    (titleTag ? decodeEntities(titleTag.replace(/\s+/g, ' ').trim()) || null : null);
  let image = metaContent(html, [
    'og:image',
    'og:image:url',
    'og:image:secure_url',
    'twitter:image',
  ]);
  if (image) {
    try {
      const abs = new URL(image, pageUrl);
      image = abs.protocol === 'http:' || abs.protocol === 'https:' ? abs.href : null;
    } catch {
      image = null;
    }
  }
  return { title, image };
}

/**
 * The temp file's ext comes from the server's MIME type only, never from the URL (a `.php` or
 * `.aspx` link would stick). With no ext the file is named by its content, like Eagle's downloads.
 */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff', // Eagle's own MIME mapping
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

function tempName(dir: string, ext: string | null): string {
  return join(dir, `dl-${randomUUID()}${ext ? '.' + ext : ''}`);
}

/** Parse `data:[<mime>][;base64],<payload>`. Returns null when it isn't a valid data URL. */
export function parseDataUrl(url: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(url);
  if (!m) return null;
  const params = m[1].split(';');
  const mime = (params[0] || 'text/plain').toLowerCase();
  const base64 = params.some((p) => p.toLowerCase() === 'base64');
  let payload = m[2];
  try {
    payload = decodeURIComponent(payload);
  } catch {
    /* not percent-encoded after all: use it as it is */
  }
  return { mime, bytes: Buffer.from(payload, base64 ? 'base64' : 'utf8') };
}

/** Write a data: URL's bytes to a temp file. */
export async function saveDataUrl(
  url: string,
  tmpDir: string,
): Promise<{ path: string; mime: string }> {
  const parsed = parseDataUrl(url);
  if (!parsed) throw new Error('that data link is not valid');
  if (parsed.mime === 'text/html') throw new Error('that link is a web page, not a file');
  await mkdir(tmpDir, { recursive: true });
  const path = tempName(tmpDir, MIME_EXT[parsed.mime] ?? null);
  await writeFile(path, parsed.bytes);
  return { path, mime: parsed.mime };
}

/** Servers often send UTF-8 bytes that fetch reads as latin-1; undo that when it round-trips cleanly. */
function fixMojibake(s: string): string {
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  return fixed.includes('�') ? s : fixed;
}

const lastSegment = (s: string) => s.split(/[\\/]/).pop() ?? s;

/** File name from a Content-Disposition header (RFC 6266), without any folder part. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (encoded) {
    try {
      const name = lastSegment(decodeURIComponent(encoded[2].trim().replace(/^"|"$/g, '')));
      if (name) return name;
    } catch {
      /* fall through to the plain filename */
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return lastSegment(fixMojibake(quoted[1].replace(/\\(.)/g, '$1'))) || null;
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) return lastSegment(fixMojibake(bare[1].trim())) || null;
  return null;
}

/** A file name from a URL's path, or null: `https://x/a/pic%201.jpg?w=2` -> `pic 1.jpg`. */
export function filenameFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const seg = path.split('/').filter(Boolean).pop();
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Drop a real-looking extension (1-5 letters/digits, at least one letter) from a name we were given. */
export function dropFileExt(name: string): string {
  const ext = extname(name);
  const looksReal = /^\.[a-z0-9]{1,5}$/i.test(ext) && /[a-z]/i.test(ext); // not the ".00" of "16.10.00"
  return looksReal && ext.length < name.length ? name.slice(0, -ext.length) : name;
}

/** The start of a response body as text (a page's <head>), then the rest is left unread. */
async function readHead(body: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      // The head is all we want; stop as soon as it has closed.
      if (/<\/head>|<body[\s>]/i.test(Buffer.from(value).toString('latin1'))) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).toString('utf8');
}

export interface DownloadOptions {
  referer?: string;
  headers?: Record<string, string>;
  /** Give up after this long with no bytes arriving. Default 60 s; tests use a short one. */
  idleTimeoutMs?: number;
  /** Size cap. Default 2 GB; tests use a small one. */
  maxBytes?: number;
  /** Stops the download (a cancelled job, a paused agent). */
  signal?: AbortSignal;
  /** The address that chose this one (a page, for its preview picture). Default: the URL itself. */
  chosenBy?: string;
}

// ───────────────────────── local addresses ─────────────────────────

/** Loopback, private-network, link-local and other addresses that aren't the public internet. */
export function isPrivateAddress(ip: string): boolean {
  let a = ip.toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p = 0, q = 0] = a.split('.').map(Number);
    return (
      p === 0 ||
      p === 10 ||
      p === 127 ||
      p >= 224 ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 100 && q >= 64 && q <= 127)
    );
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

/** Whether a URL points at this computer or the local network (by what its host resolves to). */
export async function isLocalUrl(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (isIP(host)) return isPrivateAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  try {
    return (await lookup(host, { all: true })).some((r) => isPrivateAddress(r.address));
  } catch {
    return false; // unknown name: the fetch itself fails
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

/**
 * Stream an http(s) URL into `tmpDir`. Throws a plain-English Error on any failure. A link from
 * the internet (or a picture a public page names) never leads Boogie to an address on this
 * computer or the local network, redirects included: a web page must not be able to make it call
 * local services. Links that are local themselves (a dev server, a NAS) work as before.
 */
export async function downloadUrl(
  url: string,
  tmpDir: string,
  opts: DownloadOptions = {},
): Promise<Downloaded> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('that link is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only web links and data links can be imported');
  }
  await mkdir(tmpDir, { recursive: true });

  const idleMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const tooBig = 'that file is bigger than 2 GB';
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('the download was cancelled'));
  if (opts.signal?.aborted) cancel();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('the download timed out')), idleMs);
  };
  arm();

  let path: string | null = null;
  try {
    // Many image hosts refuse hotlinking, so look like a browser that came from the page.
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'image/*,video/*,*/*;q=0.8',
      Referer: opts.referer ?? parsed.origin + '/',
      ...opts.headers,
    };
    const stayPublic = !(await isLocalUrl(opts.chosenBy ?? url));
    let at = url;
    let res: Response;
    for (let hops = 0; ; hops++) {
      if (stayPublic && (await isLocalUrl(at)))
        throw new Error('that link leads to an address on this computer or network');
      res = await fetch(at, { headers, signal: controller.signal, redirect: 'manual' });
      const next = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
      if (!next) break;
      await res.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS) throw new Error('that link redirects too many times');
      at = new URL(next, at).href;
      if (!/^https?:$/.test(new URL(at).protocol)) throw new Error('that link is not valid');
    }
    if (!res.ok)
      throw new Error(
        `the server answered ${res.status}${res.statusText ? ' ' + res.statusText : ''}`,
      );
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === 'application/xhtml+xml') {
      const head = res.body ? await readHead(res.body, PAGE_HEAD_BYTES) : '';
      const page = readPageHead(head, at);
      throw new WebPageLink(url, page.title, page.image);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > maxBytes) throw new Error(tooBig);
    if (!res.body) throw new Error('the server sent nothing');

    path = tempName(tmpDir, MIME_EXT[type] ?? null);
    // Content-Length can be missing or wrong, so count what really arrives too.
    let bytes = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        arm();
        cb(bytes > maxBytes ? new Error(tooBig) : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      guard,
      createWriteStream(path),
      {
        signal: controller.signal,
      },
    );
    return {
      path,
      headerName: filenameFromContentDisposition(res.headers.get('content-disposition')),
    };
  } catch (e) {
    if (path) await rm(path, { force: true });
    if (e instanceof WebPageLink) throw e;
    if (controller.signal.aborted) {
      const why = controller.signal.reason;
      throw why instanceof Error ? why : new Error('the download was cancelled');
    }
    if (e instanceof TypeError && e.message === 'fetch failed') {
      const code = (e.cause as { code?: string } | undefined)?.code;
      throw new Error(`could not reach that server${code ? ' (' + code + ')' : ''}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
    controller.abort(); // also drops the connection when we bailed out before reading the body
  }
}
