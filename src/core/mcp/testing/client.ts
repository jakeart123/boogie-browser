// A tiny MCP client for tests: raw JSON-RPC over fetch, in either protocol era. The SDK's own
// client package is not installed, and going through real HTTP also exercises the guards.
export interface ToolReply {
  isError: boolean;
  text: string;
  /** structuredContent, or the parsed text when a tool sent none. */
  data: any;
  content: any[];
}

const MODERN = '2026-07-28';

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)));
    return data.at(-1);
  }
  return JSON.parse(text);
}

export function makeClient(url: string, token: string) {
  let id = 0;

  async function post(
    body: unknown,
    headers: Record<string, string> = {},
    auth: string | null = `Bearer ${token}`,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: auth } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await parse(res) };
  }

  /** Call a tool. `era` picks the protocol; `client` is the clientInfo name (modern era only). */
  async function call(
    name: string,
    args: Record<string, unknown> = {},
    opts: { era?: 'legacy' | 'modern'; client?: string; title?: string; userAgent?: string } = {},
  ): Promise<ToolReply> {
    const modern = opts.era === 'modern';
    const params: Record<string, unknown> = { name, arguments: args };
    const headers: Record<string, string> = opts.userAgent ? { 'user-agent': opts.userAgent } : {};
    if (modern) {
      params._meta = {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': {
          name: opts.client ?? 'test-client',
          ...(opts.title ? { title: opts.title } : {}),
          version: '1',
        },
        'io.modelcontextprotocol/clientCapabilities': {},
      };
      Object.assign(headers, {
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      });
    }
    const { status, json } = await post(
      { jsonrpc: '2.0', id: ++id, method: 'tools/call', params },
      headers,
    );
    if (status !== 200 || json?.error)
      throw new Error(`tools/call ${name} failed: ${status} ${JSON.stringify(json)}`);
    const result = json.result;
    const text = result.content?.find((c: any) => c.type === 'text')?.text ?? '';
    let data = result.structuredContent;
    if (data === undefined && !result.isError) {
      try {
        data = JSON.parse(text);
      } catch {
        /* image or plain text */
      }
    }
    return { isError: result.isError === true, text, data, content: result.content ?? [] };
  }

  async function listTools(): Promise<any[]> {
    const { json } = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list' });
    return json.result.tools;
  }

  return { post, call, listTools };
}
