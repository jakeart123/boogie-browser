// `npm run dev:web`: the renderer in a plain browser, backed by the REAL core running inside the
// vite process, on a throwaway reflinked copy of a library. Nothing here is a fake core: queries,
// writes, history, undo and events are the ones the desktop app gets. The browser talks to it
// over POST /__dev/rpc {method, args}, an SSE stream at /__dev/events, and files at
// /__dev/files/<thumb|file|preview>/<library>/<item> (the desktop app's boogie:// URLs).
//
// Env (all optional):
//   BOOGIE_DEV_LIBRARY=<path>  library to copy and open (default: the Art Archive template, or the
//                              committed test fixture when the private templates are missing)
//   BOOGIE_DEV_READONLY=1      open it read-only (the real banner, every write refused)
//   BOOGIE_DEV_REUSE=1         keep the copy and app data from the last run on this port
// The copies, app data (BOOGIE_HOME) and the only writable root live in .tmp/dev/<port>/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import type { CoreHost } from '../src/core/contracts';
import type { BoogieEventName } from '../src/shared/api';

const ROOT = resolve(import.meta.dirname, '..');
const TEMPLATES = join(ROOT, 'research/sandbox/templates');
const FIXTURES = join(ROOT, 'test/fixtures/libraries');

/** Every core event, forwarded to the page. The check fails the build if the contract gains one. */
const EVENTS = [
  'library',
  'itemsChanged',
  'itemsAdded',
  'itemsRemoved',
  'counts',
  'job',
  'history',
  'status',
  'reveal',
] as const satisfies readonly BoogieEventName[];
const _allEvents: Exclude<BoogieEventName, (typeof EVENTS)[number]> extends never ? true : never =
  true;
void _allEvents;

