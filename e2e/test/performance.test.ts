import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createHarness } from '../src/harness.js';

it('G: 100 sequential get_chunk_for_file calls have p95 < 100 ms', async (context) => {
  const harness = await createHarness();
  try {
    await harness.callTool('scan');
    const durations: number[] = [];
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      const result = await harness.callTool('get_chunk_for_file', { path: 'src/math.ts', line: 2 });
      durations.push(performance.now() - start);
      expect(result.structuredContent).toMatchObject({ chunks: [{ id: 'src/math.ts' }] });
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    await context.annotate(`100 sequential MCP stdio round trips; nearest-rank p95=${p95.toFixed(3)} ms; max=${durations[99]!.toFixed(3)} ms`, 'measurement');
    expect(p95).toBeLessThan(100);
  } finally { await harness.dispose(); }
});

it('G: measures a cold scan of 200 synthetic TypeScript files (informational)', async (context) => {
  const harness = await createHarness();
  try {
    const source = join(harness.fixture.root, 'src');
    await rm(source, { recursive: true });
    await mkdir(source);
    await Promise.all(Array.from({ length: 200 }, async (_, index) => {
      const lines = [`export function compute${index}(input: number): number {`, '  let result = input;'];
      for (let step = 0; step < 36; step++) lines.push(`  result += ${index + step + 1};`);
      lines.push('  return result;', '}');
      await writeFile(join(source, `module-${index}.ts`), lines.join('\n') + '\n');
    }));
    const start = performance.now();
    const result = await harness.callTool('scan');
    const elapsed = performance.now() - start;
    await context.annotate(`Cold scan: 200 TypeScript files, 40 lines/file (8,000 source lines); MCP round trip=${elapsed.toFixed(3)} ms; Node ${process.version}; ${process.platform}/${process.arch}. Informational, no duration threshold.`, 'measurement');
    expect(result.structuredContent).toMatchObject({ scanned: true, summary: { total: 202, added: 202 } });
    expect((await harness.callTool('get_status')).structuredContent).toMatchObject({ leaves: 200 });
  } finally { await harness.dispose(); }
});
