// The HTTP plumbing shared by both ports: who may talk to us (Host and Origin checks), body
// reading with a size cap, routing, the JSON envelope, and listening on both loopback
// addresses. The routes themselves live in v1.ts, v2.ts and extension.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ctx, Req, RouteTable } from './context';
import { CLIENT_ACTOR, EXTENSION_ACTOR } from './context';
import { HttpError, Reply, newArgs, parseBody, parseForm } from './util';

export const MAX_BODY_BYTES = 200 * 1024 * 1024; // room for data: URLs of big images
const TIMEOUT_MS = 30_000;

// ───────────────────────── who may talk to us ─────────────────────────

const HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/i;
// Only the browser extensions and Obsidian. Any http(s) page, `null`, file: and the rest are
// refused, because a web page must never be able to add files to a library.
const EXTENSION_ORIGIN_RE = /^(chrome|moz)-extension:\/\/[A-Za-z0-9._-]+$/;
const OBSIDIAN_ORIGIN = 'app://obsidian.md';

/** Blocks DNS rebinding: the Host must be a loopback name on the port that was reached. */
function hostAllowed(header: string | undefined, port: number): boolean {
  const m = header ? HOST_RE.exec(header.trim()) : null;
  return !!m && Number(m[2]) === port;
}

/** No Origin header (curl, local tools) is fine; a header must be on the short allow list. */
function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || EXTENSION_ORIGIN_RE.test(origin) || origin === OBSIDIAN_ORIGIN;
}

// ───────────────────────── one request ─────────────────────────

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max)
      return reject(new HttpError(413, 'Request body too large.'));
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        if (!tooBig) reject(new HttpError(413, 'Request body too large.'));
        tooBig = true;
        chunks.length = 0;
      } else if (!tooBig) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Request aborted.')));
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string>,
): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, {
    'Content-Length': String(Buffer.byteLength(body)),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };

/** A core error that is really about the library's state: none open (503), or open read-only,
 * which refuses every write with its reason (409). Anything else stays a 500. */
async function fromCore(ctx: Ctx, e: unknown): Promise<HttpError | undefined> {
  const st = await ctx.host.api.getLibraryState().catch(() => null);
  if (!st) return new HttpError(503, 'No library has been opened yet.');
  if (st.readOnly && st.readOnlyReason && (e as Error)?.message === st.readOnlyReason)
    return new HttpError(409, st.readOnlyReason);
  return undefined;
}

export interface ListenerOptions {
  /** `ext` is the extension port: everything on it counts as a browser-extension save. */
  kind: 'api' | 'ext';
  maxBodyBytes: number;
}

