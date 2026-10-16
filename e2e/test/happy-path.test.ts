import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createHarness } from '../src/harness.js';
import { generateQuestions, mapNodes, playQuiz, type Status } from '../src/scenarios.js';

it('B: scans known functions, generates offline questions and turns all reviewed chunks green', async () => {
  const harness = await createHarness();
  const call = harness.callTool.bind(harness);
  try {
    expect((await call('scan')).structuredContent).toMatchObject({ scanned: true, summary: { total: 4, added: 4 } });
    for (const [path, names] of [
      ['src/math.ts', ['clamp', 'average']],
      ['src/account.ts', ['deposit', 'withdraw', 'getBalance']],
    ] as const) {
      const lines = (await readFile(join(harness.fixture.root, path), 'utf8')).split('\n');
      for (const name of names) {
        const line = lines.findIndex((text) => text.includes(`${name}(`)) + 1;
        expect(line).toBeGreaterThan(0);
        const lookup = await call('get_chunk_for_file', { path, line });
        expect(lookup.structuredContent).toMatchObject({ chunks: [{ id: path, isLeaf: true }] });
      }
    }
    expect((await mapNodes(call)).every((node) => node.state.color === 'grey')).toBe(true);
    const before = (await call('get_status')).structuredContent as unknown as Status;
    expect(before.colors.grey).toBe(before.leaves);
    const tasks = await generateQuestions(call);
    expect((await mapNodes(call)).every((node) => node.state.color === 'red')).toBe(true);
    for (const task of tasks) {
      await playQuiz(call, task.chunkId);
      const node = (await mapNodes(call)).find((item) => item.id === task.chunkId);
      expect(node!.state.color).toBe('green');
    }
    const after = (await call('get_status')).structuredContent as unknown as Status;
    const coverage = (status: Status) => status.colors.green / status.leaves * 100;
    expect(coverage(after)).toBeGreaterThan(coverage(before));
    expect(coverage(after)).toBe(100);
    expect(after.questions).toBe(tasks.reduce((sum, task) => sum + task.count, 0));
    expect((await mapNodes(call)).every((node) => node.state.color === 'green')).toBe(true);
  } finally {
    await harness.dispose();
  }
});
