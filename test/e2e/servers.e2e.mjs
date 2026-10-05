// The local servers of the real app: the Eagle-compatible HTTP API (moved to free ports with
// BOOGIE_EAGLE_API_PORT / BOOGIE_EXTENSION_PORT, since your own Eagle may own 41595/41593) and the MCP
// server for agents (raw JSON-RPC over Streamable HTTP with the token from BOOGIE_HOME). Writes
// through both land on disk the Eagle way and show up in the app's History as the right actor.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  WORK,
  assertEagleWrite,
  freePort,
  freshLibrary,
  itemMeta,
  launch,
  makeFixtures,
  scanItems,
  until,
  withShots,
} from './lib/harness.mjs';
import { waitCount } from './lib/ui.mjs';

const ITEM = 'LT24XY3DPJFLK'; // 0051.jpg in the sample library

describe('Eagle HTTP API and MCP server', () => {
  let ctx;
  let lib;
  let apiPort;
  let extPort;
  const it = withShots(() => ctx);
  const eagle = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  before(async () => {
    makeFixtures();
    lib = freshLibrary('servers');
    apiPort = await freePort();
    extPort = await freePort();
    ctx = await launch({
      name: 'servers',
      open: lib,
      settings: { eagleCompatApi: true, mcpEnabled: true },
      env: { BOOGIE_EAGLE_API_PORT: String(apiPort), BOOGIE_EXTENSION_PORT: String(extPort) },
    });
    await until(async () => (await ctx.call('getStatus')).ports.mcp === ctx.mcpPort, 'MCP up');
  });
  after(() => ctx?.close());

  it('reports its ports in the status strip tooltip', async () => {
    const st = await ctx.call('getStatus');
    assert.deepEqual(
      [st.ports.eagleApi, st.ports.extension, st.ports.mcp],
      [apiPort, extPort, ctx.mcpPort],
    );
    const tip = await ctx.win.locator('#ports-tip').innerText();
    assert.match(tip, new RegExp(String(apiPort)));
    assert.match(tip, new RegExp(String(ctx.mcpPort)));
  });

  it('Eagle v1 API: application info, library info, item list and info', async () => {
    const info = await eagle('/api/application/info');
    assert.equal(info.status, 'success');
    assert.ok(info.data.version, JSON.stringify(info));
    const libInfo = await eagle('/api/library/info');
    assert.equal(libInfo.status, 'success');
    assert.ok(Array.isArray(libInfo.data.folders));
    const list = await eagle('/api/item/list?limit=10');
    assert.equal(list.status, 'success');
    assert.equal(list.data.length, 3);
    const item = await eagle(`/api/item/info?id=${ITEM}`);
    assert.equal(item.data.id, ITEM);
    assert.equal(item.data.name, '0051');
  });

  it('Eagle v1 API: update an item and add one from a path (like the browser extension)', async () => {
    const before = itemMeta(lib, ITEM);
    const up = await eagle('/api/item/update', {
      id: ITEM,
      tags: ['Atelier Gerome', 'via api'],
      star: 2,
    });
    assert.equal(up.status, 'success', JSON.stringify(up));
    await until(() => itemMeta(lib, ITEM).tags.includes('via api'), 'API edit on disk');
    await assertEagleWrite(lib, ITEM, before);
    assert.equal(itemMeta(lib, ITEM).star, 2);
    const add = await eagle('/api/item/addFromPath', {
      path: makeFixtures()('red.png'),
      name: 'from the extension',
      tags: ['web'],
    });
    assert.equal(add.status, 'success', JSON.stringify(add));
    await until(() => scanItems(lib).some((m) => m.name === 'from the extension'), 'added item');
    await waitCount(ctx.win, 4);
    // The busy-port path (your own Eagle on 41595) is covered in the next test when it applies.
  });

  it('browser extension saves (port 41593 protocol) and bookmarks land in the library', async () => {
    const png = join(WORK, 'ext-pic.png');
    execFileSync('magick', ['-size', '66x22', 'xc:#406080', png]);
    const bytes = readFileSync(png);
    const web = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(bytes);
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    try {
      const src = `http://127.0.0.1:${web.address().port}/pic.png`;
      const res = await fetch(`http://127.0.0.1:${extPort}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'chrome-extension://abcdefghijklmnop',
        },
        body: new URLSearchParams({
          type: 'image',
          src,
          url: 'https://example.com/gallery',
          title: 'From the gallery',
        }).toString(),
      });
      assert.equal(res.status, 200, await res.text());
      const saved = await until(
        () => scanItems(lib).find((m) => m.name === 'From the gallery'),
        'the extension save',
      );
      assert.equal(saved.url, 'https://example.com/gallery');
      assert.equal(saved.width, 66);
    } finally {
      web.close();
    }
    const bm = await eagle('/api/item/addBookmark', {
      url: 'https://example.com/article',
      name: 'An article',
    });
    assert.equal(bm.status, 'success', JSON.stringify(bm));
    const item = await until(() => scanItems(lib).find((m) => m.name === 'An article'), 'bookmark');
    assert.equal(item.url, 'https://example.com/article');
  });

  it('with Eagle holding 41595/41593, a second copy on the default ports says why it has none', async (t) => {
    const busy = await new Promise((res) => {
      const s = createServer().once('error', () => res(true));
      s.listen(41595, '127.0.0.1', () => s.close(() => res(false)));
    });
    // Only when your own Eagle really holds the port: otherwise this copy would take it, and the real
    // browser extension would start talking to a test app.
    if (!busy) return t.skip('41595 is free (Eagle is not running), so there is nothing to see');
    const other = await launch({
      name: 'servers-busy',
      open: freshLibrary('servers-busy'),
      settings: { eagleCompatApi: true, mcpEnabled: false },
    });
    try {
      const st = await until(async () => {
        const s = await other.call('getStatus');
        return s.ports.reason && s;
      }, 'a reason for the missing ports');
      assert.equal(st.ports.eagleApi, null);
      assert.match(st.ports.reason, /41595/);
      assert.match(await other.win.locator('#ports-tip').innerText(), /41595/);
    } finally {
      await other.close();
    }
  });

  // ── MCP ──
  let session = null;
  let nextId = 1;
  async function rpc(method, params, notify = false) {
    const token = readFileSync(join(ctx.home, 'config/api-token'), 'utf8').trim();
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      // The server is stateless: 2025-era clients are named by their User-Agent after initialize.
      'user-agent': 'e2e-agent/1.0',
    };
    if (session) headers['mcp-session-id'] = session;
    const body = notify
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: nextId++, method, params };
    const res = await fetch(`http://127.0.0.1:${ctx.mcpPort}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (notify) return res.status;
    const text = await res.text();
    // Streamable HTTP answers with JSON or with an SSE stream carrying the JSON.
    const json = res.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .at(-1)
            .slice(5),
        )
      : JSON.parse(text);
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }
  // Agents name their library on every call (the window's library never decides it).
  const callTool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: { library: lib, ...args } });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return { ...r, data: r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? 'null') };
  };

  it('MCP: refuses without the token, then initializes and lists tools', async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.mcpPort}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e-agent', version: '1.0' },
    });
    assert.ok(init.serverInfo?.name, JSON.stringify(init));
    await rpc('notifications/initialized', {}, true);
    const { tools } = await rpc('tools/list', {});
    const names = tools.map((x) => x.name);
    for (const n of ['search_items', 'add_tags', 'move_to_trash', 'undo', 'get_thumbnail'])
      assert.ok(names.includes(n), `missing tool ${n} in ${names}`);
  });

  it('MCP: searches, tags an item (shown in History as the agent), and plans before trashing', async () => {
    const found = await callTool('search_items', { query: 'prank' });
    assert.ok(!found.isError, JSON.stringify(found));
    const items = found.data.items ?? found.data;
    assert.equal(items.length, 2, JSON.stringify(found.data).slice(0, 300));
    const before = itemMeta(lib, ITEM);
    const tagged = await callTool('add_tags', { item_ids: [ITEM], tags: ['agent tag'] });
    assert.ok(!tagged.isError, JSON.stringify(tagged));
    await until(() => itemMeta(lib, ITEM).tags.includes('agent tag'), 'agent edit on disk');
    await assertEagleWrite(lib, ITEM, before);
    const hist = await ctx.call('listHistory', { limit: 5 });
    const entry = hist.find((h) => /agent tag/.test(h.label) || h.actor.kind === 'agent');
    assert.equal(entry?.actor.kind, 'agent', JSON.stringify(hist.map((h) => [h.actor, h.label])));
    assert.match(entry.actor.name, /e2e-agent/);
    await ctx.win.locator('.strip .btn', { hasText: 'History' }).click();
    await until(
      async () => (await ctx.win.locator('.insp .hev').first().innerText()).includes('e2e-agent'),
      'the agent in the History tab',
    );
    // Destructive: the first call is a dry run with a plan, the second applies it.
    const plan = await callTool('move_to_trash', { item_ids: [ITEM] });
    assert.ok(plan.data.plan_id, JSON.stringify(plan.data).slice(0, 300));
    assert.equal(itemMeta(lib, ITEM).isDeleted, false, 'the dry run trashed the item');
    const applied = await callTool('move_to_trash', {
      item_ids: [ITEM],
      plan_id: plan.data.plan_id,
    });
    assert.ok(!applied.isError, JSON.stringify(applied));
    await until(() => itemMeta(lib, ITEM).isDeleted === true, 'trashed by the agent');
    const undone = await callTool('undo', {});
    assert.ok(!undone.isError, JSON.stringify(undone));
    await until(() => itemMeta(lib, ITEM).isDeleted === false, 'agent undo');
  });

  it('Settings (Ctrl+,): switching agent access off stops the MCP server, on starts it', async () => {
    const { win } = ctx;
    await win.locator('.scroller').focus();
    await win.keyboard.press('Control+,');
    const dlg = win.locator('.dg-panel');
    const box = dlg.locator('label.dg-check', { hasText: 'AI agent access' }).locator('input');
    await box.uncheck();
    await until(async () => (await ctx.call('getStatus')).ports.mcp === null, 'MCP stopped');
    const refused = await fetch(`http://127.0.0.1:${ctx.mcpPort}/mcp`, { method: 'POST' }).then(
      () => false,
      () => true,
    );
    assert.ok(refused, 'the MCP port still answers');
    await box.check();
    await until(async () => (await ctx.call('getStatus')).ports.mcp === ctx.mcpPort, 'MCP back');
    // The connect command shown for Claude Code uses the real port.
    assert.match(
      await dlg.locator('.dg-code').first().innerText(),
      new RegExp(`127\\.0\\.0\\.1:${ctx.mcpPort}/mcp`),
    );
    await win.keyboard.press('Escape');
  });
});