export function createListener(
  table: RouteTable,
  ctx: Ctx,
  o: ListenerOptions,
): http.RequestListener {
  return async (req, res) => {
    let cors: Record<string, string> = {};
    try {
      if (!hostAllowed(req.headers.host, req.socket.localPort ?? 0)) {
        throw new HttpError(403, 'Forbidden: unexpected Host header.');
      }
      const origin = req.headers.origin;
      if (!originAllowed(origin))
        throw new HttpError(403, 'Forbidden: this origin may not use the API.');
      // Echo the one allowed origin, never `*`.
      if (origin !== undefined) cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

      if (req.method === 'OPTIONS') {
        const pre: Record<string, string> = { Allow: 'GET, POST, OPTIONS', ...cors };
        if (origin !== undefined) {
          pre['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
          pre['Access-Control-Allow-Headers'] = String(
            req.headers['access-control-request-headers'] ?? 'Content-Type',
          );
          pre['Access-Control-Max-Age'] = '600';
          if (req.headers['access-control-request-private-network'] === 'true')
            pre['Access-Control-Allow-Private-Network'] = 'true';
        }
        return send(res, 204, '', pre);
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw Object.assign(new HttpError(405, 'method not allowed'), {
          allow: 'GET, POST, OPTIONS',
        });
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const path =
        url.pathname.length > 1 && url.pathname.endsWith('/')
          ? url.pathname.slice(0, -1)
          : url.pathname;
      const route = Object.hasOwn(table, path) ? table[path] : undefined;
      if (!route) throw new HttpError(404, 'Not found.');
      const handler = route[req.method];
      if (!handler) {
        throw Object.assign(new HttpError(405, 'method not allowed'), {
          allow: `${Object.keys(route).join(', ')}, OPTIONS`,
        });
      }

      const args = Object.assign(newArgs(), parseForm(url.search.slice(1)));
      if (req.method === 'POST') {
        const body = await readBody(req, o.maxBodyBytes);
        Object.assign(args, parseBody(body, String(req.headers['content-type'] ?? '')));
      }
      // The request is in. The idle timer guards against slow senders; from here on only our own
      // work runs, and an add that returns ids may wait minutes for its import (add.ts settle).
      req.socket.setTimeout(0);
      const fromExtension =
        o.kind === 'ext' || (origin !== undefined && EXTENSION_ORIGIN_RE.test(origin));
      const r: Req = {
        method: req.method,
        path,
        args,
        origin: origin ?? null,
        actor: fromExtension ? EXTENSION_ACTOR : CLIENT_ACTOR,
        fromExtension,
      };

      const out = await handler(r);
      if (out instanceof Reply) {
        const raw = typeof out.body === 'string' || Buffer.isBuffer(out.body);
        return send(
          res,
          out.status,
          raw ? (out.body as string | Buffer) : JSON.stringify(out.body),
          {
            ...(raw ? {} : JSON_TYPE),
            ...cors,
            ...out.headers,
          },
        );
      }
      return send(
        res,
        200,
        JSON.stringify(
          out === undefined ? { status: 'success' } : { status: 'success', data: out },
        ),
        {
          ...JSON_TYPE,
          ...cors,
        },
      );
    } catch (e) {
      const err = e instanceof HttpError ? e : await fromCore(ctx, e);
      const status = err?.status ?? 500;
      if (!err) ctx.log(`error: ${(e as Error).message ?? e}`);
      const extra: Record<string, string> = {};
      const allow = (e as { allow?: string }).allow;
      if (allow) extra.Allow = allow;
      if (status === 413) extra.Connection = 'close';
      const forbidden = status === 403; // no CORS headers for refused callers
      send(
        res,
        status,
        JSON.stringify({
          status: 'error',
          message: err ? err.message : String((e as Error).message ?? e),
        }),
        {
          ...JSON_TYPE,
          ...(forbidden ? {} : cors),
          ...extra,
        },
      );
      if (status === 413) res.once('finish', () => req.socket.destroy());
    }
  };
}

// ───────────────────────── listening ─────────────────────────

function listenOnce(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host }, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export type Opened = { port: number; servers: http.Server[] } | { code: string };

/** Listen on every address in `hosts` (127.0.0.1 and ::1) on one port. IPv6 that the machine
 * does not have is skipped; a port someone else holds gives `{code: 'EADDRINUSE'}`. Port 0 picks
 * a free port that is free on both addresses. */
export async function openPort(
  want: number,
  hosts: string[],
  listener: http.RequestListener,
  timeoutMs = TIMEOUT_MS,
): Promise<Opened> {
  for (let attempt = 0; ; attempt++) {
    const servers: http.Server[] = [];
    try {
      let port = want;
      for (const [i, host] of hosts.entries()) {
        // Node only checks request and header timeouts every `connectionsCheckingInterval`
        // (30 s by default), which would make a "30 s" limit closer to 60 s.
        const server = http.createServer(
          { connectionsCheckingInterval: Math.min(5_000, timeoutMs) },
          listener,
        );
        server.requestTimeout = timeoutMs;
        server.headersTimeout = Math.min(15_000, timeoutMs);
        server.timeout = timeoutMs;
        server.keepAliveTimeout = 5_000;
        try {
          port = await listenOnce(server, port, host);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (i > 0 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
          throw e;
        }
        servers.push(server);
      }
      return { port, servers };
    } catch (e) {
      await Promise.all(servers.map(closeServer));
      const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (want === 0 && code === 'EADDRINUSE' && attempt < 4) continue;
      return { code };
    }
  }
}
