// gotchea-mcp: the MCP server for gotchea. Exposes the comprehension map to coding
// agents through the tools `scan`, `get_map`, `get_chunk_for_file` and `get_status`,
// built only on gotchea-core's public API. Quiz and generation tools arrive in M2/M3.
export { createServer, type ServerOptions } from './server.js';
export { startStdioServer } from './stdio.js';
