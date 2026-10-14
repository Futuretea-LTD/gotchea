import { describe, expect, it, vi } from 'vitest';
import { createSandbox } from './helpers.js';

const startStdioServer = vi.fn(async () => {});
vi.mock('gotchea-mcp', () => ({ startStdioServer }));

describe('gotchea mcp', () => {
  it('starts the stdio MCP server without writing to stdout', async () => {
    const s = await createSandbox();
    try {
      const r = await s.gotchea(['mcp']);
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(startStdioServer).toHaveBeenCalledOnce();
    } finally {
      await s.cleanup();
    }
  });
});
