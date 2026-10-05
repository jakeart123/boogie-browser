// The Eagle-compatible servers on the REAL core host (src/core/service/testSandbox.ts): every add,
// read and write goes through the real service into a sandbox library copy under .tmp/http, so
// these tests prove what lands in the library, not what a fake recorded. Servers bind port 0.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryEntry, JobProgress } from '../../shared/types';
import { openSandbox, sandboxAvailable, type Sandbox } from '../service/testSandbox';
import type { CompatServer, CompatServerOptions } from './index';
import { startEagleCompatServer } from './index';
import { eagleFolder } from './shapes';

const running: { srv: CompatServer; sb: Sandbox }[] = [];
afterEach(async () => {
  for (const { srv, sb } of running.splice(0)) {
    await srv.close();
    await sb.close();
  }
});

async function boot(
  o: { sandbox?: Parameters<typeof openSandbox>[0]; server?: CompatServerOptions } = {},
) {
  const sb = await openSandbox({ area: 'http', ...o.sandbox });
  const srv = await startEagleCompatServer(sb.host, {
    apiPort: 0,
    extPort: 0,
    log: () => {},
    ...o.server,
  });
  running.push({ srv, sb });
  return { sb, srv, api: srv.apiPort as number, ext: srv.extPort as number };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A raw request, so tests can set Host and Origin freely (fetch may not let them). */
function call(
  port: number,
  method: string,
  path: string,
  o: {
    headers?: Record<string, string>;
    body?: string | object;
    host?: string;
    hostname?: string;
  } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...o.headers };
    let payload: string | undefined;
    if (typeof o.body === 'string') payload = o.body;
    else if (o.body) {
      payload = JSON.stringify(o.body);
      headers['Content-Type'] ??= 'application/json';
    }
    if (o.host !== undefined) headers.Host = o.host;
    const req = http.request(
      { host: o.hostname ?? '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** What the browser extension sends: a form post, with its own Origin. */
const extPost = (port: number, fields: Record<string, string>, path = '/') =>
  call(port, 'POST', path, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'chrome-extension://abcdefgh',
    },
    body: new URLSearchParams(fields).toString(),
  });

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPG = 'images/LT24XY3DPJFLK.info/0051.jpg'; // a real photo in the sample library

/** Copies of a real photo outside the library, to add by path. */
function sourceFiles(sb: Sandbox, sub: string, names: string[]): string[] {
  const dir = join(sb.dir, sub);
  mkdirSync(dir, { recursive: true });
  return names.map((n) => {
    copyFileSync(join(sb.libPath, JPG), join(dir, n));
    return join(dir, n);
  });
}

const history = (sb: Sandbox): Promise<HistoryEntry[]> => sb.host.api.listHistory();
const imports = async (sb: Sandbox): Promise<JobProgress[]> =>
  (await sb.host.api.listJobs()).filter((j) => j.kind === 'import');
const allIds = async (sb: Sandbox) =>
  (await sb.host.api.query({ scope: { kind: 'all' }, filter: {}, sort: null })).ids;

/** Wait until every import job has finished; returns the new item ids since `before`. */
async function settled(sb: Sandbox, before: string[]): Promise<string[]> {
  for (const j of await imports(sb)) await sb.job(j.jobId);
  const had = new Set(before);
  return (await allIds(sb)).filter((id) => !had.has(id));
}

describe.skipIf(!sandboxAvailable)('the Eagle-compatible servers on the real core', () => {
  describe('handshake and who may talk to us', () => {
    it('answers like Eagle 4 on both ports, marks its info answers as Boogie, and has no dangerous endpoints', async () => {
      const { sb, api, ext } = await boot();
      for (const path of ['/', '/api/application/info']) {
        const r = await call(api, 'GET', path);
        expect(r.json.status).toBe('success');
        const d = r.json.data;
        expect(d.version).toBe('4.0.0');
        expect(parseInt(d.buildVersion, 10)).toBeGreaterThanOrEqual(20241106);
        expect(d.preferences.notification.notification.when.extension).toBe('true');
        expect(d.boogie).toBe(true);
        expect(r.text.toLowerCase()).not.toContain('token');
      }
      // The Eagle monitor asks this route which library "Eagle" has open: it must see it's us.
      const info = (await call(api, 'GET', '/api/library/info')).json.data;
      expect(info.boogie).toBe(true);
      expect(info.library.path).toBe(sb.libPath);
      const old = await call(ext, 'GET', '/');
      expect(old.json.showCollectModal).toBe(false);
      expect(old.json.data.showCollectModal).toBe(false);
      expect(
        (await call(api, 'POST', '/api/script/inject', { body: { script: 'alert(1)' } })).status,
      ).toBe(404);
      expect((await call(api, 'GET', '/api/check?url=http://x')).status).toBe(404);
    });

    it('refuses web-page origins and foreign Host headers, and nothing reaches the library', async () => {
      const { sb, api, ext } = await boot();
      const [id] = sb.itemIds;
      const routes: [number, string, string][] = [
        [api, 'GET', '/'],
        [api, 'GET', '/api/library/info'],
        [api, 'GET', '/api/item/list'],
        [api, 'GET', `/item?id=${id}`],
        [api, 'POST', '/api/item/addFromURL'],
        [api, 'POST', '/api/item/moveToTrash'],
        [api, 'POST', '/api/v2/item/add'],
        [ext, 'GET', '/'],
        [ext, 'POST', '/'],
      ];
      for (const origin of ['https://evil.example', 'http://localhost:41595', 'null', 'file://']) {
        for (const [port, method, path] of routes) {
          const r = await call(port, method, path, {
            headers: { Origin: origin },
            body:
              method === 'POST'
                ? { url: PNG_DATA_URL, type: 'image', src: PNG_DATA_URL, itemIds: [id] }
                : undefined,
          });
          expect(r.status, `${origin} ${method} ${path}`).toBe(403);
          expect(r.headers['access-control-allow-origin']).toBeUndefined();
        }
      }
      // A cross-site "simple" POST (text/plain) is refused too.
      const plain = await call(api, 'POST', '/api/item/addFromURL', {
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
        body: JSON.stringify({ url: PNG_DATA_URL }),
      });
      expect(plain.status).toBe(403);

      // DNS rebinding: the Host must be a loopback name on the port that was reached.
      for (const host of [
        'evil.example',
        `evil.example:${api}`,
        `localhost:${api + 1}`,
        'localhost',
      ])
        expect((await call(api, 'GET', '/', { host })).status, host).toBe(403);
      for (const host of [`localhost:${api}`, `127.0.0.1:${api}`, `LOCALHOST:${api}`])
        expect((await call(api, 'GET', '/', { host })).status, host).toBe(200);
      const hasV6 = Object.values(networkInterfaces())
        .flat()
        .some((i) => i?.address === '::1');
      if (hasV6) {
        const v6 = await call(api, 'GET', '/', { hostname: '::1', host: `[::1]:${api}` });
        expect(v6.status).toBe(200);
      }

      expect(await history(sb)).toEqual([]);
      expect(await allIds(sb)).toHaveLength(sb.itemIds.length);
      expect(sb.read(id).isDeleted).toBe(false);
    });

    it('allows no Origin and extension origins (echoed, never *), and answers their preflight', async () => {
      const { api } = await boot();
      const none = await call(api, 'GET', '/api/folder/list');
      expect(none.status).toBe(200);
      expect(none.headers['access-control-allow-origin']).toBeUndefined();
      for (const origin of [
        'chrome-extension://abcdefghijklmnop',
        'moz-extension://1234-abcd',
        'app://obsidian.md',
      ]) {
        const r = await call(api, 'GET', '/api/folder/list', { headers: { Origin: origin } });
        expect(r.status, origin).toBe(200);
        expect(r.headers['access-control-allow-origin']).toBe(origin);
        expect(r.headers.vary).toBe('Origin');
      }
      const pre = await call(api, 'OPTIONS', '/api/item/addFromURL', {
        headers: {
          Origin: 'chrome-extension://abc',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe('chrome-extension://abc');
      expect(pre.headers['access-control-allow-headers']).toBe('content-type');
      const evil = await call(api, 'OPTIONS', '/', { headers: { Origin: 'https://evil.example' } });
      expect(evil.status).toBe(403);
    });

    it('refuses a wildcard address, and reports a busy port while serving the other one', async () => {
      const { sb } = await boot();
      await expect(
        startEagleCompatServer(sb.host, { apiPort: 0, extPort: 0, bind: '0.0.0.0' }),
      ).rejects.toThrow(/loopback/);
      const blocker = net.createServer();
      await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
      const busy = (blocker.address() as net.AddressInfo).port;
      try {
        const srv = await startEagleCompatServer(sb.host, {
          apiPort: busy,
          extPort: 0,
          log: () => {},
        });
        try {
          expect(srv.apiPort).toBeNull();
          expect(srv.reason).toBe(`Eagle is using port ${busy}`);
          expect((await call(srv.extPort as number, 'GET', '/')).status).toBe(200);
        } finally {
          await srv.close();
        }
      } finally {
        await new Promise((r) => blocker.close(r));
      }
    });

    it('caps the body, rejects bodies that are not JSON or a form, and drops a stalled connection', async () => {
      const { sb, api } = await boot({ server: { maxBodyBytes: 2000, timeoutMs: 300 } });
      const big = await call(api, 'POST', '/api/item/addFromURL', {
        body: { url: PNG_DATA_URL, annotation: 'x'.repeat(5000) },
      });
      expect(big.status).toBe(413);
      const bad = await call(api, 'POST', '/api/item/addFromURL', {
        body: '{not json',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(bad.status).toBe(400);
      expect((await call(api, 'GET', '/')).status).toBe(200); // still serving
      expect(await imports(sb)).toEqual([]);

      const closedAfter = await new Promise<number>((resolve) => {
        const t0 = Date.now();
        const sock = net.connect(api, '127.0.0.1', () =>
          sock.write(
            `POST /api/item/addFromURL HTTP/1.1\r\nHost: 127.0.0.1:${api}\r\nContent-Length: 50\r\n\r\n{`,
          ),
        );
        sock.on('data', () => undefined);
        sock.on('close', () => resolve(Date.now() - t0));
      });
      expect(closedAfter).toBeLessThan(3000);
    });
  });

  describe('adding files', () => {
    it('addFromPath lands with name, date added, tags, note, rating, website and every folder, as ONE history entry by the caller', async () => {
      const { sb, api } = await boot();
      const refs = await sb.host.api.createFolder('Refs', null);
      await sb.host.api.updateFolder(refs.id, { tags: ['ref'] });
      const other = await sb.host.api.createFolder('Other', null);
      const [file] = sourceFiles(sb, 'src', ['0-11.jpg']);
      const entries = (await history(sb)).length;

      const r = await call(api, 'POST', '/api/item/addFromPath', {
        body: {
          path: file,
          name: 'Named By API',
          modificationTime: 1600000000000,
          tags: ['cat'],
          annotation: 'a note',
          star: 4,
          website: 'https://example.com/page',
          folderIds: [refs.id, 'GONE', other.id],
        },
      });
      expect(r.json.status).toBe('success');
      const rec = sb.read(r.json.data);
      expect(rec).toMatchObject({
        name: 'Named By API',
        modificationTime: 1600000000000,
        annotation: 'a note',
        star: 4,
        url: 'https://example.com/page',
      });
      expect(rec.tags).toEqual(expect.arrayContaining(['cat', 'ref'])); // Refs' auto-tag too
      expect([...rec.folders].sort()).toEqual([refs.id, other.id].sort());
      const after = await history(sb);
      expect(after).toHaveLength(entries + 1); // no second "Added to" entry for the extra folder
      expect(after[0]).toMatchObject({
        kind: 'import',
        actor: { kind: 'agent', name: 'Eagle API client' },
        itemIds: [r.json.data],
      });

      const rel = await call(api, 'POST', '/api/item/addFromPath', { body: { path: 'x.png' } });
      expect(rel.status).toBe(400);
    });

    it('refuses an add whose folders are all from another library, instead of adding it unfiled', async () => {
      const { sb, api } = await boot();
      const [file] = sourceFiles(sb, 'src', ['0-11.jpg']);
      const entries = (await history(sb)).length;
      const r = await call(api, 'POST', '/api/item/addFromPath', {
        body: { path: file, folderId: 'FOLDER-FROM-ANOTHER-LIBRARY' },
      });
      expect(r.status).toBe(400);
      expect(r.json.message).toMatch(/None of those folders/);
      expect(await history(sb)).toHaveLength(entries);
    });

    it('file: URLs: never from the browser extension, never a folder, only a file for local clients', async () => {
      const { sb, api, ext } = await boot();
      const home = join(sb.dir, 'someones-home');
      const [a] = sourceFiles(sb, 'someones-home/Pictures', ['a.jpg', 'b.jpg']);
      sourceFiles(sb, 'someones-home/Documents', ['c.jpg']);
      const folderUrl = pathToFileURL(home).href + '/';
      const fileUrl = pathToFileURL(a).href;

      // The reviewer's case: a page's image src pointing at a home folder imported all of it.
      const fromPage = await extPost(ext, { type: 'image', src: folderUrl, url: 'https://e.x/p' });
      expect(fromPage.status).toBe(400);
      expect((await extPost(ext, { type: 'image', src: fileUrl })).status).toBe(400);
      const images = JSON.stringify([{ src: 'https://e.x/1.png' }, { src: fileUrl }]);
      expect((await extPost(ext, { type: 'import-images', images })).status).toBe(400);
      // An extension Origin on the API port is the extension too.
      const viaApi = await call(api, 'POST', '/api/item/addFromURL', {
        headers: { Origin: 'chrome-extension://abcdefgh' },
        body: { url: fileUrl },
      });
      expect(viaApi.status).toBe(400);
      // Nor a plain path, on any route that takes one.
      const [item] = sb.itemIds;
      for (const [route, body] of [
        ['/api/item/addFromPath', { path: a }],
        ['/api/item/addFromPaths', { paths: [a] }],
        ['/api/v2/item/add', { path: a }],
        ['/api/item/setCustomThumbnail', { id: item, thumbnailPath: a }],
        ['/api/v2/item/setCustomThumbnail', { itemId: item, filePath: a }],
      ] as const) {
        const r = await call(api, 'POST', route, {
          headers: { Origin: 'chrome-extension://abcdefgh' },
          body,
        });
        expect([r.status, r.json.message], route).toEqual([
          400,
          expect.stringMatching(/extension/),
        ]);
      }
      // Local clients may name a file, never a folder.
      for (const [route, body] of [
        ['/api/item/addFromURL', { url: folderUrl }],
        ['/api/item/addFromPath', { path: home }],
        ['/api/v2/item/add', { path: home }],
        ['/api/v2/item/add', { items: [{ path: a }, { path: home }] }],
      ] as const) {
        expect((await call(api, 'POST', route, { body })).status, route).toBe(400);
      }
      expect(await imports(sb)).toEqual([]);

      const ok = await call(api, 'POST', '/api/item/addFromURL', { body: { url: fileUrl } });
      expect(ok.json.status).toBe('success');
      expect(await settled(sb, sb.itemIds)).toHaveLength(1);
    });

    it("extension saves: an image with its page as referer, a screen capture, a bookmark, and 'save all' as ONE job and ONE history entry", async () => {
      const { sb, ext } = await boot();
      const folder = await sb.host.api.createFolder('Inbox', null);
      const jpg = readFileSync(join(sb.libPath, JPG));
      const seen: { url?: string; referer?: string }[] = [];
      const images = http.createServer((req, res) => {
        seen.push({ url: req.url, referer: req.headers.referer });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length });
        res.end(jpg);
      });
      await new Promise<void>((r) => images.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(images.address() as net.AddressInfo).port}`;
      try {
        const saved = await extPost(ext, {
          type: 'image',
          src: `${base}/pics/great%20painting.jpg`,
          title: 'Great painting',
          url: 'https://example.org/gallery',
          annotation: 'from the extension',
          star: '3',
          'tags[0]': 'one',
          'tags[1]': 'two words',
          'folderIDs[0]': folder.id,
        });
        expect(saved.json).toEqual({ status: 'success' });
        const [id] = await settled(sb, sb.itemIds);
        expect(sb.read(id)).toMatchObject({
          name: 'Great painting',
          url: 'https://example.org/gallery',
          annotation: 'from the extension',
          star: 3,
          tags: ['one', 'two words'],
          folders: [folder.id],
        });
        expect(seen[0]).toEqual({
          url: '/pics/great%20painting.jpg',
          referer: 'https://example.org/gallery',
        });
        expect((await history(sb))[0].actor).toEqual({ kind: 'user', name: 'Browser extension' });

        const shot = await extPost(ext, {
          type: 'screen capture',
          title: 'Shot',
          url: 'https://e.com',
          base64: PNG_DATA_URL,
          'tags[0]': 't',
        });
        expect(shot.json.status).toBe('success');
        const bookmark = await extPost(ext, {
          type: 'save-url',
          title: 'A page',
          url: 'https://e.com/p',
          base64: PNG_DATA_URL,
        });
        expect(bookmark.json.status).toBe('success');
        const two = await settled(sb, [...sb.itemIds, id]);
        const byName = new Map(two.map((x) => [sb.read(x).name, sb.read(x)]));
        expect(byName.get('Shot')).toMatchObject({ url: 'https://e.com', tags: ['t'] });
        expect(byName.get('A page')).toMatchObject({ ext: 'url', url: 'https://e.com/p' });

        const jobs = (await imports(sb)).length;
        const entries = (await history(sb)).length;
        const all = await allIds(sb);
        const gallery = JSON.stringify([
          { src: `${base}/1.jpg`, title: 'One' },
          { src: `${base}/2.jpg 2x`, title: 'Two' },
        ]);
        const many = await extPost(ext, {
          type: 'import-images',
          url: 'https://e.com/gallery',
          title: 'Gallery',
          images: gallery,
        });
        expect(many.json.status).toBe('success');
        const added = await settled(sb, all);
        expect(added.map((x) => sb.read(x).name).sort()).toEqual(['One', 'Two']);
        expect(sb.read(added[0]).url).toBe('https://e.com/gallery');
        expect(
          seen
            .slice(-2)
            .map((s) => s.url)
            .sort(),
        ).toEqual(['/1.jpg', '/2.jpg']);
        expect(await imports(sb)).toHaveLength(jobs + 1);
        const log = await history(sb);
        expect(log).toHaveLength(entries + 1);
        expect(log[0]).toMatchObject({ kind: 'import', itemCount: 2 });

        expect((await extPost(ext, { type: 'nope' })).status).toBe(400);
        expect((await extPost(ext, { type: 'image' })).json.status).toBe('error');
      } finally {
        await new Promise((r) => images.close(r));
      }
    });

    it('v2 item/add answers with the new id; a batch (v2 or v1 addFromPaths) answers one id per entry from ONE job and ONE history entry', async () => {
      const { sb, api } = await boot();
      const f = await sb.host.api.createFolder('Target', null);
      const [p1, p2, p3] = sourceFiles(sb, 'src', ['p1.jpg', 'p2.jpg', 'p3.jpg']);

      const one = await call(api, 'POST', '/api/v2/item/add', {
        body: { url: PNG_DATA_URL, name: 'n', tags: ['a'], folders: [f.id] },
      });
      expect(sb.read(one.json.data.id)).toMatchObject({ name: 'n', tags: ['a'], folders: [f.id] });

      const jobs = (await imports(sb)).length;
      const entries = (await history(sb)).length;
      const batch = await call(api, 'POST', '/api/v2/item/add', {
        body: {
          items: [
            { url: PNG_DATA_URL, name: 'A' },
            { bookmarkURL: 'https://e.com', name: 'Site' },
            { path: p1, name: 'P' },
          ],
          folders: [f.id],
        },
      });
      const ids: string[] = batch.json.data.ids;
      expect(ids.map((id) => sb.read(id).name)).toEqual(['A', 'Site', 'P']);
      expect(ids.every((id) => sb.read(id).folders.includes(f.id))).toBe(true);
      expect(await imports(sb)).toHaveLength(jobs + 1);
      expect(await history(sb)).toHaveLength(entries + 1);

      const paths = await call(api, 'POST', '/api/item/addFromPaths', {
        body: {
          items: [
            { path: p2, name: 'X', tags: ['x'] },
            { path: p3, name: 'Y' },
          ],
        },
      });
      const pathIds: string[] = paths.json.data;
      expect(pathIds.map((id) => sb.read(id).name)).toEqual(['X', 'Y']);
      expect(sb.read(pathIds[0]).tags).toEqual(['x']);
      expect(await imports(sb)).toHaveLength(jobs + 2);
      expect(await history(sb)).toHaveLength(entries + 2);
    });
    it('batch adds wait for the whole import (past the idle timeout), answer one id per path even for a repeat, and say so plainly at the cap', async () => {
      const { sb, api } = await boot({ server: { timeoutMs: 200 } });
      const files = sourceFiles(
        sb,
        'many',
        Array.from({ length: 40 }, (_, i) => `f${i}.jpg`),
      );
      const t0 = Date.now();
      const r = await call(api, 'POST', '/api/item/addFromPaths', {
        body: { paths: [...files, files[0]] },
      });
      const took = Date.now() - t0;
      expect(r.status, r.text).toBe(200);
      const ids: (string | null)[] = r.json.data;
      expect(ids).toHaveLength(41); // Eagle answers one id per path given
      expect(ids.every((id) => typeof id === 'string')).toBe(true);
      expect(new Set(ids.slice(0, 40)).size).toBe(40);
      expect(took).toBeGreaterThan(200); // so the reply really outlived the idle timer

      // The same core behind a server that gives up at once.
      const quick = await startEagleCompatServer(sb.host, {
        apiPort: 0,
        extPort: 0,
        log: () => {},
        jobWaitMs: 1,
      });
      try {
        const before = await allIds(sb);
        const more = sourceFiles(sb, 'more', ['m1.jpg', 'm2.jpg', 'm3.jpg']);
        const capped = await call(quick.apiPort as number, 'POST', '/api/v2/item/add', {
          body: { items: more.map((path) => ({ path })) },
        });
        expect([capped.status, capped.json.message]).toEqual([
          500,
          expect.stringMatching(/^Still importing .*appear in the library when the import is done/),
        ]);
        expect(await settled(sb, before)).toHaveLength(3); // the files still land
      } finally {
        await quick.close();
      }
    });
  });

  describe('reading and editing', () => {
    it('library, folders, tags and items come back in Eagle shapes', async () => {
      const { sb, api } = await boot();
      const [a, b, c] = sb.itemIds;
      const refs = await sb.host.api.createFolder('Refs', null);
      await sb.host.api.updateFolder(refs.id, { tags: ['ref'] });
      const sub = await sb.host.api.createFolder('Sub', refs.id);
      await sb.host.api.updateFolder(sub.id, { tags: ['sub'] });
      await sb.host.api.updateItems([a, b], { addTags: ['dog'] });
      await sb.host.api.updateItems([c], { addTags: ['cat'] });
      await sb.host.api.upsertTagGroup({ name: 'Pets', tags: ['dog'], color: '#ff0000' });
      const conditions = [
        { match: 'AND' as const, rules: [{ property: 'tags', method: 'contain', value: ['dog'] }] },
      ];
      await sb.host.api.createSmartFolder('Dogs', conditions);

      const lib = (await call(api, 'GET', '/api/library/info')).json.data;
      expect(lib.library).toEqual({ path: sb.libPath, name: 'Test' });
      expect(lib.applicationVersion).toBe('4.0.0');
      expect(lib.tagsGroups[0]).toMatchObject({ name: 'Pets', tags: ['dog'], color: '#ff0000' });
      const smart = lib.smartFolders[0];
      expect(Object.keys(smart)).toEqual([
        'id',
        'name',
        'description',
        'modificationTime',
        'conditions',
        'children',
      ]);
      expect(smart.modificationTime).toBeGreaterThan(0);

      const folders = (await call(api, 'GET', '/api/folder/list')).json.data;
      const refsOut = folders.find((f: { id: string }) => f.id === refs.id);
      expect(refsOut.children[0].extendTags).toEqual(['ref', 'sub']); // own tags plus ancestors'

      const tags = (await call(api, 'GET', '/api/tag/list')).json.data;
      const pets = (await sb.host.api.getLibraryState())!.tagGroups[0].id;
      expect(tags.find((t: { name: string }) => t.name === 'dog')).toMatchObject({
        imageCount: 2,
        groups: [pets],
        color: '#ff0000',
      });
      const all = (await call(api, 'GET', '/api/tag/all')).json.data;
      expect(Object.keys(all).sort()).toEqual(['groups', 'recent', 'starred', 'tags']);

      const item = (await call(api, 'GET', `/api/item/info?id=${c}`)).json.data;
      const rec = sb.read(c);
      expect(item).toMatchObject({
        id: c,
        name: rec.name,
        ext: rec.ext,
        width: rec.width,
        tags: rec.tags,
        modificationTime: rec.modificationTime,
        lastModified: rec.lastModified,
      });
      expect('star' in item).toBe(rec.star !== undefined); // unrated items carry no star, like Eagle
      expect((await call(api, 'GET', '/api/item/info?id=NOPE')).status).toBe(404);
      // Eagle URI-encodes the file name part of the thumbnail path; clients decode it.
      const thumb: string = (await call(api, 'GET', `/api/item/thumbnail?id=${c}`)).json.data;
      expect(existsSync(join(dirname(thumb), decodeURIComponent(basename(thumb))))).toBe(true);
    });

    it('never shows the children or the password of a password-protected folder', () => {
      const node = {
        id: 'F2',
        name: 'Locked',
        description: '',
        children: [],
        tags: [],
        icon: null,
        iconColor: null,
        coverId: null,
        orderBy: null,
        sortIncrease: null,
        hasPassword: true,
        modificationTime: 1,
      };
      const out = eagleFolder({ ...node, children: [{ ...node, id: 'F2A', hasPassword: false }] });
      expect(out.children).toEqual([]);
      expect(out.password).toBe('locked');
    });

    it('item/list and v2 item/get page, sort and filter through the real query', async () => {
      const { sb, api } = await boot();
      const newest = (
        await sb.host.api.query({
          scope: { kind: 'all' },
          filter: {},
          sort: { by: 'IMPORT', ascending: false },
        })
      ).ids;
      const ids = (r: Res) => r.json.data.map((i: { id: string }) => i.id);
      // v1 paging: `offset` is a PAGE number (limit 3, offset 1 = the 4th to 6th).
      expect(ids(await call(api, 'GET', '/api/item/list?limit=3&offset=1'))).toEqual(
        newest.slice(3, 6),
      );
      const names = (await call(api, 'GET', '/api/item/list?orderBy=-NAME')).json.data.map(
        (i: { name: string }) => i.name,
      );
      expect(names).toHaveLength(newest.length);
      expect(names[0].localeCompare(names[names.length - 1])).toBeGreaterThanOrEqual(0);
      await sb.host.api.updateItems(newest.slice(0, 2), { addTags: ['dog'] });
      expect(ids(await call(api, 'GET', '/api/item/list?tags=dog')).sort()).toEqual(
        newest.slice(0, 2).sort(),
      );

      const p1 = (await call(api, 'GET', '/api/v2/item/get')).json.data;
      expect([p1.data.length, p1.total, p1.offset, p1.limit]).toEqual([11, 11, 0, 50]);
      expect(existsSync(p1.data[0].filePath)).toBe(true);
      const p2 = (await call(api, 'POST', '/api/v2/item/get', { body: { offset: 5, limit: 5000 } }))
        .json.data;
      expect([p2.data.length, p2.offset, p2.limit]).toEqual([6, 5, 1000]);
      const two = newest.slice(0, 2).join(',');
      const some = (await call(api, 'GET', `/api/v2/item/get?ids=${two}&fields=id,tags`)).json.data;
      expect(some.data).toEqual(newest.slice(0, 2).map((id) => ({ id, tags: sb.read(id).tags })));
      const unfiled = (await call(api, 'GET', '/api/v2/item/get?isUnfiled=true')).json.data;
      expect(unfiled.total).toBe((await sb.host.api.getCounts()).uncategorized);
      expect((await call(api, 'GET', '/api/v2/item/countAll')).json.data).toBe(11);
    });

    it('v1 and v2 writes land on disk as the caller, and v2 folder/update only changes what it was given', async () => {
      const { sb, api } = await boot();
      const [a, b] = sb.itemIds;
      const made = await call(api, 'POST', '/api/folder/create', { body: { folderName: 'Fresh' } });
      expect(made.json.data).toMatchObject({ name: 'Fresh', children: [], isExpand: true });
      const fresh = made.json.data.id;
      const bad = await call(api, 'POST', '/api/folder/create', {
        body: { folderName: 'X', parent: 'NOPE' },
      });
      expect(bad.status).toBe(404);
      expect((await call(api, 'POST', '/api/folder/create', { body: {} })).status).toBe(400);
      const sub = (
        await call(api, 'POST', '/api/v2/folder/create', {
          body: { name: 'Sub', parent: fresh, iconColor: 'red' },
        })
      ).json.data;
      expect(sub).toMatchObject({ name: 'Sub', parent: fresh, iconColor: 'red' });

      await call(api, 'POST', '/api/folder/update', {
        body: { folderId: fresh, newName: 'Renamed', newColor: 'blue', newDescription: 'd' },
      });
      const state = async () => (await sb.host.api.getLibraryState())!;
      expect((await state()).folders.find((f) => f.id === fresh)).toMatchObject({
        name: 'Renamed',
        iconColor: 'blue',
        description: 'd',
      });
      const entries = (await history(sb)).length;
      await call(api, 'POST', '/api/folder/update', {
        body: { folderId: fresh, newColor: 'chartreuse' },
      });
      expect(await history(sb)).toHaveLength(entries); // not a colour: nothing to change

      const upd = await call(api, 'POST', '/api/item/update', {
        body: { id: a, tags: ['x'], star: 0, annotation: 'hi', url: 'https://u' },
      });
      expect(upd.json.data.id).toBe(a);
      const rec = sb.read(a);
      expect(rec).toMatchObject({ tags: ['x'], annotation: 'hi', url: 'https://u' });
      expect('star' in rec).toBe(false);

      await call(api, 'POST', '/api/item/moveToTrash', {
        headers: { Origin: 'chrome-extension://abc' },
        body: { itemIds: [b] },
      });
      expect(sb.read(b).isDeleted).toBe(true);
      const log = await history(sb);
      expect(log[0].actor).toEqual({ kind: 'user', name: 'Browser extension' });
      expect(log[1].actor).toEqual({ kind: 'agent', name: 'Eagle API client' });
      expect(
        (await call(api, 'POST', '/api/item/moveToTrash', { body: { itemIds: [] } })).status,
      ).toBe(400);
      expect((await call(api, 'GET', '/api/item/moveToTrash')).status).toBe(405);

      // Eagle's raw v2 folder/update would drop Sub's colour and move it to the top here.
      await call(api, 'POST', '/api/v2/folder/update', { body: { id: sub.id, name: 'Sub 2' } });
      const renamed = (await state()).folders.find((f) => f.id === fresh)!.children[0];
      expect(renamed).toMatchObject({ id: sub.id, name: 'Sub 2', iconColor: 'red' });
      await call(api, 'POST', '/api/v2/folder/update', { body: { id: sub.id, parent: null } });
      expect((await state()).folders.some((f) => f.id === sub.id)).toBe(true);
      const loop = await call(api, 'POST', '/api/v2/folder/update', {
        body: { id: fresh, parent: sub.id },
      });
      expect(loop.status).toBe(200); // Sub is at the top now, so this is fine
      const into = await call(api, 'POST', '/api/v2/folder/update', {
        body: { id: sub.id, parent: fresh },
      });
      expect(into.status).toBe(400); // Fresh is inside Sub: a folder can't go inside itself

      const noFolder = await call(api, 'POST', '/api/v2/item/update', {
        body: { id: a, folders: ['NOPE'] },
      });
      expect(noFolder.status).toBe(400);
      const gone = await call(api, 'POST', '/api/v2/item/update', {
        body: { id: 'LT24XY3DPJFLZ', star: 1 },
      });
      expect(gone.json.data).toBe(false);
    });

    it('copy-link pages answer 200 for known ids and tell the app', async () => {
      const opened: unknown[] = [];
      const { sb, api } = await boot({ server: { onOpen: (t) => opened.push(t) } });
      const [id] = sb.itemIds;
      const folder = (await sb.host.api.getLibraryState())!.folders[0].id;
      const r = await call(api, 'GET', `/item?id=${id}`);
      expect(r.status).toBe(200);
      expect(r.text).toContain('Opened in Boogie Browser');
      expect((await call(api, 'GET', `/folder?id=${folder}`)).status).toBe(200);
      expect((await call(api, 'GET', '/folder?id=NOPE')).status).toBe(404);
      expect(opened).toEqual([
        { kind: 'item', id },
        { kind: 'folder', id: folder },
      ]);
    });
    it("the extension's collect-window switch is kept (across restarts) and reported where the extension reads it", async () => {
      const { sb, api, ext } = await boot();
      const shown = async (port: number) => (await call(port, 'GET', '/')).json;
      expect((await shown(api)).data.showCollectModal).toBe(false);
      expect((await call(api, 'GET', '/api/preferences/collect/on')).json).toEqual({
        status: 'success',
      });
      const info = (await call(api, 'GET', '/api/application/info')).json.data;
      expect(info).toMatchObject({
        showCollectModal: true,
        preferences: { general: { showCollectModal: 'true' } },
      });
      expect((await shown(ext)).showCollectModal).toBe(true); // the old-API probe on 41593
      const again = await startEagleCompatServer(sb.host, {
        apiPort: 0,
        extPort: 0,
        log: () => {},
      });
      try {
        expect((await shown(again.apiPort as number)).data.showCollectModal).toBe(true);
      } finally {
        await again.close();
      }
      await call(api, 'GET', '/api/preferences/collect/off');
      expect((await shown(ext)).showCollectModal).toBe(false);
    });

    it("starred and recent tags come from the library's tags.json (recent: this session's API tags first)", async () => {
      const { sb, api } = await boot({ sandbox: { open: false } });
      writeFileSync(
        join(sb.libPath, 'tags.json'),
        JSON.stringify({ historyTags: ['cat', 'gone tag'], starredTags: ['cat'] }),
      );
      await sb.host.api.openLibrary(sb.libPath);
      await sb.host.api.refresh({ full: true });
      await sb.host.api.updateItems([(await allIds(sb))[0]], { addTags: ['cat'] });
      const names = (list: { name: string }[]) => list.map((t) => t.name);
      const all = (await call(api, 'GET', '/api/tag/all')).json.data;
      expect(names(all.starred)).toEqual(['cat']);
      expect(all.starred[0].imageCount).toBe(1);
      expect(names(all.recent)).toEqual(['cat', 'gone tag']); // a tag no item has any more still shows

      const [file] = sourceFiles(sb, 'src', ['t.jpg']);
      await call(api, 'POST', '/api/item/addFromPath', { body: { path: file, tags: ['fresh'] } });
      expect(names((await call(api, 'GET', '/api/tag/listRecent')).json.data)).toEqual([
        'fresh',
        'cat',
        'gone tag',
      ]);
      const v2 = (await call(api, 'GET', '/api/v2/tag/getStarredTags')).json.data;
      expect([names(v2.data), v2.total]).toEqual([['cat'], 1]);
      expect((await call(api, 'GET', '/api/v2/tag/getRecentTags?limit=1')).json.data).toMatchObject(
        {
          data: [{ name: 'fresh' }],
          total: 3,
        },
      );
    });

    it("v2 tag, tag group and smart folder routes edit the library like Eagle's API; bad smart folder rules are refused", async () => {
      const { sb, api } = await boot();
      const [a, b, c] = sb.itemIds;
      await sb.host.api.updateItems([a, b], { addTags: ['dog'] });
      await sb.host.api.updateItems([c], { addTags: ['hound'] });
      const post = (path: string, body: object) => call(api, 'POST', `/api/v2/${path}`, { body });
      const root = () => JSON.parse(readFileSync(join(sb.libPath, 'metadata.json'), 'utf8'));

      // tag groups
      const made = (await post('tagGroup/create', { name: 'Pets', tags: ['dog'], color: 'red' }))
        .json.data;
      expect(made).toMatchObject({ name: 'Pets', tags: ['dog'], color: 'red' });
      expect(root().tagsGroups.map((g: { id: string }) => g.id)).toContain(made.id);
      await post('tagGroup/addTags', { groupId: made.id, tags: ['hound', 'cat'] });
      const less = (await post('tagGroup/removeTags', { groupId: made.id, tags: ['cat'] })).json
        .data;
      expect(less.tags).toEqual(['dog', 'hound']);
      expect(
        (await post('tagGroup/update', { id: made.id, name: 'Animals' })).json.data,
      ).toMatchObject({ name: 'Animals', tags: ['dog', 'hound'], color: 'red' });
      expect((await call(api, 'GET', '/api/v2/tagGroup/get')).json.data.total).toBe(1);

      // tags: rename, then merge
      expect(
        (await post('tag/update', { originalName: 'dog', name: 'Dog' })).json.data,
      ).toMatchObject({ name: 'Dog', imageCount: 2 });
      expect(sb.read(a).tags).toContain('Dog');
      expect((await post('tag/merge', { source: 'hound', target: 'Dog' })).json.data).toEqual({
        affectedItems: 1,
        sourceRemoved: true,
      });
      expect(sb.read(c).tags).toEqual(['Dog']);
      expect((await post('tag/merge', { source: 'nope', target: 'Dog' })).status).toBe(400);
      // Library-wide renames and removals are for local clients, not browser extensions.
      const fromExtension = (path: string, body: object) =>
        call(api, 'POST', `/api/v2/${path}`, {
          headers: { Origin: 'chrome-extension://abcdefgh' },
          body,
        });
      expect((await fromExtension('tagGroup/remove', { id: made.id })).status).toBe(403);
      expect((await fromExtension('tag/merge', { source: 'Dog', target: 'cat' })).status).toBe(403);
      expect((await post('tagGroup/remove', { id: made.id })).json.data).toBe(true);
      expect(root().tagsGroups).toEqual([]);
      // Only Eagle's color names reach the file.
      await post('tagGroup/create', { name: 'Odd', tags: ['Dog'], color: 'not-a-color<>' });
      expect(root().tagsGroups[0]).toEqual({ id: expect.any(String), name: 'Odd', tags: ['Dog'] });

      // smart folders
      const conditions = [
        {
          match: 'OR',
          junk: { deep: 1 }, // keys Eagle doesn't read never reach the file
          rules: [{ property: 'tags', method: 'union', value: ['Dog'], evil: 'x' }],
        },
      ];
      const sf = (await post('smartFolder/create', { name: 'Dogs', conditions, iconColor: 'blue' }))
        .json.data;
      expect(sf).toMatchObject({ name: 'Dogs', iconColor: 'blue' });
      expect(root().smartFolders[0].conditions).toEqual([
        {
          rules: [{ property: 'tags', method: 'union', value: ['Dog'] }],
          match: 'OR',
          boolean: 'TRUE',
        },
      ]);
      const inside = (await post('smartFolder/getItems', { smartFolderId: sf.id })).json.data;
      expect(inside.data.map((i: { id: string }) => i.id).sort()).toEqual([a, b, c].sort());
      for (const bad of [
        [{ match: 'AND', rules: [{ property: 'tags', method: 'contain', value: ['Dog'] }] }],
        [{ match: 'AND', rules: [{ property: 'nmae', method: 'contain', value: 'x' }] }],
        [{ match: 'AND', rules: [{ property: 'width', method: '>', value: 'big' }] }],
        // Eagle reads this as a pattern; "(" doesn't compile and would empty the folder there.
        [{ match: 'AND', rules: [{ property: 'name', method: 'startWith', value: '(WIP' }] }],
        Array.from({ length: 31 }, () => conditions[0]), // Eagle's cap is 30
        [],
      ]) {
        const r = await post('smartFolder/create', { name: 'Bad', conditions: bad });
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
      const renamed = await post('smartFolder/update', {
        id: sf.id,
        name: 'Good dogs',
        iconColor: '',
      });
      expect(renamed.json.data).toMatchObject({ name: 'Good dogs' });
      expect(renamed.json.data.iconColor).toBeUndefined();
      expect((await call(api, 'GET', `/api/v2/smartFolder/get?id=${sf.id}`)).json.data.total).toBe(
        1,
      );
      expect((await post('smartFolder/remove', { id: sf.id })).json.data).toBe(true);
      expect(root().smartFolders).toEqual([]);
      const log = await history(sb);
      expect(log[0].actor).toEqual({ kind: 'agent', name: 'Eagle API client' });
    });
  });

  describe('libraries and status codes', () => {
    it('lists known libraries, switches by path (a folder that is not a library is a 400), and serves icons only for known libraries', async () => {
      const { sb, api } = await boot();
      expect((await call(api, 'GET', '/api/library/history')).json.data).toEqual([sb.libPath]);
      writeFileSync(join(sb.libPath, 'icon.png'), 'PNGBYTES'); // our sandbox copy
      const icon = await call(
        api,
        'GET',
        `/api/library/icon?libraryPath=${encodeURIComponent(sb.libPath)}`,
      );
      expect([icon.status, icon.text, icon.headers['content-type']]).toEqual([
        200,
        'PNGBYTES',
        'image/png',
      ]);
      // Eagle would read icon.png under any path a caller names; we only serve known libraries.
      const other = await call(
        api,
        'GET',
        `/api/library/icon?libraryPath=${encodeURIComponent(sb.dir)}`,
      );
      expect(other.status).toBe(404);

      const sw = (p: string) =>
        call(api, 'POST', '/api/library/switch', { body: { libraryPath: p } });
      expect((await sw(sb.libPath)).json.status).toBe('success');
      const notLibrary = await sw(sb.dir);
      expect([notLibrary.status, notLibrary.json.message]).toEqual([
        400,
        expect.stringContaining("doesn't look like an Eagle library"),
      ]);
      expect((await sw(join(sb.dir, 'nope'))).status).toBe(400);
      expect((await sb.host.api.getLibraryState())?.ref.path).toBe(sb.libPath); // still open

      // v2: the same, in v2's shapes (the icon as a JSON-serialized Buffer, like Eagle's)
      const q = `libraryPath=${encodeURIComponent(sb.libPath)}`;
      const icon2 = (await call(api, 'GET', `/api/v2/library/icon?${q}`)).json.data;
      expect(Buffer.from(icon2.data).toString()).toBe('PNGBYTES');
      expect(icon2.type).toBe('Buffer');
      const sw2 = await call(api, 'POST', '/api/v2/library/switch', {
        body: { libraryPath: sb.libPath },
      });
      expect(sw2.json.data).toBe(true);
      expect(
        (await call(api, 'POST', '/api/v2/library/switch', { body: { libraryPath: sb.dir } }))
          .status,
      ).toBe(400);
    });

    it('says 503 when no library is open, and 409 with the reason when it is read-only', async () => {
      const closed = await boot({ sandbox: { open: false } });
      for (const path of ['/api/item/list', '/api/v2/item/get', '/api/library/info']) {
        const r = await call(closed.api, 'GET', path);
        expect([r.status, r.json.status], path).toEqual([503, 'error']);
      }
      const add = await call(closed.api, 'POST', '/api/item/addFromURL', {
        body: { url: PNG_DATA_URL },
      });
      expect(add.status).toBe(503);

      const ro = await boot({ sandbox: { readOnly: true } });
      const [id] = ro.sb.itemIds;
      const trash = await call(ro.api, 'POST', '/api/item/moveToTrash', {
        body: { itemIds: [id] },
      });
      expect(trash.status).toBe(409);
      expect(trash.json.message).toBe((await ro.sb.host.api.getLibraryState())!.readOnlyReason);
      expect(ro.sb.read(id).isDeleted).toBe(false);
    });
  });
});
