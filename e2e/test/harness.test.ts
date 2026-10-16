import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, createHarness, type McpHarness, resolveTarget } from '../src/harness.js';
import { renderReport } from '../src/reporter.js';

const exec = promisify(execFile);
const harnesses: McpHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

it('resolves local and registry targets without shell interpolation', () => {
  expect(resolveTarget('local').args[0]).toMatch(/packages[/\\]cli[/\\]dist[/\\]index\.js$/);
  expect(resolveTarget('published')).toEqual({ command: 'npx', args: ['-y', 'gotchea@latest'] });
  expect(resolveTarget('version:1.2.3')).toEqual({ command: 'npx', args: ['-y', 'gotchea@1.2.3'] });
  expect(() => resolveTarget('version:latest')).toThrow('Invalid GOTCHEA_TARGET');
  expect(() => resolveTarget('version:1.2.3;echo unsafe')).toThrow('Invalid GOTCHEA_TARGET');
});

it('creates an isolated committed fixture and overrides caller home settings', async () => {
  const fixture = await createFixture({ HOME: '/must-not-use', USERPROFILE: '/must-not-use', GOTCHEA_HOME: '/must-not-use', GIT_DIR: '/must-not-use' });
  try {
    expect(fixture.env['HOME']).toBe(fixture.home);
    expect(fixture.env['USERPROFILE']).toBe(fixture.home);
    expect(fixture.env['GOTCHEA_HOME']).toBe(join(fixture.home, '.gotchea'));
    expect(fixture.env['GIT_DIR']).toBeUndefined();
    const result = await exec('git', ['status', '--porcelain'], { cwd: fixture.root, env: fixture.env });
    expect(result.stdout).toBe('');
    const commit = await exec('git', ['log', '-1', '--format=%s'], { cwd: fixture.root, env: fixture.env });
    expect(commit.stdout.trim()).toBe('Initial fixture');
    expect(await readFile(join(fixture.root, 'src/math.ts'), 'utf8')).toContain('export function clamp');
  } finally {
    await fixture.dispose();
  }
  await expect(access(fixture.directory)).rejects.toThrow();
});

it('formats scenario status, duration and escaped error summaries', () => {
  const report = renderReport([{ scenario: 'scan | init', status: 'failed', durationMs: 12.34, errors: ['failure\n<script>'] }], 'local', 'failed');
  expect(report).toContain('| scan &#124; init | failed | 12.3 | failure &lt;script&gt; |');
  expect(renderReport([], 'local', 'failed')).toContain('No scenarios collected');
  expect(renderReport([{ scenario: 'scan', status: 'passed', notes: ['measurement: 200 files | 42 ms'] }], 'local', 'passed'))
    .toContain('measurement: 200 files &#124; 42 ms');
});

describe('MCP stdio server', () => {
  it.skipIf((process.env['GOTCHEA_TARGET'] ?? 'local') !== 'local')('applies the overridden clock in a real server and updates it on restart', async () => {
    const firstNow = '2030-01-01T00:00:00.000Z';
    const secondNow = '2030-02-01T00:00:00.000Z';
    const harness = await createHarness({ now: firstNow });
    harnesses.push(harness);
    await harness.callTool('scan');
    const chunks = JSON.parse(await readFile(join(harness.fixture.root, '.gotchea/chunks.json'), 'utf8'));
    const leaves = chunks.chunks.filter((chunk: { isLeaf: boolean }) => chunk.isLeaf) as { id: string; contentHash: string }[];
    const question = {
      type: 'behavior', stem: 'What happens when the requested value violates the input guard?',
      options: ['The operation fails', 'The operation repeats', 'The input is doubled', 'The input is ignored'],
      correctIndex: 0, explanation: 'L1-L4 reject the invalid input before changing the result.',
      refs: [{ start: 1, end: 4 }], difficulty: 1,
    };
    const save = async (leaf: { id: string; contentHash: string }) => {
      const result = await harness.callTool('save_questions', { chunkId: leaf.id, chunkHash: leaf.contentHash, questions: [question] });
      expect(result.structuredContent).toMatchObject({ savedCount: 1 });
    };
    await save(leaves[0]!);
    await harness.restart(Date.parse(secondNow));
    await save(leaves[1]!);
    const directory = join(harness.fixture.root, '.gotchea/questions');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    const createdAt: string[] = [];
    for (const file of files) {
      const pool = JSON.parse(await readFile(join(directory, file), 'utf8'));
      createdAt.push(...pool.questions.map((entry: { createdAt: string }) => entry.createdAt));
    }
    expect(createdAt.sort()).toEqual([firstNow, secondNow]);
  });
  it('scans a fresh fixture and keeps personal files in its temporary home across restart', async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const firstClient = harness.client;
    const tools = await harness.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('scan');
    const scan = await harness.callTool('scan');
    expect(scan.structuredContent).toMatchObject({ initialized: true, scanned: true, summary: { total: 4 } });
    const status = await harness.callTool('get_status');
    expect(status.structuredContent).toMatchObject({ chunks: 4, leaves: 2, questions: 0 });
    const chunks = JSON.parse(await readFile(join(harness.fixture.root, '.gotchea/chunks.json'), 'utf8'));
    expect(chunks.chunks.filter((chunk: { isLeaf: boolean }) => chunk.isLeaf).map((chunk: { id: string }) => chunk.id).sort()).toEqual(['src/account.ts', 'src/math.ts']);
    expect(await readdir(join(harness.fixture.home, '.gotchea/repos'))).toHaveLength(1);
    await harness.restart();
    expect(harness.client).not.toBe(firstClient);
    expect((await harness.callTool('get_status')).structuredContent).toEqual(status.structuredContent);
  });
});
