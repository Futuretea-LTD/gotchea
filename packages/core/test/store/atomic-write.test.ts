// The rename retry in writeFileAtomic exists for Windows, where a rename over a file that
// another handle holds fails with EPERM for a moment. The failures are injected, so every
// platform runs the same test.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failures: { code: string; left: number } = { code: 'EPERM', left: 0 };
let renameCalls = 0;

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      renameCalls++;
      if (failures.left > 0) {
        failures.left--;
        throw Object.assign(new Error(`${failures.code}: operation not permitted, rename`), { code: failures.code });
      }
      return real.rename(from, to);
    },
  };
});

const { writeFileAtomic } = await import('../../src/store/atomic-write.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotchea-atomic-'));
  renameCalls = 0;
  failures.left = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('writeFileAtomic rename retry', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient %s and then writes the file', async (code) => {
    Object.assign(failures, { code, left: 2 });
    const p = join(dir, 'f.json');
    await writeFileAtomic(p, '{"x":1}');
    expect(renameCalls).toBe(3);
    expect(await readFile(p, 'utf8')).toBe('{"x":1}');
    expect(await readdir(dir)).toEqual(['f.json']);
  });

  it('gives up after the retries and removes the tmp file', async () => {
    Object.assign(failures, { code: 'EPERM', left: Number.POSITIVE_INFINITY });
    await expect(writeFileAtomic(join(dir, 'f.json'), 'x')).rejects.toMatchObject({ code: 'EPERM' });
    expect(renameCalls).toBe(8);
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not retry other errors', async () => {
    Object.assign(failures, { code: 'ENOSPC', left: 1 });
    await expect(writeFileAtomic(join(dir, 'f.json'), 'x')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(renameCalls).toBe(1);
  });
});
