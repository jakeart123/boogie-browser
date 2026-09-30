// One MCP server instance: all the tools, bound to a CoreHost and a client name.
import { McpServer } from '@modelcontextprotocol/server';
import type { CoreHost } from '../contracts';
import { toolRegistrar } from './kit';
import { registerImportTools } from './tools/imports';
import { registerItemTools } from './tools/items';
import { registerItemWriteTools } from './tools/itemWrites';
import { registerJobTools } from './tools/jobs';
import { registerLibraryTools } from './tools/library';
import { registerOrganizeTools } from './tools/organize';
import { registerSmartTools } from './tools/smart';
import { registerTagGroupTools } from './tools/tagGroups';
import { registerUndoTool } from './tools/undo';

/** Shown to every agent that connects. Plain rules first; tool descriptions repeat what matters. */
const SERVER_INSTRUCTIONS = `Boogie Browser edits real Eagle libraries in place. Many libraries are shared over Dropbox with a partner who uses real Eagle on Windows, so every write is visible to a real person.
- Start with library_info. Read before you write. Reuse existing tag and folder names (list_tags, list_folders).
- Prefer small batches. Anything that removes or renames things, and any write to more than 50 items, is a two step call: call it once to get the exact change list and a plan_id, check it, then call again with the same arguments plus plan_id. Plans last 15 minutes and cover at most 500 items.
- Nothing is ever deleted for good from here. move_to_trash is recoverable. Never try to delete files or empty the trash.
- Every write returns a group_id. undo reverts it. Tag groups and Quick Access edits may be overwritten by the partner's Eagle.
- Ids come from the tools (search_items, list_folders). Do not invent them. If a tool says the library is read-only, stop and tell the user.`;

/** `client` is the User-Agent product (lowercased); Pause keys on it (kit.ts McpState.pausedAs). */
export function buildMcpServer(host: CoreHost, clientName = 'Agent', client = ''): McpServer {
  const server = new McpServer(
    { name: 'boogie-browser', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const tool = toolRegistrar(server, host, clientName, client);
  registerLibraryTools(tool);
  registerItemTools(tool);
  registerItemWriteTools(tool);
  registerOrganizeTools(tool);
  registerTagGroupTools(tool);
  registerSmartTools(tool);
  registerImportTools(tool);
  registerJobTools(tool);
  registerUndoTool(tool);
  return server;
}
