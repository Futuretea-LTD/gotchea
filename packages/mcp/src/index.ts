// gotchea-mcp: the MCP server for gotchea, built only on gotchea-core's public API.
// The tool list is deliberately not repeated here so it can't drift: server.ts
// registers the tools, one file per tool in src/tools/.
export { createServer, type ServerOptions } from './server.js';
export { startStdioServer } from './stdio.js';
