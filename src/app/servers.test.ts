import { describe, expect, it, vi } from 'vitest';
import type { CoreHost } from '../core/contracts';
import type { AppSettings } from '../shared/types';
import {
  Servers,
  compatPortsFromEnv,
  type CompatServer,
  type McpServer,
  type ServerStarters,
} from './servers';

function fakeHost(settings: Partial<AppSettings>) {
  const current = { eagleCompatApi: true, mcpEnabled: true, mcpPort: 41597, ...settings };
  const setPorts = vi.fn();
  const host = {
    api: { getSettings: async () => current },
    paths: { config: '/cfg' },
    setPorts,
  } as unknown as CoreHost;
  return { host, current, setPorts };
}

const compat = (
  apiPort: number | null,
  extPort: number | null,
  reason: string | null = null,
): CompatServer => ({ apiPort, extPort, reason, close: vi.fn(async () => {}) });
const mcp = (port: number): McpServer => ({
  port,
  url: `http://127.0.0.1:${port}/mcp`,
  close: vi.fn(async () => {}),
});

describe('Servers', () => {
  it('starts what settings ask for and reports the ports', async () => {
    const { host, setPorts } = fakeHost({});
    const starters: ServerStarters = {
      startEagleCompatServer: vi.fn(async () => compat(41595, 41593)),
      startMcpServer: vi.fn(async () => mcp(41597)),
    };
    const onOpen = vi.fn();
    const servers = new Servers(host, starters, { retryMs: 10_000, compatPorts: {}, onOpen });
    await servers.sync();
    // "Copy link" pages opened in a browser reach the app, which reveals the item.
    expect(starters.startEagleCompatServer).toHaveBeenCalledWith(host, { onOpen });
    expect(starters.startMcpServer).toHaveBeenCalledWith(host, {
      port: 41597,
      tokenFile: '/cfg/api-token',
    });
    expect(setPorts).toHaveBeenLastCalledWith({
      eagleApi: 41595,
      extension: 41593,
      mcp: 41597,
      reason: null,
    });
    await servers.close();
  });

  it('retries a busy port (Wine Eagle owns it) until it frees up', async () => {
    const { host, setPorts } = fakeHost({ mcpEnabled: false });
    const busy = compat(null, null, 'Eagle is using port 41595');
    const free = compat(41595, 41593);
    const start = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(free);
    const servers = new Servers(
      host,
      { startEagleCompatServer: start, startMcpServer: vi.fn() },
      { retryMs: 20, compatPorts: {} },
    );
    await servers.sync();
    expect(setPorts).toHaveBeenLastCalledWith({
      eagleApi: null,
      extension: null,
      mcp: null,
      reason: 'Eagle is using port 41595',
    });
    await vi.waitFor(() =>
      expect(setPorts).toHaveBeenLastCalledWith({
        eagleApi: 41595,
        extension: 41593,
        mcp: null,
        reason: null,
      }),
    );
    expect(busy.close).toHaveBeenCalled(); // the half-open server was closed before trying again
    await servers.close();
    expect(free.close).toHaveBeenCalled();
    const calls = start.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(start.mock.calls.length).toBe(calls); // no retry timer left behind
  });

  it('stops a server when its setting is turned off, and an MCP port clash is not fatal', async () => {
    const { host, current, setPorts } = fakeHost({ mcpEnabled: true });
    const running = compat(41595, 41593);
    const starters: ServerStarters = {
      startEagleCompatServer: vi.fn(async () => running),
      startMcpServer: vi.fn(async () => {
        throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      }),
    };
    const servers = new Servers(host, starters, { retryMs: 10_000, compatPorts: {} });
    await servers.sync();
    expect(setPorts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eagleApi: 41595,
        mcp: null,
        reason: expect.stringContaining('41597'),
      }),
    );
    current.eagleCompatApi = false;
    current.mcpEnabled = false;
    await servers.sync();
    expect(running.close).toHaveBeenCalled();
    expect(setPorts).toHaveBeenLastCalledWith({
      eagleApi: null,
      extension: null,
      mcp: null,
      reason: null,
    });
    await servers.close();
  });
});

describe('compatPortsFromEnv', () => {
  it('moves the Eagle-compatible ports only when asked, and ignores junk', () => {
    expect(compatPortsFromEnv({})).toEqual({});
    expect(
      compatPortsFromEnv({ BOOGIE_EAGLE_API_PORT: '0', BOOGIE_EXTENSION_PORT: '5123' }),
    ).toEqual({
      apiPort: 0,
      extPort: 5123,
    });
    expect(
      compatPortsFromEnv({ BOOGIE_EAGLE_API_PORT: '99999', BOOGIE_EXTENSION_PORT: 'x' }),
    ).toEqual({});
  });
});
