import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { createHarness } from '../src/harness.js';
import { generateQuestions, playQuiz } from '../src/scenarios.js';

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return children.flat();
}

it('H: a full cycle persists shared chunks/questions in the repo and personal progress only under temporary HOME', async () => {
  const harness = await createHarness();
  const call = harness.callTool.bind(harness);
  try {
    await call('scan');
    const tasks = await generateQuestions(call);
    for (const task of tasks) await playQuiz(call, task.chunkId);
    await call('get_status');
    const shared = join(harness.fixture.root, '.gotchea');
    expect((await stat(join(shared, 'chunks.json'))).isFile()).toBe(true);
    const pools = (await readdir(join(shared, 'questions'))).filter((name) => name.endsWith('.json'));
    expect(pools).toHaveLength(tasks.length);
    for (const name of pools) {
      const pool = JSON.parse(await readFile(join(shared, 'questions', name), 'utf8'));
      expect(tasks.map((task) => task.chunkId)).toContain(pool.chunkId);
      expect(pool.questions.length).toBeGreaterThan(0);
    }
    const all = await files(harness.fixture.directory);
    const progressFiles = all.filter((path) => path.endsWith('/progress.json'));
    expect(progressFiles).toHaveLength(1);
    expect(relative(harness.fixture.home, progressFiles[0]!)).toMatch(/^\.gotchea\/repos\/[^/]+\/progress\.json$/);
    expect(all.filter((path) => path.startsWith(`${harness.fixture.root}/`) && /progress|\/sessions\//i.test(path))).toEqual([]);
    const progress = JSON.parse(await readFile(progressFiles[0]!, 'utf8'));
    for (const task of tasks) {
      expect(progress.chunks[task.chunkId].history).toHaveLength(1);
      expect(progress.chunks[task.chunkId].lastReviewedAt).toEqual(expect.any(String));
    }
    await harness.restart();
    expect((await call('get_status')).structuredContent).toMatchObject({ colors: { green: tasks.length } });
    expect(JSON.parse(await readFile(progressFiles[0]!, 'utf8'))).toEqual(progress);
  } finally {
    await harness.dispose();
  }
});
