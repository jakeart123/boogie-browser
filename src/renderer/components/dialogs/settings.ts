// Small pure pieces of the settings dialog.
import type { AppStatus } from '../../../shared/types';

export const MCP_TOKEN_FILE = '~/.config/boogie-browser/api-token';

/** The one-liner that connects Claude Code to Boogie's MCP server. */
export function mcpCommand(port: number): string {
  return `claude mcp add --transport http boogie http://127.0.0.1:${port}/mcp --header "Authorization: Bearer $(cat ${MCP_TOKEN_FILE})"`;
}

/** Keep a typed number inside a range; null when it isn't a whole number at all. */
export function clampInt(text: string, min: number, max: number): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function extensionStatus(on: boolean, ports: AppStatus['ports'] | null): string {
  if (!on) return 'Off.';
  if (ports?.eagleApi)
    return `On. Listening on ${ports.eagleApi}${ports.extension ? ` and ${ports.extension}` : ''}.`;
  return ports?.reason ? `On, but not listening. ${ports.reason}` : 'On. Starting…';
}

export function mcpStatus(on: boolean, ports: AppStatus['ports'] | null): string {
  if (!on) return 'Off.';
  return ports?.mcp ? `On. Listening on ${ports.mcp}.` : 'On, but not listening yet.';
}
