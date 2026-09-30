// Transport guards and the token file. No library is needed: these requests never reach a tool.
import { request } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreHost } from '../contracts';
import { type McpHandle, startMcpServer } from './index';
import { makeClient } from './testing/client';
import { ensureToken } from './token';

// tools/list and the guards never touch the host.
const host = {} as CoreHost;
let h: {
  dir: string;
  server: McpHandle;
  token: string;
  tokenFile: string;
  client: ReturnType<typeof makeClient>;
};
beforeEach(async () => {
  mkdirSync(resolve('.tmp/mcp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp/mcp'), 'sec-'));
  const tokenFile = join(dir, 'config', 'api-token');
  const server = await startMcpServer(host, { port: 0, tokenFile });
  const token = readFileSync(tokenFile, 'utf8').trim();
  h = { dir, server, token, tokenFile, client: makeClient(server.url, token) };
});
afterEach(async () => {
  await h.server.close();
  rmSync(h.dir, { recursive: true, force: true });
});

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('transport security', () => {
  it('rejects a missing or wrong bearer token with 401 and accepts the right one', async () => {
    expect((await h.client.post(list, {}, null)).status).toBe(401);
    expect((await h.client.post(list, {}, 'Bearer nope')).status).toBe(401);
    expect((await h.client.post(list, {}, `Basic ${h.token}`)).status).toBe(401);
    const ok = await h.client.post(list);
    expect(ok.status).toBe(200);
    expect(ok.json.result.tools.length).toBeGreaterThan(20);
  });

  it('rejects any Origin header with 403, even with a valid token', async () => {
    expect((await h.client.post(list, { origin: 'https://x' })).status).toBe(403);
    expect((await h.client.post(list, { origin: 'http://127.0.0.1' })).status).toBe(403);
  });

  it('rejects a Host that is not loopback with the right port (DNS rebinding)', async () => {
    const status = (hostHeader: string) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(h.server.url);
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              host: hostHeader,
              authorization: `Bearer ${h.token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(list));
      });
    expect(await status('evil.example')).toBe(403);
    expect(await status(`127.0.0.1:${Number(new URL(h.server.url).port) + 1}`)).toBe(403);
    expect(await status(`localhost:${new URL(h.server.url).port}`)).toBe(200);
  });

  it('only serves /mcp, and odd request paths get an answer instead of crashing the server', async () => {
    const at = async (path: string, auth = true) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(h.server.url);
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path,
            method: 'POST',
            headers: {
              ...(auth ? { authorization: `Bearer ${h.token}` } : {}),
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(list));
      });
    expect(await at('/other')).toBe(404);
    expect(await at('//evil.com/mcp')).toBe(404);
    expect(await at('/mcp/../x')).toBe(404);
    expect(await at('/mcp?session=1')).toBe(200);
    expect(await at('/mcp/')).toBe(200);
    expect(await at('/mcp', false)).toBe(401);
    expect((await h.client.post(list)).status).toBe(200); // still up
  });

  it('refuses to start on a port that is taken', async () => {
    const port = new URL(h.server.url).port;
    await expect(
      startMcpServer(host, { port: Number(port), tokenFile: h.tokenFile }),
    ).rejects.toThrow(/already in use/);
  });
});

describe('token file', () => {
  it('is 64 hex chars, mode 0600, and reused on the next start', () => {
    expect(h.token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(h.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureToken(h.tokenFile)).toBe(h.token);
  });

  it('tightens loose permissions and keeps the token', () => {
    chmodSync(h.tokenFile, 0o644);
    expect(ensureToken(h.tokenFile)).toBe(h.token);
    expect(statSync(h.tokenFile).mode & 0o777).toBe(0o600);
  });

  it('follows a rotated token without a restart', async () => {
    writeFileSync(h.tokenFile, 'rotated-token-0123456789abcdef\n', { mode: 0o600 });
    expect((await h.client.post(list)).status).toBe(401);
    const fresh = await fetch(h.server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer rotated-token-0123456789abcdef',
      },
      body: JSON.stringify(list),
    });
    expect(fresh.status).toBe(200);
  });

  it('is recreated when deleted', async () => {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(h.tokenFile);
    expect((await h.client.post(list)).status).toBe(401);
    expect(existsSync(h.tokenFile)).toBe(true);
    expect(readFileSync(h.tokenFile, 'utf8').trim()).not.toBe(h.token);
  });
});
