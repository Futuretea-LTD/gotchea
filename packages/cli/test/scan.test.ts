import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsQuestionStore } from 'gotchea-core/internal';
import { FsChunkStore, FsProgressStore, computeRepoId, type ChunksFile } from 'gotchea-core';
import { NOW, createSandbox, question, type Sandbox } from './helpers.js';

let s: Sandbox;

beforeEach(async () => {
  s = await createSandbox();
});

afterEach(async () => {
  await s.cleanup();
});

const chunksJson = async (): Promise<ChunksFile> => JSON.parse(await readFile(join(s.root, '.gotchea', 'chunks.json'), 'utf8'));

/** `<n> <label>` row of the summary. */
const count = (stdout: string, label: string) => Number(new RegExp(`^\\s+(\\d+) ${label}$`, 'm').exec(stdout)?.[1]);

describe('gotchea scan', () => {
  it('fails with a helpful message before init', async () => {
    const r = await s.gotchea(['scan']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not initialized');
    expect(r.stderr).toContain('gotchea init');
  });

  it('writes chunks.json and summarizes the first scan', async () => {
    await s.gotchea(['init']);
    const r = await s.gotchea(['scan']);
    expect(r.code).toBe(0);
    // 4 source files; README.md (unsupported) and src/math.test.ts (test) are skipped.
    expect(r.stdout).toMatch(/^Scanned 4 files in \d+ ms \(2 skipped: 1 unsupported, 1 test\)$/m);
    const file = await chunksJson();
    expect(file.chunks.map((c) => c.id)).toEqual(['.', 'py', 'py/app.py', 'src', 'src/format', 'src/format/strings.ts', 'src/index.ts', 'src/math.ts']);
    expect(count(r.stdout, 'added')).toBe(8);
    expect(count(r.stdout, 'changed')).toBe(0);
    expect(count(r.stdout, 'removed')).toBe(0);
    expect(count(r.stdout, 'unchanged')).toBe(0);
    // fanIn: src/math.ts is imported by src/index.ts.
    expect(file.chunks.find((c) => c.id === 'src/math.ts')!.metrics.fanIn).toBe(1);
  });

  it('is stable: a second scan reports everything unchanged and writes identical bytes', async () => {
    await s.gotchea(['init']);
    await s.gotchea(['scan']);
    const before = await readFile(join(s.root, '.gotchea', 'chunks.json'), 'utf8');
    const r = await s.gotchea(['scan']);
    expect(count(r.stdout, 'unchanged')).toBe(8);
    expect(count(r.stdout, 'added')).toBe(0);
    expect(await readFile(join(s.root, '.gotchea', 'chunks.json'), 'utf8')).toBe(before);
  });

  it('reports changed (with changeRatio) and removed chunks, stales questions and decays progress', async () => {
    await s.gotchea(['init']);
    await s.gotchea(['scan']);
    const math = (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === 'src/math.ts')!;
    const repoId = await computeRepoId(s.root);
    await new FsQuestionStore(s.root).save(math.id, [question(math.id, math.contentHash)]);
    const progress = new FsProgressStore(repoId, s.env);
    await progress.save({
      version: 1,
      repoId,
      chunks: {
        [math.id]: {
          stability: 10,
          lastReviewedAt: NOW.toISOString(),
          lastPassedHash: math.contentHash,
          lastSeenHash: math.contentHash,
          mustRepass: false,
          history: [],
        },
      },
    });

    const src = join(s.root, 'src', 'math.ts');
    await writeFile(src, (await readFile(src, 'utf8')).replace('if (n > hi) return hi;', 'if (n >= hi) return hi;'));
    await rm(join(s.root, 'py'), { recursive: true });

    const r = await s.gotchea(['scan']);
    expect(r.code).toBe(0);
    // src/math.ts, its module src and the root module changed; py and py/app.py were removed.
    expect(count(r.stdout, 'changed')).toBe(3);
    expect(count(r.stdout, 'removed')).toBe(2);
    expect(count(r.stdout, 'unchanged')).toBe(3);
    // 1 of 30 normalized lines changed.
    expect(r.stdout).toMatch(/^ {2}src\/math\.ts\s+3%$/m);
    expect(r.stdout).toContain('1 question marked stale');
    expect(r.stdout).toContain('Progress decayed for 1 chunk');

    expect((await new FsQuestionStore(s.root).list(math.id))[0]!.status).toBe('stale');
    const p = (await progress.load()).chunks[math.id]!;
    expect(p.stability).toBeCloseTo(10 * (1 - 1 / 30), 6);
    expect((await chunksJson()).chunks.map((c) => c.id)).not.toContain('py/app.py');
  });

  describe('--json', () => {
    it('prints only the summary as JSON on stdout', async () => {
      await s.gotchea(['init']);
      const r = await s.gotchea(['scan', '--json']);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual({ added: 8, changed: 0, moved: 0, removed: 0, total: 8 });
      expect(r.stdout.endsWith('}\n')).toBe(true);
      const again = JSON.parse((await s.gotchea(['scan', '--json'])).stdout);
      expect(again).toEqual({ added: 0, changed: 0, moved: 0, removed: 0, total: 8 });
    });

    it('fails before init without writing to stdout', async () => {
      const r = await s.gotchea(['scan', '--json']);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('gotchea init');
    });
  });
});
