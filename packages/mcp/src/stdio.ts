import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, type ServerOptions } from './server.js';

/**
 * Serves MCP over stdin/stdout and resolves once the client disconnects.
 * stdout carries JSON-RPC only: anything else must go to stderr.
 */
export async function startStdioServer(opts: ServerOptions = {}): Promise<void> {
  const server = createServer(opts);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  // The stdio transport ignores EOF; treat a closed stdin as the client leaving.
  process.stdin.once('end', () => void server.close());
  await server.connect(new StdioServerTransport());
  await closed;
}
