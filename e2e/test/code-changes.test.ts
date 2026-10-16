import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GenerationTaskOut } from '../../packages/mcp/src/schemas.js';
import { createHarness, type McpHarness } from '../src/harness.js';
import { generateQuestions, mapNodes, playQuiz, type Status } from '../src/scenarios.js';

const chunkId = 'src/math.ts';

async function withGreenChunk(run: (harness: McpHarness, task: GenerationTaskOut, source: string) => Promise<void>) {
  const harness = await createHarness();
  const call = harness.callTool.bind(harness);
  try {
    await call('scan');
    const task = (await generateQuestions(call)).find((item) => item.chunkId === chunkId)!;
    await playQuiz(call, chunkId);
    expect((await mapNodes(call)).find((node) => node.id === chunkId)?.state.color).toBe('green');
    const available = (await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
    expect(available.tasks.find((item) => item.chunkId === chunkId)?.existingStems).toHaveLength(task.count);
    await run(harness, task, await readFile(join(harness.fixture.root, chunkId), 'utf8'));
  } finally {
    await harness.dispose();
  }
}

describe('E: code changes invalidate comprehension and obsolete questions', () => {
  it('small edit invalidates questions and turns grey', async () => {
    await withGreenChunk(async (harness, task, source) => {
      const changed = source.replace("RangeError('Inverted range')", "RangeError('Minimum exceeds maximum')");
      expect(changed).not.toBe(source);
      await writeFile(join(harness.fixture.root, chunkId), changed);
      const call = harness.callTool.bind(harness);
      const scan = (await call('scan')).structuredContent as { summary: { changed: number } };
      expect(scan.summary.changed).toBeGreaterThan(0);
      const tasks = (await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
      const regeneration = tasks.tasks.find((item) => item.chunkId === chunkId);
      expect(regeneration).toMatchObject({ count: task.count, existingStems: [] });
      expect(regeneration!.chunkHash).not.toBe(task.chunkHash);
      expect((await mapNodes(call)).find((node) => node.id === chunkId)?.state.color,
        'A small edit invalidates questions and turns grey: no ok questions remain (PLAN §3 colors)').toBe('grey');
    });
  });

  it('large edit invalidates questions and turns grey', async () => {
    await withGreenChunk(async (harness, task, source) => {
      const start = source.indexOf('export function clamp(');
      const end = source.indexOf('\n}', start) + 2;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      // Expand the rewritten function so the file leaf also exceeds the 50% change threshold.
      const replacement = [
        'export function clamp(input: number, minimum: number, maximum: number): number {',
        '  const bounds = [minimum, maximum];',
        '  const sorted = bounds.slice().sort((left, right) => left - right);',
        '  const lower = sorted[0]!;',
        '  const upper = sorted[1]!;',
        '  const finite = Number.isFinite(input);',
        '  const fallback = finite ? input : lower;',
        '  const aboveLower = Math.max(lower, fallback);',
        '  const belowUpper = Math.min(upper, aboveLower);',
        '  const result = Number(belowUpper);',
        '  return result;',
        '}',
      ].join('\n');
      const call = harness.callTool.bind(harness);
      const before = (await call('get_status')).structuredContent as unknown as Status;
      await writeFile(join(harness.fixture.root, chunkId), source.slice(0, start) + replacement + source.slice(end));
      await call('scan');
      const tasks = (await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
      const regeneration = tasks.tasks.find((item) => item.chunkId === chunkId);
      expect(regeneration).toMatchObject({ count: task.count, existingStems: [] });
      expect(regeneration!.chunkHash).not.toBe(task.chunkHash);
      expect((await call('get_status')).structuredContent).toMatchObject({ questions: before.questions - task.count });
      expect((await mapNodes(call)).find((node) => node.id === chunkId)?.state.color,
        'A large edit invalidates questions and turns grey; regeneration/status establish old questions are unusable').toBe('grey');
    });
  });

  it.each(['whitespace', 'comments'] as const)('keeps a green chunk green after %s-only edits and scan', async (kind) => {
    await withGreenChunk(async (harness, task, source) => {
      const changed = kind === 'whitespace'
        ? `\n${source.replace(/^ {2}/gm, '    ').replace(/\n\n/g, '\n\n\n')}\n`
        : source.replace('Inclusive bounds; reject inverted ranges before clamping.', 'Clamp the value using the supplied bounds.')
          .replace('  return Math.min', '  // Preserve the inclusive bound behavior.\n  return Math.min');
      expect(changed).not.toBe(source);
      await writeFile(join(harness.fixture.root, chunkId), changed);
      const call = harness.callTool.bind(harness);
      expect((await call('scan')).structuredContent).toMatchObject({ summary: { changed: 0 } });
      expect((await mapNodes(call)).find((node) => node.id === chunkId)?.state.color).toBe('green');
      const tasks = (await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
      const unchanged = tasks.tasks.find((item) => item.chunkId === chunkId);
      expect(unchanged?.chunkHash).toBe(task.chunkHash);
      expect(unchanged?.existingStems).toHaveLength(task.count);
    });
  });
});
