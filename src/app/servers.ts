// Starts and stops the two local servers (Eagle-compatible API for the browser extension, and
// the MCP server for agents) according to settings, and tells the core which ports we got.
// Plain Node (no electron import). The real start functions are handed in by core.ts.
import { join } from 'node:path';
import type { CoreHost } from '../core/contracts';

export interface CompatServer {
  apiPort: number | null;
  extPort: number | null;
  reason: string | null;
  close(): Promise<void>;
}
export interface McpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}
/** A "copy link" page opened in a browser: http://localhost:41595/item?id=... (and folder links). */
export interface OpenLink {
  kind: 'item' | 'folder' | 'smart-folder';
  id: string;
}
export interface ServerStarters {
  startEagleCompatServer(
    host: CoreHost,
    opts: { apiPort?: number; extPort?: number; bind?: string; onOpen?: (t: OpenLink) => void },
  ): Promise<CompatServer>;
  startMcpServer(
    host: CoreHost,
    opts: { port: number; tokenFile: string; bind?: string },
  ): Promise<McpServer>;
}

/** Eagle running under Wine owns these ports whenever it runs, so a busy port is normal: try again later. */
const RETRY_MS = 30_000;

/**
 * The Eagle-compatible servers use Eagle's own ports (41595 / 41593) so the browser extension finds
 * them. BOOGIE_EAGLE_API_PORT / BOOGIE_EXTENSION_PORT move them, for tests and for a second copy of
 * Boogie next to a running Eagle. 0 picks a free port.
 */
export function compatPortsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  apiPort?: number;
  extPort?: number;
} {
  const port = (v: string | undefined) =>
    v && /^\d{1,5}$/.test(v) && Number(v) <= 65535 ? Number(v) : undefined;
  const out: { apiPort?: number; extPort?: number } = {};
  const api = port(env.BOOGIE_EAGLE_API_PORT);
  const ext = port(env.BOOGIE_EXTENSION_PORT);
  if (api !== undefined) out.apiPort = api;
  if (ext !== undefined) out.extPort = ext;
  return out;
}

export class Servers {
  private compat: CompatServer | null = null;
  private mcp: { server: McpServer | null; port: number; error: string | null } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(
    private host: CoreHost,
    private starters: ServerStarters,
    private o: {
      retryMs?: number;
      compatPorts?: { apiPort?: number; extPort?: number };
      /** The app brings the linked item or folder into view. */
      onOpen?: (t: OpenLink) => void;
    } = {},
  ) {}

  private get retryMs(): number {
    return this.o.retryMs ?? RETRY_MS;
  }

  /** Bring the servers in line with the current settings. Safe to call any time, any number of times. */
  sync(): Promise<void> {
    if (this.busy) {
      this.again = true; // run once more when the current pass ends, so a late settings change is not lost
      return this.busy;
    }
    this.busy = this.pass().finally(() => {
      this.busy = null;
      if (this.again && !this.closed) {
        this.again = false;
        void this.sync();
      }
    });
    return this.busy;
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const settings = await this.host.api.getSettings();

    // Eagle-compatible API + extension server
    if (settings.eagleCompatApi) {
      // A half-bound server (one port busy) is restarted so the busy one gets another chance.
      if (this.compat && (this.compat.apiPort === null || this.compat.extPort === null))
        await this.stopCompat();
      if (!this.compat) {
        try {
          this.compat = await this.starters.startEagleCompatServer(this.host, {
            ...(this.o.compatPorts ?? compatPortsFromEnv()),
            ...(this.o.onOpen ? { onOpen: this.o.onOpen } : {}),
          });
        } catch (e) {
          console.warn('[servers] Eagle API server failed to start:', e);
          this.compat = {
            apiPort: null,
            extPort: null,
            reason: 'The Eagle-compatible server could not start.',
            close: async () => {},
          };
        }
      }
    } else if (this.compat) await this.stopCompat();

    // MCP server for agents
    if (settings.mcpEnabled) {
      if (this.mcp && (this.mcp.port !== settings.mcpPort || !this.mcp.server))
        await this.stopMcp();
      if (!this.mcp) {
        const port = settings.mcpPort;
        try {
          const server = await this.starters.startMcpServer(this.host, {
            port,
            tokenFile: join(this.host.paths.config, 'api-token'),
          });
          this.mcp = { server, port, error: null };
        } catch (e) {
          console.warn('[servers] MCP server failed to start:', e);
          const busy = (e as NodeJS.ErrnoException)?.code === 'EADDRINUSE';
          this.mcp = {
            server: null,
            port,
            error: busy
              ? `Port ${port} is busy, so agents can't connect yet.`
              : 'The agent server could not start.',
          };
        }
      }
    } else if (this.mcp) await this.stopMcp();

    this.report();
    const needsRetry =
      (this.compat && (this.compat.apiPort === null || this.compat.extPort === null)) ||
      (this.mcp && !this.mcp.server);
    if (needsRetry && !this.closed) {
      this.timer = setTimeout(() => void this.sync(), this.retryMs);
      this.timer.unref();
    }
  }

  private report(): void {
    const reasons = [this.compat?.reason, this.mcp?.error].filter((r): r is string => !!r);
    this.host.setPorts({
      eagleApi: this.compat?.apiPort ?? null,
      extension: this.compat?.extPort ?? null,
      mcp: this.mcp?.server?.port ?? null,
      reason: reasons.length ? reasons.join(' ') : null,
    });
  }

  private async stopCompat(): Promise<void> {
    const c = this.compat;
    this.compat = null;
    await c?.close().catch((e) => console.warn('[servers] closing Eagle API server:', e));
  }

  private async stopMcp(): Promise<void> {
    const m = this.mcp;
    this.mcp = null;
    await m?.server?.close().catch((e) => console.warn('[servers] closing MCP server:', e));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.busy?.catch(() => {});
    await Promise.all([this.stopCompat(), this.stopMcp()]);
  }
}