/** The core hands out boogie:// URLs; a plain browser can't load that scheme. */
const toWeb = (json: string) =>
  json.replace(/boogie:\/\/(thumb|file|preview)\//g, '/__dev/files/$1/');

/** Uint8Array arguments (importBytes, setCustomThumbnailBytes) arrive as {$bytes: base64}. */
const revive = (_k: string, v: unknown) =>
  v && typeof v === 'object' && typeof (v as { $bytes?: unknown }).$bytes === 'string'
    ? new Uint8Array(Buffer.from((v as { $bytes: string }).$bytes, 'base64'))
    : v;

function template(name: string): string {
  const own = join(TEMPLATES, name);
  return existsSync(own) ? own : join(FIXTURES, name);
}

/** A fresh copy of each library in `dir` (reflinked, so a 6 GB library copies in under a second). */
function stage(dir: string, sources: string[], reuse: boolean): string[] {
  const devRoot = join(ROOT, '.tmp', 'dev') + sep;
  if (!resolve(dir).startsWith(devRoot)) throw new Error(`[dev] refusing to stage in ${dir}`);
  const copies = sources.map((s) => join(dir, basename(s)));
  if (reuse && copies.every((c) => existsSync(c))) return copies;
  rmSync(dir, { recursive: true, force: true }); // only ever .tmp/dev/<port>, checked above
  mkdirSync(dir, { recursive: true });
  for (const [i, src] of sources.entries()) {
    if (!existsSync(join(src, 'metadata.json'))) throw new Error(`[dev] not a library: ${src}`);
    execFileSync('cp', ['-a', '--reflink=auto', src, copies[i]]);
  }
  return copies;
}

export function devBackend(): Plugin {
  return {
    name: 'boogie-dev-backend',
    async configureServer(server: ViteDevServer) {
      const t0 = performance.now();
      // Vite restarts the server when this file changes, re-running this with a fresh module:
      // the last run's core must let go of the copy before it's replaced.
      const g = globalThis as { __boogieDevHost?: CoreHost };
      await g.__boogieDevHost?.close().catch(() => {});
      const port = server.config.server.port ?? 5200;
      const dir = join(ROOT, '.tmp', 'dev', String(port));
      const main = resolve(process.env.BOOGIE_DEV_LIBRARY ?? template('art-archive.library'));
      // A second, small library so switching libraries can be tried.
      const other = template('sample.library');
      const sources = main === other ? [main] : [main, other];
      const [mainCopy, ...otherCopies] = stage(dir, sources, process.env.BOOGIE_DEV_REUSE === '1');

      // Before the core loads: its write guard reads these once. Only the copy is writable, and
      // protected places (Dropbox, mounted drives) stay blocked whatever the shell had set.
      const home = join(dir, 'home');
      process.env.BOOGIE_HOME = home;
      process.env.BOOGIE_WRITABLE_ROOTS = dir;
      delete process.env.BOOGIE_ALLOW_PROTECTED;

      const load = (p: string) => server.ssrLoadModule(join(ROOT, p));
      const { createCoreHost } = await load('src/core/service/index.ts');
      const { createDispatcher } = await load('src/app/dispatch.ts');
      const { ExportJobs } = await load('src/app/exporter.ts');
      const { createProtocolHandler } = await load('src/app/protocol.ts');
      const { urlsFromClipboardText } = await load('src/app/links.ts');

      // Discovery must not read your real Eagle settings or ~/Dropbox.
      const host: CoreHost = await createCoreHost({
        discovery: { home, settingsFiles: [], dropboxDir: join(home, 'no-dropbox') },
      });
      g.__boogieDevHost = host;
      host.setPorts({ reason: 'Web dev server: no Eagle API or MCP' });
      for (const lib of [mainCopy, ...otherCopies]) await host.api.addLibrary(lib);
      const readOnly = process.env.BOOGIE_DEV_READONLY === '1';
      await host.api.openLibrary(mainCopy, readOnly ? { readOnly } : undefined);
      console.log(
        `[dev] real core on ${mainCopy}${readOnly ? ' (read-only)' : ''}, ready in ${Math.round(performance.now() - t0)} ms`,
      );

      const clients = new Set<ServerResponse>();
      const send = (event: string, payload: unknown) => {
        const data = `data: ${toWeb(JSON.stringify({ event, payload }))}\n\n`;
        for (const c of clients) c.write(data);
      };
      for (const name of EVENTS) host.on(name, (p: unknown) => send(name, p));

      // Stand-ins for what needs Electron. Pickers answer a fixed folder, the clipboard lives in
      // memory (what Copy put there, Paste finds), and the shell calls only log.
      const note =
        (what: string) =>
        async (_ctx: unknown, ...a: unknown[]) =>
          void console.log(`[dev] ${what} (desktop only)`, JSON.stringify(a).slice(0, 160));
      let clipboard: { paths: string[]; text: string } = { paths: [], text: '' };
      const exportJobs = new ExportJobs(host, (job: unknown) => send('job', job));
      const app = {
        pickLibraryFolder: async () => otherCopies[0] ?? null,
        pickDirectory: async () => {
          const picked = join(dir, 'picked');
          mkdirSync(picked, { recursive: true });
          return picked;
        },
        pickFiles: async () => [],
        startDrag: note('startDrag'),
        copyItems: async (_ctx: unknown, ids: string[]) => {
          const paths = await Promise.all(ids.map((id) => host.originalPath(id)));
          clipboard = { paths: paths.filter((p): p is string => !!p), text: '' };
        },
        copyText: async (_ctx: unknown, text: string) => void (clipboard = { paths: [], text }),
        readClipboardForImport: async () => ({
          paths: clipboard.paths,
          image: null,
          urls: clipboard.paths.length ? [] : urlsFromClipboardText(clipboard.text),
        }),
        revealItem: note('revealItem'),
        openItemWithDefaultApp: note('openItemWithDefaultApp'),
        openExternalUrl: note('openExternalUrl'),
        exportItems: (_ctx: unknown, ids: string[], out: string, o?: object) =>
          exportJobs.start(ids, out, o),
        showFolder: note('showFolder'),
        openReferenceWindow: note('openReferenceWindow'),
        getPathForFile: () => '',
        windowControl: note('windowControl'),
      };
      const dispatch = createDispatcher({
        api: host.api,
        app,
        exports: exportJobs,
        onSettingsChanged: () => {},
      });
      const files = createProtocolHandler(host);

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? '';
        if (url.startsWith('/__dev/rpc')) {
          let body = '';
          for await (const chunk of req) body += chunk;
          res.setHeader('content-type', 'application/json');
          try {
            const { method, args } = JSON.parse(body, revive);
            const result = await dispatch(null, method, args ?? []);
            res.end(toWeb(JSON.stringify({ result: result ?? null })));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
          return;
        }
        if (url.startsWith('/__dev/events')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write(': hi\n\n');
          clients.add(res);
          res.on('close', () => clients.delete(res));
          return;
        }
        if (url.startsWith('/__dev/files/')) {
          const r: Response = await files(
            new Request(`boogie://${url.slice('/__dev/files/'.length)}`, {
              method: req.method,
              headers: req.headers.range ? { range: req.headers.range } : {},
            }),
          );
          res.writeHead(r.status, Object.fromEntries(r.headers));
          if (r.body && req.method !== 'HEAD') Readable.fromWeb(r.body as never).pipe(res);
          else res.end();
          return;
        }
        next();
      });
      server.httpServer?.on('close', () => void host.close());
    },
  };
}
