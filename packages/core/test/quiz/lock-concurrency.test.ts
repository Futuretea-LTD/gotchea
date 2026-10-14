// Cross-process behaviour of the repo lock (M3_DESIGN.md §5, §10.5): mutual exclusion between real OS
// processes, no lost or corrupted progress writes, stale-lock recovery from a SIGKILLed holder, and timeouts.
// Child processes can't import TypeScript under vitest, so the worker is bundled with esbuild (resolved via tsup).
import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LockTimeoutError, inspectRepoLock, withRepoLock } from '../../src/store/repo-lock.js';
import { FsProgressStore } from '../../src/store/progress-store.js';
import { userPaths } from '../../src/store/paths.js';

const WORKER_SRC = fileURLToPath(new URL('../workers/lock-worker.ts', import.meta.url));
const REPO = 'repo-lock-conc';

let outDir: string;
let workerJs: string;
const spawned: ChildProcess[] = [];

beforeAll(async () => {
  const requireFromTsup = createRequire(createRequire(import.meta.url).resolve('tsup/package.json'));
  const esbuild = requireFromTsup('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> };
  outDir = await mkdtemp(join(tmpdir(), 'gotchea-lock-worker-'));
  workerJs = join(outDir, 'worker.mjs');
  await esbuild.build({
    entryPoints: [WORKER_SRC],
    outfile: workerJs,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    // zod etc. are bundled; node builtins stay external. `require` shim for CJS deps inside the ESM bundle.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}, 60_000);

afterAll(async () => {
  for (const p of spawned) if (p.exitCode === null) p.kill('SIGKILL');
  await rm(outDir, { recursive: true, force: true });
});

const freshHome = () => mkdtemp(join(tmpdir(), 'gotchea-lock-home-'));

function run(args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } {
  const child = spawn(process.execPath, [workerJs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(child);
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => void (stderr += d));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  return { child, done };
}

/** Resolves when the child prints `locked`. */
const whenLocked = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('locked') && resolve());
    child.on('close', () => reject(new Error('holder exited before locking')));
  });

async function counterRun(useLock: boolean, procs: number, iterations: number): Promise<{ counter: number; log: string[]; codes: (number | null)[]; stderr: string }> {
  const home = await freshHome();
  const dir = await mkdtemp(join(tmpdir(), 'gotchea-lock-ctr-'));
  const counterFile = join(dir, 'counter');
  const logFile = join(dir, 'log');
  await writeFile(counterFile, '0');
  await writeFile(logFile, '');
  const results = await Promise.all(Array.from({ length: procs }, () => run(['counter', REPO, home, counterFile, logFile, String(iterations), useLock ? 'lock' : 'nolock']).done));
  const log = (await readFile(logFile, 'utf8')).trim().split('\n');
  const out = { counter: Number(await readFile(counterFile, 'utf8')), log, codes: results.map((r) => r.code), stderr: results.map((r) => r.stderr).join('') };
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  return out;
}

describe('mutual exclusion between processes', () => {
  it('6 processes × 25 increments under the lock lose nothing and never overlap', async () => {
    const r = await counterRun(true, 6, 25);
    expect(r.stderr).toBe('');
    expect(r.codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.counter).toBe(150);
    // Events sorted by the system-wide monotonic clock must strictly alternate enter/exit of the same pid.
    const events = r.log.map((l) => l.split(' ') as [string, 'enter' | 'exit', string]).sort((x, y) => (BigInt(x[0]) < BigInt(y[0]) ? -1 : BigInt(x[0]) > BigInt(y[0]) ? 1 : 0));
    expect(events).toHaveLength(300);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]![1], `event ${i}`).toBe('enter');
      expect(events[i + 1]![1], `event ${i + 1}`).toBe('exit');
      expect(events[i + 1]![2], `exit pid at ${i + 1}`).toBe(events[i]![2]);
    }
  }, 120_000);

  it('control: without the lock the same workload loses updates (so the test above can fail)', async () => {
    const r = await counterRun(false, 6, 25);
    expect(r.counter).toBeLessThan(150);
  }, 60_000);
});

describe('no lost or corrupt progress writes (real scoring path, concurrent CLI-like and MCP-like writers)', () => {
  it('N processes scoring the same and different chunks keep every history entry', async () => {
    const home = await freshHome();
    const env = { GOTCHEA_HOME: home };
    const writers = [
      run(['score', REPO, home, 'src/a.ts', 'a', '8']),
      run(['score', REPO, home, 'src/a.ts', 'b', '8']),
      run(['score', REPO, home, 'src/a.ts', 'c', '8']),
      run(['score', REPO, home, 'src/b.ts', 'd', '8']),
      run(['score', REPO, home, 'src/b.ts', 'e', '8']),
    ];
    // Meanwhile this process (an "MCP server") also writes through the same lock.
    const inProc = Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        await withRepoLock(REPO, async () => {
          const store = new FsProgressStore(REPO, env);
          const f = await store.load();
          const prev = f.chunks['src/c.ts'];
          await store.save({ ...f, chunks: { ...f.chunks, 'src/c.ts': { ...(prev ?? { stability: null, lastReviewedAt: null, lastPassedHash: null, lastSeenHash: 'h', mustRepass: false, history: [] }), history: [...(prev?.history ?? []), { at: new Date().toISOString(), passed: true, hash: 'h', sessionId: `qs_z${String(i).padStart(15, '0')}`, questionIds: [], correct: 3, total: 3 }] } } });
        }, { env, timeoutMs: 60_000 });
      }),
    );
    const results = await Promise.all(writers.map((w) => w.done));
    await inProc;
    for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });

    // The file parses and every entry survived.
    const raw = await readFile(userPaths(REPO, env).progress, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const progress = await new FsProgressStore(REPO, env).load();
    const ids = (c: string) => (progress.chunks[c]?.history ?? []).map((h) => h.sessionId);
    expect(ids('src/a.ts')).toHaveLength(24);
    expect(new Set(ids('src/a.ts')).size).toBe(24);
    expect(ids('src/b.ts')).toHaveLength(16);
    expect(new Set(ids('src/b.ts')).size).toBe(16);
    expect(ids('src/c.ts')).toHaveLength(10);
    // No lock and no atomic-write debris left behind.
    expect(await inspectRepoLock(REPO, env)).toBeNull();
    const leftovers = (await readdir(userPaths(REPO, env).repoDir)).filter((n) => n.endsWith('.tmp') || n.startsWith('.lock'));
    expect(leftovers).toEqual([]);
    await rm(home, { recursive: true, force: true });
  }, 120_000);
});

