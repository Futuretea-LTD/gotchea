import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore } from 'gotchea-core';
import { FsQuestionStore } from 'gotchea-core/internal';
import type { StatusJson } from '../src/program.js';
import { NOW, answerDataIn, createSandbox, question, type Sandbox } from './helpers.js';

let s: Sandbox;

beforeEach(async () => {
  s = await createSandbox();
});

afterEach(async () => {
  await s.cleanup();
});

describe('gotchea status', () => {
  it('fails with an init hint before init', async () => {
    const r = await s.gotchea(['status']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not initialized');
    expect(r.stderr).toContain('gotchea init');
  });

  it('hints at scan when nothing is tracked yet', async () => {
    await s.gotchea(['init']);
    const r = await s.gotchea(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Nothing tracked yet. Run `gotchea scan` first.\n');
  });

  it('summarizes chunks, questions, due and color distribution', async () => {
    await s.gotchea(['init']);
    await s.gotchea(['scan']);
    const math = (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === 'src/math.ts')!;
    await new FsQuestionStore(s.root).save(math.id, [question(math.id, math.contentHash)]);

    const r = await s.gotchea(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('8 chunks tracked');
    expect(r.stdout).toContain('1 question\n');
    expect(r.stdout).toContain('0 due for review');
    // Every leaf is either red (has a question, never passed) or grey (no questions).
    expect(r.stdout).toMatch(/^ +1 red$/m);
    expect(r.stdout).toMatch(/^ +\d+ grey$/m);
    expect(r.stdout).toMatch(/^ +0 green$/m);
  });

  it('--json reports scanned: false before the first scan, then the numbers', async () => {
    await s.gotchea(['init']);
    const before = await s.gotchea(['status', '--json']);
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual({
      version: 1,
      generatedAt: NOW.toISOString(),
      scanned: false,
      chunks: 0,
      leaves: 0,
      questions: 0,
      due: 0,
      colors: { grey: 0, red: 0, yellow: 0, green: 0 },
    });

    await s.gotchea(['scan']);
    const math = (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === 'src/math.ts')!;
    await new FsQuestionStore(s.root).save(math.id, [question(math.id, math.contentHash)]);
    const r = await s.gotchea(['status', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as StatusJson;
    expect(json).toMatchObject({ version: 1, generatedAt: NOW.toISOString(), scanned: true, chunks: 8, questions: 1, due: 0 });
    expect(json.colors.red).toBe(1);
    expect(json.colors.green + json.colors.yellow).toBe(0);
    expect(json.colors.grey).toBe(json.leaves - 1);
    expect(answerDataIn(r.stdout)).toEqual([]);
  });
});
