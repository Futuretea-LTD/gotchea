// Releasing the lock when `unlink` keeps failing (Windows: antivirus / indexers briefly hold
// the file). Failures are injected, so every platform runs this.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fail = { unlink: 0, code: 'EPERM', calls: 0 };

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      fail.calls++;
      if (fail.unlink > 0) {
        fail.unlink--;
        throw Object.assign(new Error(`${fail.code}: unlink`), { code: fail.code });
      }
      return real.unlink(...args);
    },
  };
});

const { withRepoLock, inspectRepoLock } = await import('../../src/store/repo-lock.js');
const { userPaths } = await import('../../src/store/paths.js');

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gotchea-lock-unlink-'));
  Object.assign(fail, { unlink: 0, code: 'EPERM', calls: 0 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
});

describe('withRepoLock release with a failing unlink', () => {
  it('retries a transient EPERM and still frees the lock', async () => {
    const env = { GOTCHEA_HOME: home };
    fail.unlink = 2;
    expect(await withRepoLock('r1', async () => 'ok', { env })).toBe('ok');
    expect(fail.calls).toBe(3);
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });

  it('gives up after a few EPERMs without failing the caller; the file is left to go stale', async () => {
    const env = { GOTCHEA_HOME: home };
    fail.unlink = 100;
    expect(await withRepoLock('r1', async () => 'done', { env, label: 'scan' })).toBe('done');
    expect(fail.calls).toBe(4); // first try + 3 retries
    expect(JSON.parse(await readFile(userPaths('r1', env).lock, 'utf8'))).toMatchObject({ cmd: 'scan', pid: process.pid });
  });

  it('a non-EPERM unlink error on release is swallowed as well (the result of fn wins)', async () => {
    const env = { GOTCHEA_HOME: home };
    Object.assign(fail, { unlink: 1, code: 'EIO' });
    expect(await withRepoLock('r1', async () => 7, { env })).toBe(7);
    expect(fail.calls).toBe(1);
  });

  it('an error thrown by fn is not masked by a failing release', async () => {
    const env = { GOTCHEA_HOME: home };
    fail.unlink = 100;
    await expect(withRepoLock('r1', async () => Promise.reject(new Error('boom')), { env })).rejects.toThrow('boom');
  });
});