describe('stale locks and timeouts with real processes', () => {
  it('recovers immediately from a holder that was SIGKILLed (dead pid, same host)', async () => {
    const home = await freshHome();
    const env = { GOTCHEA_HOME: home };
    const holder = run(['hold', REPO, home]);
    await whenLocked(holder.child);
    expect((await inspectRepoLock(REPO, env))?.holder?.pid).toBe(holder.child.pid);
    holder.child.kill('SIGKILL'); // no exit hook runs: the lock file stays behind
    await holder.done;
    const left = await inspectRepoLock(REPO, env);
    expect(left?.holder?.pid).toBe(holder.child.pid);
    expect(left?.stale).toBe(true);

    const t0 = Date.now();
    const out = await withRepoLock(REPO, async () => 'acquired', { env, timeoutMs: 5_000 });
    expect(out).toBe('acquired');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await inspectRepoLock(REPO, env)).toBeNull();
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  it('a live holder makes a second process time out with a typed error naming the holder; it succeeds after release', async () => {
    const home = await freshHome();
    const env = { GOTCHEA_HOME: home };
    const holder = run(['hold', REPO, home]);
    await whenLocked(holder.child);

    const t0 = Date.now();
    const err = await withRepoLock(REPO, async () => 'never', { env, timeoutMs: 400 }).catch((e: unknown) => e);
    const waited = Date.now() - t0;
    expect(err).toBeInstanceOf(LockTimeoutError);
    const lt = err as LockTimeoutError;
    expect(lt.holder?.pid).toBe(holder.child.pid);
    expect(lt.holder?.cmd).toBe('hold');
    expect(lt.message).toContain(String(holder.child.pid));
    expect(waited).toBeGreaterThanOrEqual(390);
    expect(waited).toBeLessThan(3_000);
    // The failed attempt must not have disturbed the holder's lock.
    expect((await inspectRepoLock(REPO, env))?.holder?.pid).toBe(holder.child.pid);

    // GOTCHEA_LOCK_TIMEOUT_MS sets the default.
    const viaEnv = await withRepoLock(REPO, async () => 'never', { env: { ...env, GOTCHEA_LOCK_TIMEOUT_MS: '150' } }).catch((e: unknown) => e);
    expect(viaEnv).toBeInstanceOf(LockTimeoutError);

    // The holder's heartbeat keeps the lock fresh well past a short staleness window.
    await new Promise((r) => setTimeout(r, 600));
    const stillHeld = await withRepoLock(REPO, async () => 'never', { env, timeoutMs: 100, staleMs: 400 }).catch((e: unknown) => e);
    expect(stillHeld).toBeInstanceOf(LockTimeoutError);

    holder.child.kill('SIGKILL');
    await holder.done;
    expect(await withRepoLock(REPO, async () => 'ok', { env, timeoutMs: 2_000 })).toBe('ok');
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  it('a waiting process takes over once the holder dies mid-wait', async () => {
    const home = await freshHome();
    const env = { GOTCHEA_HOME: home };
    const holder = run(['hold', REPO, home]);
    await whenLocked(holder.child);
    setTimeout(() => holder.child.kill('SIGKILL'), 200);
    // Waits ~200 ms, then breaks the dead holder's lock.
    expect(await withRepoLock(REPO, async () => 'got it', { env, timeoutMs: 10_000 })).toBe('got it');
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  it('two processes racing to break one stale lock both finish, and exactly one holds it at a time', async () => {
    const home = await freshHome();
    const env = { GOTCHEA_HOME: home };
    const dir = userPaths(REPO, env).repoDir;
    await mkdir(dir, { recursive: true });
    const stale = { v: 1, pid: 2_147_000_000, host: (await import('node:os')).hostname(), token: 'dead', startedAt: new Date(0).toISOString(), cmd: 'ghost' };
    await writeFile(userPaths(REPO, env).lock, JSON.stringify(stale));
    const tmp = await mkdtemp(join(tmpdir(), 'gotchea-lock-race-'));
    const counterFile = join(tmp, 'counter');
    const logFile = join(tmp, 'log');
    await writeFile(counterFile, '0');
    await writeFile(logFile, '');
    const rs = await Promise.all(Array.from({ length: 4 }, () => run(['counter', REPO, home, counterFile, logFile, '10', 'lock']).done));
    expect(rs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(await readFile(counterFile, 'utf8')).toBe('40');
    expect(await inspectRepoLock(REPO, env)).toBeNull();
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }, 60_000);
});
