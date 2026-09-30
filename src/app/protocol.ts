// The boogie:// scheme: how the renderer gets thumbnails, originals and previews.
// URL shape (built by src/shared/api.ts): boogie://<thumb|file|preview>/<libraryId>/<itemId>?v=<version>
// Everything here is plain Node (no electron import) so it can be unit tested. main.ts plugs
// `createProtocolHandler(host)` into `protocol.handle('boogie', ...)`.
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { CoreHost } from '../core/contracts';
import { sniffMime } from '../core/service/files';

export type FileKind = 'thumb' | 'file' | 'preview';

export interface BoogieUrl {
  kind: FileKind;
  libraryId: string;
  itemId: string;
  /** The cache-busting `v` param. Present on every URL the core builds. */
  version: string | null;
}

const KINDS: readonly string[] = ['thumb', 'file', 'preview'];
// Library ids are hex, Eagle item ids are 13 uppercase alphanumerics or a 36 char uuid.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseBoogieUrl(raw: string): BoogieUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'boogie:') return null;
  const kind = url.hostname.toLowerCase();
  if (!KINDS.includes(kind)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  let libraryId: string, itemId: string;
  try {
    libraryId = decodeURIComponent(parts[0]);
    itemId = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (!ID.test(libraryId) || !ID.test(itemId)) return null;
  return { kind: kind as FileKind, libraryId, itemId, version: url.searchParams.get('v') };
}

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * Reads a `Range` header for a file of `size` bytes.
 * Returns null when there is no usable range (serve the whole file with 200: that is what the
 * spec allows for a missing, malformed or multi-part header) and 'unsatisfiable' for 416.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes=(\d*)-(\d*)\s*$/i.exec(header);
  if (!m) return null; // also covers "bytes=0-1,5-9": one 200 response is always allowed
  const [, from, to] = m;
  if (!from && !to) return null;
  if (!from) {
    // suffix range: the last N bytes
    const n = Number(to);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return 'unsatisfiable';
  const end = to ? Math.min(Number(to), size - 1) : size - 1;
  if (end < start) return null; // "bytes=9-3" is malformed, not unsatisfiable
  return { start, end };
}

const IMMUTABLE = 'max-age=31536000, immutable';
// Only our own pages can reach this scheme, so any origin may read it (fetch(), canvas pixels).
const OPEN = { 'access-control-allow-origin': '*' };

/**
 * Files up to this size are read in one go and the file closed at once (thumbnails are 18-51 KB).
 * Bigger ones (videos, huge originals) are streamed, and the stream dies with the request.
 */
const WHOLE_MAX = 8 * 1024 * 1024;
/**
 * Files being read at once. Node's file work runs on 4 threads, so more only queue there, where a
 * request the page already gave up on can't be dropped.
 */
const READS_AT_ONCE = 12;

/**
 * At most `limit` holders at once. Waiters are served newest first: after a fast scroll the
 * newest requests are the tiles on screen now, and the old ones have usually been cancelled.
 */
function gate(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const leave = () => {
    const next = waiting.pop();
    if (next)
      next(); // the slot passes straight on
    else active--;
  };
  return {
    leave,
    /** false: the request was cancelled before its turn (the slot is not held). */
    async enter(signal: AbortSignal | undefined): Promise<boolean> {
      if (signal?.aborted) return false;
      if (active < limit) {
        active++;
        return true;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      if (!signal?.aborted) return true;
      leave();
      return false;
    },
  };
}

/** The page is gone: nobody reads this, but protocol.handle still wants a Response. */
const cancelled = () => new Response(null, { status: 499 });

/**
 * The request handler. It only ever serves a path that `host.resolveFile` returned for the
 * (kind, library, item) in the URL, never a path taken from the URL itself. A request whose
 * `signal` fires (an <img> whose src was cleared) is dropped at the next step.
 */
export function createProtocolHandler(
  host: Pick<CoreHost, 'resolveFile'>,
): (req: Request) => Promise<Response> {
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { ...OPEN, 'content-type': 'text/plain' } });
  const reads = gate(READS_AT_ONCE);

  return async (req) => {
    const signal = req.signal as AbortSignal | undefined;
    const parsed = parseBoogieUrl(req.url);
    if (!parsed) return notFound();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...OPEN, allow: 'GET, HEAD' } });
    }
    if (signal?.aborted) return cancelled();

    let resolved: { path: string; mime: string } | null;
    try {
      resolved = await host.resolveFile(parsed.kind, parsed.libraryId, parsed.itemId);
    } catch (e) {
      console.warn(`[boogie://] could not resolve ${parsed.kind} ${parsed.itemId}:`, e);
      return new Response('Could not prepare that file', {
        status: 500,
        headers: { ...OPEN, 'content-type': 'text/plain' },
      });
    }
    if (!resolved) return notFound();

    if (!(await reads.enter(signal))) return cancelled();
    let fh: FileHandle | null = null;
    let streaming = false;
    try {
      try {
        fh = await open(resolved.path, 'r');
      } catch {
        return notFound();
      }
      const st = await fh.stat();
      if (!st.isFile()) return notFound();
      const size = st.size;
      if (signal?.aborted) return cancelled();

      const headers: Record<string, string> = {
        ...OPEN,
        'access-control-expose-headers': 'content-range, content-length, accept-ranges',
        'content-type': resolved.mime || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
        // The `v` param changes whenever the item does. Without it we can't promise that.
        'cache-control': parsed.version ? IMMUTABLE : 'no-cache',
      };

      const range = parseRange(req.headers.get('range'), size);
      if (range === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'content-range': `bytes */${size}` },
        });
      }

      let status = 200;
      let start = 0;
      let end = size - 1;
      if (range) {
        status = 206;
        ({ start, end } = range);
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
      }
      const length = size === 0 ? 0 : end - start + 1;
      headers['content-length'] = String(length);

      if (req.method === 'HEAD' || length === 0) return new Response(null, { status, headers });
      if (length <= WHOLE_MAX) {
        const buf = Buffer.allocUnsafe(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await fh.read(buf, got, length - got, start + got);
          if (bytesRead === 0) break; // the file shrank under us: send what is there
          got += bytesRead;
        }
        if (signal?.aborted) return cancelled();
        // The resolver guessed the type; the bytes know (an Eagle thumbnail named .png is WebP).
        if (start === 0) headers['content-type'] = sniffMime(buf) ?? headers['content-type'];
        if (got < length) headers['content-length'] = String(got);
        return new Response(got < length ? buf.subarray(0, got) : buf, { status, headers });
      }

      // Big: stream from the handle we opened; it is closed when the stream ends or is destroyed,
      // and a cancelled request destroys it.
      streaming = true;
      const stream = fh.createReadStream({ start, end, autoClose: true, signal });
      stream.on('error', () => undefined); // an abort is not worth a crash
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
    } catch (e) {
      console.warn(`[boogie://] could not read ${parsed.kind} ${parsed.itemId}:`, e);
      return notFound();
    } finally {
      if (!streaming) await fh?.close().catch(() => undefined);
      reads.leave();
    }
  };
}
