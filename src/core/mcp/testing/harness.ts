// Test setup: the REAL core host on a sandbox library copy (service/testSandbox.ts), the MCP
// server on port 0, and a client. A small folder tree is made through the app as "You":
//   Atelier (auto-tag Atelier) > Gerome (auto-tag Gerome), and Refs.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreHost } from '../../contracts';
import { openSandbox, type Sandbox } from '../../service/testSandbox';
import { startMcpServer, type McpHandle } from '../http';
import { makeClient } from './client';

export interface Harness {
  sb: Sandbox;
  host: CoreHost;
  server: McpHandle;
  token: string;
  tokenFile: string;
  client: ReturnType<typeof makeClient>;
  /** Item ids at open (All view order). */
  ids: string[];
  /** The three sample items: short names, in no folder, tagged "Atelier Gerome". */
  sample: string[];
  folders: { atelier: string; gerome: string; refs: string };
  stop(): Promise<void>;
}

const SAMPLE = ['LT24XY3DPJFLK', 'MKG8VYYQTA5SW', 'MKGA0LUUPY9BM'];

/**
 * Before the library opens: `n` copies of the first sample item under new ids (same file, so
 * they are also exact duplicates of it), written into our own sandbox copy.
 */
function cloneItems(libPath: string, n: number): void {
  const images = join(libPath, 'images');
  const source = `${SAMPLE[0]}.info`;
  for (let i = 0; i < n; i++) {
    const id = `MCPCOPY${String(i).padStart(6, '0')}`;
    const dir = join(images, `${id}.info`);
    cpSync(join(images, source), dir, { recursive: true });
    const meta = join(dir, 'metadata.json');
    const rec = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
    writeFileSync(meta, JSON.stringify({ ...rec, id }));
  }
}

export async function startHarness(
  opts: { writable?: boolean; copies?: number } = {},
): Promise<Harness> {
  const sb = await openSandbox({
    area: 'mcp',
    open: false,
    writable: opts.writable,
    shared: true,
    partner: 'Sam',
  });
  try {
    return await setUp(sb, opts);
  } catch (e) {
    await sb.close(); // a failed setup must not leave its library copy behind
    throw e;
  }
}

async function setUp(sb: Sandbox, opts: { writable?: boolean; copies?: number }): Promise<Harness> {
  const { host } = sb;
  if (opts.copies) cloneItems(sb.libPath, opts.copies);
  await host.api.openLibrary(sb.libPath);
  await host.api.refresh({ full: true }); // join the first index sync
  const ids = (await host.api.query({ scope: { kind: 'all' }, filter: {}, sort: null })).ids;

  const folders = { atelier: '', gerome: '', refs: '' };
  if (opts.writable !== false) {
    folders.atelier = (await host.api.createFolder('Atelier', null)).id;
    await host.api.updateFolder(folders.atelier, { tags: ['Atelier'] });
    folders.gerome = (await host.api.createFolder('Gerome', folders.atelier)).id;
    await host.api.updateFolder(folders.gerome, { tags: ['Gerome'] });
    folders.refs = (await host.api.createFolder('Refs', null)).id;
  }

  const tokenFile = join(sb.dir, 'home/config/api-token');
  const server = await startMcpServer(host, { port: 0, tokenFile });
  const token = readFileSync(tokenFile, 'utf8').trim();
  return {
    sb,
    host,
    server,
    token,
    tokenFile,
    client: makeClient(server.url, token),
    ids,
    sample: SAMPLE,
    folders,
    async stop() {
      await server.close();
      await sb.close();
    },
  };
}
