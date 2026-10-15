import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixture, text, type Fixture } from './helpers.js';

// Windows process and pipe overhead, plus shared CI runners, make round trips slower.
const BUDGET_MS = process.platform === 'win32' ? 250 : 100;

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const CORE_DIST = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
// The spawned process runs the built bundle: skip (visibly) until `pnpm -r build` has produced it.
const built = existsSync(BIN) && existsSync(CORE_DIST);

describe.skipIf(!built)('stdio round trip (built dist/bin.js)', () => {
  let fx: Fixture;
  let client: Client;

  beforeAll(async () => {
    fx = await createFixture();
    client = new Client({ name: 'stdio-test', version: '0.0.0' });
    const env = Object.fromEntries(Object.entries(fx.env).filter((e): e is [string, string] => e[1] !== undefined));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: fx.root, env, stderr: 'pipe' }));
  }, 20_000);

  afterAll(async () => {
    await client?.close();
    await fx?.cleanup();
  });

  it('lists the tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['scan', 'get_map', 'get_chunk_for_file', 'get_status']));
  });

  it('completes a request/response round trip within budget', async () => {
    // The minimum filters out scheduler and CI-load noise: only the fastest sample
    // reflects the server's real latency.
    const fastestMs = async (call: () => Promise<unknown>): Promise<number> => {
      // Warm-up absorbs one-time startup and JIT cost.
      await call(); // warm
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await call();
        samples.push(performance.now() - t0);
      }
      return Math.min(...samples);
    };

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(4);
    expect(await fastestMs(() => client.listTools())).toBeLessThan(BUDGET_MS);

    const getChunk = () => client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/math.ts', line: 2 } });
    expect(text(await getChunk())).toContain('src/math.ts');
    expect(await fastestMs(getChunk)).toBeLessThan(BUDGET_MS);
  });
});

if (!built) console.warn('[gotchea-mcp] stdio test SKIPPED: run `pnpm -r build` first (dist/bin.js missing).');
