// On Windows a lock file that another process has just unlinked is "delete pending" while
// any handle on it is open: opening it with 'wx', or reading it, fails with EPERM instead of
// EEXIST/ENOENT. The failures and the platform are injected, so every platform runs this.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fail = { open: 0, readFile: 0, code: 'EPERM' };

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const inject = (op: 'open' | 'readFile') => {
    if (fail[op] > 0) {
      fail[op]--;
      throw Object.assign(new Error(`${fail.code}: operation not permitted, ${op}`), { code: fail.code });
    }
  };
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      inject('open');
      return real.open(...args);
    },
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      inject('readFile');
      return real.readFile(...args);
    },
  };
});

const { withRepoLock, inspectRepoLock } = await import('../../src/store/repo-lock.js');

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { ...platform, value });

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gotchea-lock-win-'));
  Object.assign(fail, { open: 0, readFile: 0, code: 'EPERM' });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
});

describe('withRepoLock on a delete-pending lock file', () => {
  it.each(['EPERM', 'EACCES'])('on win32 treats %s from open and read as contention and retries', async (code) => {
    setPlatform('win32');
    Object.assign(fail, { open: 2, readFile: 1, code });
    const env = { GOTCHEA_HOME: home };
    expect(await withRepoLock('r1', async () => 'ok', { env, timeoutMs: 5_000, sleep: async () => undefined })).toBe('ok');
    expect(fail).toMatchObject({ open: 0, readFile: 0 });
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });

  it('elsewhere EPERM is a real error', async () => {
    setPlatform('linux');
    fail.open = 1;
    await expect(withRepoLock('r1', async () => 'ok', { env: { GOTCHEA_HOME: home } })).rejects.toMatchObject({ code: 'EPERM' });
  });
});
