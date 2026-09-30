// Eagle-compatible HTTP API (port 41595) and browser-extension server (port 41593), so the Eagle
// extensions, the Obsidian Eagle plugin and scripts written for Eagle's API work with Boogie.
// Everything goes through CoreHost: extension saves as "Browser extension", other writes as
// "Eagle API client", so the History tab says where a change came from.
import { join } from 'node:path';
import type { CoreHost } from '../contracts';
import type { Ctx, OpenTarget } from './context';
import { JobTracker } from './context';
import { CompatPrefs } from './prefs';
import { extensionRoutes } from './extension';
import type { Opened } from './server';
import { MAX_BODY_BYTES, closeServer, createListener, openPort } from './server';
import { v1Routes } from './v1';
import { v2Routes } from './v2';

export interface CompatServerOptions {
  /** Default 41595. Tests pass 0 for a free port. */
  apiPort?: number;
  /** Default 41593. */
  extPort?: number;
  /** One address to listen on instead of both loopbacks (127.0.0.1 and ::1). Never a wildcard. */
  bind?: string;
  /** Where errors and "copy link" opens are logged. Default: console. */
  log?: (msg: string) => void;
  /** Called when a "copy link" page (`/item?id=`, `/folder?id=`) is opened; the app can reveal it. */
  onOpen?: (target: OpenTarget) => void;
  /** Longest a route waits for an import to finish so it can return the new ids (default 10 min). */
  jobWaitMs?: number;
  /** Request body cap (default 200 MB, room for data: URLs). Tests lower it. */
  maxBodyBytes?: number;
  /** Where the extension's collect-window switch is kept (default <config>/eagle-api.json). */
  prefsFile?: string;
  /** How long a client may take to send its request, and to sit idle (default 30 s). Tests lower it. */
  timeoutMs?: number;
}

export interface CompatServer {
  /** The port we listen on, or null when it was taken (a Wine Eagle on this machine owns 41595/41593 when it runs). */
  apiPort: number | null;
  extPort: number | null;
  /** Plain English, e.g. "Eagle is using port 41595"; null when both ports are ours. */
  reason: string | null;
  /** To retry a busy port, `close()` this server and start a new one (it keeps the port it did get). */
  close(): Promise<void>;
}

const WILDCARDS = new Set(['', '0.0.0.0', '::', '*']);

export async function startEagleCompatServer(
  host: CoreHost,
  opts: CompatServerOptions = {},
): Promise<CompatServer> {
  const hosts = opts.bind === undefined ? ['127.0.0.1', '::1'] : [opts.bind.trim()];
  if (hosts.some((h) => WILDCARDS.has(h)))
    throw new Error('The Eagle API server only listens on loopback addresses.');

  const ctx: Ctx = {
    host,
    jobs: new JobTracker(host),
    log: opts.log ?? ((m) => console.warn(`[eagle-compat] ${m}`)),
    onOpen: opts.onOpen,
    jobWaitMs: opts.jobWaitMs ?? 10 * 60_000,
    recentFolders: [],
    recentTags: [],
    prefs: new CompatPrefs(opts.prefsFile ?? join(host.paths.config, 'eagle-api.json')),
  };
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const apiWant = opts.apiPort ?? 41595;
  const extWant = opts.extPort ?? 41593;

  const api = await openPort(
    apiWant,
    hosts,
    createListener({ ...v1Routes(ctx), ...v2Routes(ctx) }, ctx, { kind: 'api', maxBodyBytes }),
    opts.timeoutMs,
  );
  const ext = await openPort(
    extWant,
    hosts,
    createListener(extensionRoutes(ctx), ctx, { kind: 'ext', maxBodyBytes }),
    opts.timeoutMs,
  );

  const busy: number[] = [];
  const other: string[] = [];
  for (const [want, res] of [
    [apiWant, api],
    [extWant, ext],
  ] as [number, Opened][]) {
    if ('servers' in res) continue;
    if (res.code === 'EADDRINUSE') busy.push(want);
    else other.push(`Could not open port ${want} (${res.code})`);
  }
  const parts = busy.length
    ? [`Eagle is using port${busy.length > 1 ? 's' : ''} ${busy.join(' and ')}`, ...other]
    : other;

  const servers = [api, ext].flatMap((o) => ('servers' in o ? o.servers : []));
  if (!servers.length) ctx.jobs.close();

  let closed = false;
  return {
    apiPort: 'servers' in api ? api.port : null,
    extPort: 'servers' in ext ? ext.port : null,
    reason: parts.length ? parts.join('; ') : null,
    async close() {
      if (closed) return;
      closed = true;
      ctx.jobs.close(); // lets waiting requests finish
      await Promise.all(servers.map(closeServer));
    },
  };
}
