// Edge cases of the cross-process lock: contention notices, the `.lock.break` handshake,
// heartbeat, release of a lock we no longer own, and "other processes" (separate module
// instances share the file but not the in-process queue). Clock and pids are injected.
import { mkdir, mkdtemp, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { userPaths } from '../../src/store/paths.js';
import { type LockHolder, LockTimeoutError, inspectRepoLock, withRepoLock } from '../../src/store/repo-lock.js';

const setup = async () => {
  const env = { GOTCHEA_HOME: await mkdtemp(join(tmpdir(), 'gotchea-lock-edge-')) };
  return { env, path: userPaths('r1', env).lock };
};
const holderJson = (over: Partial<LockHolder> = {}) =>
  JSON.stringify({ v: 1, pid: 42, host: 'other', token: 'foreign', startedAt: new Date().toISOString(), cmd: 'scan', ...over });
/** Creates the repo dir (withRepoLock mkdirs it), so tests can plant files before the first acquire. */
const prime = async (env: { GOTCHEA_HOME: string }) => withRepoLock('r1', async () => undefined, { env });
const ago = async (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  await utimes(path, t, t);
};

describe('withRepoLock: waiting and timing out', () => {
  it('calls onWait once after 1 s and times out with a message naming the holder and the lock path', async () => {
    const { env, path } = await setup();
    await prime(env);
    await writeFile(path, holderJson({ pid: 4242, cmd: 'quiz' }));
    let offset = 0;
    const onWait = vi.fn();
    const err = await withRepoLock('r1', async () => 1, {
      env,
      timeoutMs: 5_000,
      staleMs: 1e9,
      now: () => Date.now() + offset,
      sleep: async () => {
        offset += 400;
      },
      onWait,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect(onWait).toHaveBeenCalledTimes(1);
    const [who, waited] = onWait.mock.calls[0] as [LockHolder, number];
    expect(who).toMatchObject({ pid: 4242, cmd: 'quiz' });
    expect(waited).toBeGreaterThanOrEqual(1_000);
    const e = err as LockTimeoutError;
    expect(e.holder?.pid).toBe(4242);
    expect(e.path).toBe(path);
    expect(e.message).toContain('pid 4242');
    expect(e.message).toContain('"quiz"');
    expect(e.message).toContain(path);
    expect(e.message).not.toMatch(/\n\s+at /); // a sentence, not a stack
    expect(e.message).toContain('delete'); // says how to recover
  });

  it('reports "unknown holder" for an unparseable lock that is still within the grace period', async () => {
    const { env, path } = await setup();
    await prime(env);
    await writeFile(path, '{not json');
    const err = (await withRepoLock('r1', async () => 1, { env, timeoutMs: 60 }).catch((e: unknown) => e)) as LockTimeoutError;
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect(err.holder).toBeNull();
    expect(err.message).toContain('unknown holder');
  });

  it('treats JSON of the wrong shape (no token / wrong version) as an unknown holder, and recovers it once old', async () => {
    const { env, path } = await setup();
    await prime(env);
    for (const raw of ['null', '[]', JSON.stringify({ v: 2, pid: 1, token: 't' }), JSON.stringify({ v: 1, pid: '1', token: 't' })]) {
      await writeFile(path, raw);
      expect((await inspectRepoLock('r1', env))?.holder).toBeNull();
      await ago(path, 10_000);
      expect(await withRepoLock('r1', async () => 'ok', { env, timeoutMs: 500 })).toBe('ok');
    }
  });

  it('does not use the pid check for a holder on another host: only the heartbeat age decides', async () => {
    const { env, path } = await setup();
    await prime(env);
    await writeFile(path, holderJson({ host: 'elsewhere' }));
    const isPidAlive = vi.fn(() => false);
    await expect(withRepoLock('r1', async () => 1, { env, host: 'here', isPidAlive, timeoutMs: 60 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it('GOTCHEA_LOCK_TIMEOUT_MS sets the default wait; an invalid value falls back to the default', async () => {
    const { env, path } = await setup();
    await prime(env);
    await writeFile(path, holderJson());
    const t0 = Date.now();
    await expect(withRepoLock('r1', async () => 1, { env: { ...env, GOTCHEA_LOCK_TIMEOUT_MS: '60' } })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - t0).toBeLessThan(5_000);
    // 'abc' / '-5' are not positive numbers: the 30 s default applies (proved with an injected clock, no real wait).
    for (const bad of ['abc', '-5']) {
      let offset = 0;
      const err = (await withRepoLock('r1', async () => 1, {
        env: { ...env, GOTCHEA_LOCK_TIMEOUT_MS: bad },
        staleMs: 1e9,
        now: () => Date.now() + offset,
        sleep: async () => {
          offset += 5_000;
        },
      }).catch((e: unknown) => e)) as LockTimeoutError;
      expect(err.waitedMs).toBeGreaterThanOrEqual(30_000);
      expect(err.waitedMs).toBeLessThan(40_000);
    }
  });
});

describe('withRepoLock: breaking a stale lock', () => {
  const stale = (path: string) => writeFile(path, holderJson({ host: 'h' }));

  it('backs off while another waiter holds a fresh .lock.break, then times out', async () => {
    const { env, path } = await setup();
    await prime(env);
    await stale(path);
    await writeFile(`${path}.break`, holderJson({ token: 'breaker' }));
    const err = await withRepoLock('r1', async () => 1, { env, host: 'h', isPidAlive: () => false, timeoutMs: 80 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    // The other breaker's file is left alone, and so is the lock it is about to break.
    expect(await readFile(`${path}.break`, 'utf8')).toContain('breaker');
    expect(await readFile(path, 'utf8')).toContain('"pid":42');
  });

  it('removes an abandoned .lock.break (older than 10 s) and then takes the stale lock', async () => {
    const { env, path } = await setup();
    await prime(env);
    await stale(path);
    await writeFile(`${path}.break`, holderJson({ token: 'dead-breaker' }));
    await ago(`${path}.break`, 60_000);
    expect(await withRepoLock('r1', async () => 'ok', { env, host: 'h', isPidAlive: () => false, timeoutMs: 2_000 })).toBe('ok');
    await expect(stat(`${path}.break`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });

  it("re-checks staleness under .lock.break: a lock refreshed meanwhile is not deleted", async () => {
    const { env, path } = await setup();
    await prime(env);
    await stale(path);
    // The lock looks stale at the first check (dead pid) but is alive on the re-check.
    let calls = 0;
    const isPidAlive = () => ++calls > 1;
    await expect(withRepoLock('r1', async () => 1, { env, host: 'h', isPidAlive, timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await readFile(path, 'utf8')).toContain('"pid":42');
    await expect(stat(`${path}.break`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inspectRepoLock reports stale for a dead pid on this host, with the holder', async () => {
    const { env, path } = await setup();
    await prime(env);
    await writeFile(path, holderJson({ host: (await import('node:os')).hostname(), pid: 2 ** 22 + 12345 }));
    const info = await inspectRepoLock('r1', env);
    expect(info?.holder?.pid).toBe(2 ** 22 + 12345);
    expect(info?.stale).toBe(true); // real process.kill(pid, 0) → ESRCH
    expect(info?.ageMs).toBeLessThan(5_000); // mtime vs Date.now(): sub-ms jitter can make it slightly negative
  });

  it('inspectRepoLock: a fresh foreign lock is live, an old one is stale, an unreadable one has no holder', async () => {
    const { env, path } = await setup();
    await prime(env);
    await writeFile(path, holderJson());
    expect((await inspectRepoLock('r1', env))?.stale).toBe(false);
    await ago(path, 60_000);
    expect((await inspectRepoLock('r1', env))?.stale).toBe(true);
    await writeFile(path, 'garbage');
    expect(await inspectRepoLock('r1', env)).toMatchObject({ holder: null, stale: false });
  });
});

describe('withRepoLock: heartbeat and release', () => {
  it('touches the lock file while fn runs (heartbeat)', async () => {
    const { env, path } = await setup();
    let before = 0;
    let after = 0;
    await withRepoLock(
      'r1',
      async () => {
        before = (await stat(path)).mtimeMs;
        await new Promise((r) => setTimeout(r, 150));
        after = (await stat(path)).mtimeMs;
      },
      { env, heartbeatMs: 10 },
    );
    expect(after).toBeGreaterThan(before);
  });

  it('release leaves a lock that now belongs to someone else (broken as stale while we ran)', async () => {
    const { env, path } = await setup();
    await withRepoLock(
      'r1',
      async () => {
        await writeFile(path, holderJson({ token: 'new-owner' }));
      },
      { env },
    );
    expect(await readFile(path, 'utf8')).toContain('new-owner');
  });

  it('release is a no-op when the lock file is already gone, or unreadable garbage', async () => {
    const { env, path } = await setup();
    await expect(withRepoLock('r1', async () => unlink(path).then(() => 'gone'), { env })).resolves.toBe('gone');
    await expect(withRepoLock('r1', async () => writeFile(path, 'garbage').then(() => 'junk'), { env })).resolves.toBe('junk');
    expect(await readFile(path, 'utf8')).toBe('garbage'); // not ours (no matching token): untouched
  });

  it('a lock for another repo does not block, and the nested re-entry is per repo', async () => {
    const { env } = await setup();
    const order: string[] = [];
    await withRepoLock('r1', async () => {
      order.push('r1');
      await withRepoLock('r2', async () => void order.push('r2'), { env, timeoutMs: 200 });
    }, { env });
    expect(order).toEqual(['r1', 'r2']);
  });

  it('a second call after release acquires again (release really frees it)', async () => {
    const { env } = await setup();
    for (let i = 0; i < 3; i++) expect(await withRepoLock('r1', async () => i, { env, timeoutMs: 200 })).toBe(i);
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });
});

describe('withRepoLock: several "processes" (separate module instances, one lock file)', () => {
  it('keeps a read-modify-write critical section exclusive and recovers a dead holder first', async () => {
    const { env, path } = await setup();
    await prime(env);
    const counter = join(env.GOTCHEA_HOME, 'counter');
    await writeFile(counter, '0');
    // A crashed process left its lock behind.
    await writeFile(path, holderJson({ host: 'h', pid: 999_999 }));

    const instances = [];
    for (let i = 0; i < 4; i++) {
      vi.resetModules();
      instances.push(await import('../../src/store/repo-lock.js'));
    }
    // Distinct instances have distinct in-process queues, so only the lock file serialises them.
    expect(new Set(instances.map((m) => m.withRepoLock)).size).toBe(4);

    let active = 0;
    let max = 0;
    await Promise.all(
      instances.map((m) =>
        m.withRepoLock(
          'r1',
          async () => {
            max = Math.max(max, ++active);
            const n = Number(await readFile(counter, 'utf8'));
            await new Promise((r) => setTimeout(r, 15));
            await writeFile(counter, String(n + 1));
            active--;
          },
          { env, host: 'h', isPidAlive: (pid) => pid !== 999_999, timeoutMs: 20_000 },
        ),
      ),
    );
    expect(max).toBe(1);
    expect(await readFile(counter, 'utf8')).toBe('4');
    expect(await inspectRepoLock('r1', env)).toBeNull();
  });
});

describe('withRepoLock: unexpected filesystem errors and process exit', () => {
  it('surfaces a non-contention error (lock path is a directory → EISDIR) instead of spinning', async () => {
    const { env, path } = await setup();
    await prime(env);
    await mkdir(path);
    await expect(withRepoLock('r1', async () => 1, { env, timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(inspectRepoLock('r1', env)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it("removes the lock files it still holds on 'exit' (SIGKILL is left to staleness), tolerating one already gone", async () => {
    const { env, path } = await setup();
    const handlers: (() => void)[] = [];
    const on = vi.spyOn(process, 'on').mockImplementation(((event: string, h: () => void) => {
      if (event === 'exit') handlers.push(h);
      return process;
    }) as never);
    try {
      vi.resetModules(); // a fresh module installs its own hook
      const fresh = await import('../../src/store/repo-lock.js');
      await fresh.withRepoLock('r1', async () => {
        expect(handlers).toHaveLength(1);
        handlers[0]!();
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        handlers[0]!(); // second run: unlink fails with ENOENT, which must not throw
      }, { env });
      // Installed once per process, not once per acquire.
      await fresh.withRepoLock('r1', async () => undefined, { env });
      expect(handlers).toHaveLength(1);
    } finally {
      on.mockRestore();
    }
  });
});
