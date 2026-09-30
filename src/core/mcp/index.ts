// MCP server for AI agents: Streamable HTTP on 127.0.0.1, bearer token, plan-then-apply writes.
//
// Connect Claude Code (the token file is <config>/api-token, 0600):
//   claude mcp add --transport http boogie http://127.0.0.1:41597/mcp \
//     --header "Authorization: Bearer $(cat ~/.config/boogie-browser/api-token)"
export { startMcpServer, type McpHandle } from './http';
export { buildMcpServer } from './server';
