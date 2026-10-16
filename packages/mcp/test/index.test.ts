import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION, initConfig } from 'gotchea-core';
import { createServer } from '../src/index.js';

async function connect(root: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ root, env: { ...process.env, GOTCHEA_HOME: join(root, '.home') } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const TOOLS = ['get_chunk_for_file', 'get_generation_tasks', 'get_map', 'get_status', 'save_questions', 'scan', 'start_quiz', 'submit_answer'];

describe('gotchea-mcp', () => {
  it('lists the tools and tells the user to run `gotchea init` when .gotchea is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gotchea-mcp-'));
    const { client, close } = await connect(root);
    expect(client.getServerVersion()).toEqual({ name: 'gotchea', version: VERSION });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);

    for (const [name, args] of [['scan', {}], ['get_map', {}], ['get_status', {}], ['get_chunk_for_file', { path: 'a.ts' }]] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res.content)).toContain('gotchea init');
    }
    await close();
  });

  it('scans, draws the map and resolves a chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gotchea-mcp-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    await initConfig(root);
    const { client, close } = await connect(root);

    const scan = await client.callTool({ name: 'scan', arguments: {} });
    expect(scan.isError).toBeFalsy();
    expect((scan.structuredContent as { summary: { added: number } }).summary.added).toBeGreaterThan(0);

    const map = await client.callTool({ name: 'get_map', arguments: {} });
    const text = (map.content as { text: string }[])[0]!.text;
    expect(text.split('\n')[0]).toMatch(/^\d+ chunks? · 0 questions · next step: generate questions$/);
    expect(text).toContain('⬜');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes
    expect(text).not.toMatch(/\u001b/);

    const shallow = await client.callTool({ name: 'get_map', arguments: { depth: 0 } });
    expect((shallow.structuredContent as { root: { children: unknown[] } }).root.children).toEqual([]);

    const chunk = await client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/a.ts', line: 2 } });
    expect((chunk.structuredContent as { chunks: { id: string }[] }).chunks[0]?.id).toContain('src/a.ts');

    const status = await client.callTool({ name: 'get_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    for (const res of [scan, map, chunk, status]) expect(JSON.stringify(res)).not.toMatch(/correctIndex|explanation/);
    await close();
  });
});
