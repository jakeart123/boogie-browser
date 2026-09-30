// The HTTP face: Streamable HTTP at /mcp on loopback, behind a bearer token, with DNS rebinding
// protection (Host must be loopback, and any Origin header at all is refused).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CoreHost } from '../contracts';
import { stateFor } from './kit';
import { buildMcpServer } from './server';
import { TokenStore } from './token';

export interface McpHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const debug = (e: Error) => {
  if (process.env.BOOGIE_MCP_DEBUG) console.error('[mcp]', e.message);
};

// Names that say nothing about who is calling.
const GENERIC_AGENT =
  /^(node|undici|curl|wget|python|python-requests|python-httpx|aiohttp|axios|got|okhttp|go-http-client|mozilla|bun|deno)/i;

/** The User-Agent's product ("claude-code" in "claude-code/2.1.284 (sdk-cli)"), or ''. */
function userAgentProduct(ua: string | null | undefined): string {
  return ua?.split(/[\s/]/)[0]?.trim() ?? '';
}

/**
 * 2025-era clients only send their name in the `initialize` call, which a stateless server never
 * sees again, so fall back to the User-Agent product name. 2026-07-28 clients name themselves on
 * every request (handled where the tool runs).
 */
function clientNameFromUserAgent(product: string): string {
  return product && !GENERIC_AGENT.test(product) ? product : 'Agent';
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

export async function startMcpServer(
  host: CoreHost,
  opts: { port: number; tokenFile: string; bind?: string },
): Promise<McpHandle> {
  const tokens = new TokenStore(opts.tokenFile);
  tokens.current(); // create the file now so `claude mcp add` can be run before the first request
  const state = stateFor(host);
  const bind = opts.bind ?? '127.0.0.1';

  const handler = createMcpHandler(
    (ctx) => {
      const product = userAgentProduct(ctx.requestInfo?.headers.get('user-agent'));
      return buildMcpServer(host, clientNameFromUserAgent(product), product.toLowerCase());
    },
    { onerror: debug },
  );
  const serve = toNodeHandler(handler, { onerror: debug });
  let allowedHosts = new Set<string>();

  /** Checks in order (cheapest and most important first), then hands the request to the SDK. */
  function handle(req: IncomingMessage, res: ServerResponse): void {
    // 1. DNS rebinding: a web page can point its own hostname at 127.0.0.1, but cannot fake Host.
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
      return send(res, 403, {
        error: 'forbidden',
        message: 'Bad Host header. Use http://127.0.0.1:<port>/mcp.',
      });
    }
    // 2. Browsers always send Origin on cross-site requests; MCP clients never do. Any Origin is refused.
    if (req.headers.origin !== undefined) {
      return send(res, 403, {
        error: 'forbidden',
        message: 'Requests with an Origin header (from web pages) are not accepted.',
      });
    }
    // Plain string split, not new URL(): a strange request line must never throw in here.
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp' && path !== '/mcp/') {
      return send(res, 404, { error: 'not_found', message: 'The MCP endpoint is /mcp.' });
    }
    // 3. Bearer token.
    if (!tokens.accepts(req.headers.authorization)) {
      return send(
        res,
        401,
        {
          error: 'unauthorized',
          message:
            "Send 'Authorization: Bearer <token>'. The token is in the api-token file in Boogie Browser's config folder.",
        },
        { 'www-authenticate': 'Bearer realm="boogie-browser"' },
      );
    }
    serve(req, res).catch((e: unknown) => failed(res, e));
  }

  function failed(res: ServerResponse, e: unknown): void {
    debug(e instanceof Error ? e : new Error(String(e)));
    if (!res.headersSent)
      send(res, 500, { error: 'internal', message: 'The MCP server hit an error.' });
    else res.destroy();
  }

  // An exception here would take the whole app down, so nothing escapes this wrapper.
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      failed(res, e);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, bind, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE')
      throw Object.assign(
        new Error(`Port ${opts.port} is already in use, so the MCP server did not start.`),
        { code: e.code },
      );
    throw e;
  });
  server.on('error', debug);

  const port = (server.address() as { port: number }).port;
  allowedHosts = new Set(
    ['127.0.0.1', 'localhost', '[::1]', bind.includes(':') ? `[${bind}]` : bind].map((h) =>
      `${h}:${port}`.toLowerCase(),
    ),
  );
  const urlHost =
    bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind.includes(':') ? `[${bind}]` : bind;

  return {
    port,
    url: `http://${urlHost}:${port}/mcp`,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await handler.close();
      state.dispose();
    },
  };
}
