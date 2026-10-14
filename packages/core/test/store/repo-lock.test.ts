import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userPaths } from '../../src/store/paths.js';
import { LockTimeoutError, inspectRepoLock, withRepoLock } from '../../src/store/repo-lock.js';

const setup = async () => {
  const env = { GOTCHEA_HOME: await mkdtemp(join(tmpdir(), 'gotchea-lock-')) };
  return { env, path: userPaths('r1', env).lock };
};
const holder = (pid: number, host: string) => JSON.stringify({ v: 1, pid, host, token: 't', startedAt: new Date().toISOString(), cmd: 'scan' });

describe('withRepoLock', () => {
  it('writes the holder, releases afterwards and is re-entrant', async () => {
    const { env, path } = await setup();
    await withRepoLock('r1', async () => {
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid, cmd: 'x' });
      await withRepoLock('r1', async () => undefined, { env });
    }, { env, label: 'x' });
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });

  it('releases when fn throws', async () => {
    const { env } = await setup();
    await expect(withRepoLock('r1', async () => Promise.reject(new Error('boom')), { env })).rejects.toThrow('boom');
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });

  it('serialises concurrent callers in one process', async () => {
    const { env } = await setup();
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withRepoLock('r1', async () => {
          max = Math.max(max, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }, { env }),
      ),
    );
    expect(max).toBe(1);
  });

  it('recovers a lock whose holder pid is dead on this host', async () => {
    const { env, path } = await setup();
    await withRepoLock('r1', async () => undefined, { env });
    await writeFile(path, holder(999999, 'h'));
    const out = await withRepoLock('r1', async () => 'ok', { env, host: 'h', isPidAlive: () => false });
    expect(out).toBe('ok');
  });

  it('times out on a live fresh holder and breaks one whose heartbeat stopped', async () => {
    const { env, path } = await setup();
    await withRepoLock('r1', async () => undefined, { env });
    await writeFile(path, holder(42, 'other'));
    await expect(withRepoLock('r1', async () => 1, { env, timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    expect(await withRepoLock('r1', async () => 2, { env, timeoutMs: 500 })).toBe(2);
  });

  it('breaks an empty lock file only after the grace period', async () => {
    const { env, path } = await setup();
    await withRepoLock('r1', async () => undefined, { env });
    await writeFile(path, '');
    await expect(withRepoLock('r1', async () => 1, { env, timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    expect(await withRepoLock('r1', async () => 3, { env, timeoutMs: 500 })).toBe(3);
  });

  it('aborts a wait', async () => {
    const { env, path } = await setup();
    await withRepoLock('r1', async () => undefined, { env });
    await writeFile(path, holder(42, 'other'));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(withRepoLock('r1', async () => 1, { env, signal: ac.signal })).rejects.toThrow();
  });
});
