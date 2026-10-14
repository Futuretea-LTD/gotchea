// Cross-process lock per repository: `~/.gotchea/repos/<id>/.lock` (PLAN.md §10.23, §10.38).
// Exclusive create, holder pid + timestamp, heartbeat, stale recovery, retry with a timeout.
// Held only around read-modify-write sections; stores themselves never lock.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { isErrno } from './atomic-write.js';
import { KeyedLock } from './keyed-lock.js';
import { userPaths } from './paths.js';

export interface LockHolder {
  v: 1;
  pid: number;
  host: string;
  token: string;
  startedAt: string;
  cmd: string;
}

export interface RepoLockOptions {
  env?: NodeJS.ProcessEnv;
  /** Total wait. Default 30 000; `GOTCHEA_LOCK_TIMEOUT_MS` overrides the default. */
  timeoutMs?: number;
  /** A lock file whose mtime is older than this is stale. Default 30 000. */
  staleMs?: number;
  /** The holder touches the file this often. Default 5 000. */
  heartbeatMs?: number;
  /** Stored as `cmd`: 'scan', 'quiz', ... */
  label?: string;
  /** Called once after 1 s of waiting. */
  onWait?: (holder: LockHolder | null, waitedMs: number) => void;
  signal?: AbortSignal;
  // Test seams.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  host?: string;
}

export class LockTimeoutError extends Error {
  override readonly name = 'LockTimeoutError';

  constructor(
    readonly holder: LockHolder | null,
    readonly waitedMs: number,
    readonly path: string,
  ) {
    const who = holder ? `pid ${holder.pid}, "${holder.cmd}", ${Math.round((Date.now() - Date.parse(holder.startedAt)) / 1000)} s ago` : 'unknown holder';
    super(`Another gotchea process (${who}) holds the lock for this repository. Wait for it to finish, or delete ${path} if that process is gone.`);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
/** A lock file that is empty or unparseable this long is a writer that died between create and write. */
const EMPTY_GRACE_MS = 5_000;
const BREAK_STALE_MS = 10_000;
const WAIT_NOTICE_MS = 1_000;

const held = new AsyncLocalStorage<Set<string>>();
const queue = new KeyedLock();
/** Lock files this process holds, for the synchronous exit hook. */
const heldPaths = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const p of heldPaths) {
      try {
        unlinkSync(p);
      } catch {
        // Best effort; SIGKILL falls back to staleness.
      }
    }
  });
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isErrno(err, 'ESRCH');
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseHolder(raw: string): LockHolder | null {
  try {
    const h = JSON.parse(raw) as Partial<LockHolder>;
    return h && h.v === 1 && typeof h.pid === 'number' && typeof h.token === 'string' ? (h as LockHolder) : null;
  } catch {
    return null;
  }
}

async function readHolder(path: string): Promise<{ holder: LockHolder | null; mtimeMs: number } | null> {
  try {
    const [raw, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { holder: parseHolder(raw), mtimeMs: st.mtimeMs };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

interface Resolved {
  timeoutMs: number;
  staleMs: number;
  heartbeatMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  pid: number;
  host: string;
}

function isStale(h: { holder: LockHolder | null; mtimeMs: number }, r: Resolved): boolean {
  const age = r.now() - h.mtimeMs;
  if (!h.holder) return age > EMPTY_GRACE_MS;
  if (h.holder.host === r.host && !r.isPidAlive(h.holder.pid)) return true;
  return age > r.staleMs;
}

/** Creates `path` exclusively and writes the holder; false when it already exists. */
async function tryCreate(path: string, holder: LockHolder): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(path, 'wx');
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return false;
    throw err;
  }
  try {
    await fh.writeFile(JSON.stringify(holder));
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

async function unlinkRetry(path: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await unlink(path);
      return;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return;
      // Windows: antivirus or indexers can briefly hold the file.
      if (isErrno(err, 'EPERM') && i < 3) {
        await defaultSleep(20);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Breaks a stale lock. Breakers are serialised by `.lock.break`, and the staleness is
 * re-checked on the current contents, so two waiters can't each delete the other's fresh lock.
 */
async function breakStale(path: string, holder: LockHolder, r: Resolved): Promise<boolean> {
  const breakPath = `${path}.break`;
  if (!(await tryCreate(breakPath, holder))) {
    const b = await readHolder(breakPath);
    if (b && r.now() - b.mtimeMs > BREAK_STALE_MS) await unlinkRetry(breakPath);
    return false;
  }
  try {
    const current = await readHolder(path);
    if (current && isStale(current, r)) await unlinkRetry(path);
  } finally {
    await unlinkRetry(breakPath);
  }
  return true;
}

async function acquire(path: string, opts: RepoLockOptions, r: Resolved): Promise<LockHolder> {
  const holder: LockHolder = {
    v: 1,
    pid: r.pid,
    host: r.host,
    token: randomBytes(16).toString('hex'),
    startedAt: new Date(r.now()).toISOString(),
    cmd: opts.label ?? 'gotchea',
  };
  const started = r.now();
  let notified = false;
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    if (await tryCreate(path, holder)) return holder;
    const cur = await readHolder(path);
    if (cur === null) continue;
    const waited = r.now() - started;
    if (isStale(cur, r)) {
      // Another waiter is breaking it: back off instead of spinning on the filesystem.
      if (!(await breakStale(path, holder, r))) {
        if (waited >= r.timeoutMs) throw new LockTimeoutError(cur.holder, waited, path);
        await r.sleep(Math.min(Math.random() * 25 + 1, Math.max(1, r.timeoutMs - waited)));
      }
      continue;
    }
    if (waited >= r.timeoutMs) throw new LockTimeoutError(cur.holder, waited, path);
    if (!notified && waited >= WAIT_NOTICE_MS && opts.onWait) {
      notified = true;
      opts.onWait(cur.holder, waited);
    }
    const delay = Math.min(250, 25 * 1.6 ** attempt);
    await r.sleep(Math.min(Math.random() * delay + 1, Math.max(1, r.timeoutMs - waited)));
  }
}

/**
 * Runs `fn` while holding the repository lock. Re-entrant within one async context
 * (a nested call for the same repo runs `fn` directly), queued within one process,
 * exclusive across processes.
 */
export async function withRepoLock<T>(repoId: string, fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(repoId)) return fn();

  const env = opts.env ?? process.env;
  const envTimeout = Number(env['GOTCHEA_LOCK_TIMEOUT_MS']);
  const r: Resolved = {
    timeoutMs: opts.timeoutMs ?? (envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS),
    staleMs: opts.staleMs ?? DEFAULT_STALE_MS,
    heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? defaultSleep,
    isPidAlive: opts.isPidAlive ?? defaultPidAlive,
    pid: opts.pid ?? process.pid,
    host: opts.host ?? hostname(),
  };
  const { lock: path, repoDir } = userPaths(repoId, env);
  await mkdir(repoDir, { recursive: true });

  return queue.run(path, async () => {
    const holder = await acquire(path, opts, r);
    installExitHook();
    heldPaths.add(path);
    const beat = setInterval(() => {
      const t = new Date();
      utimes(path, t, t).catch(() => undefined);
    }, r.heartbeatMs);
    beat.unref();
    try {
      return await held.run(new Set([...(mine ?? []), repoId]), fn);
    } finally {
      clearInterval(beat);
      heldPaths.delete(path);
      // Never delete a lock we no longer own (it may have been broken as stale).
      const cur = await readHolder(path).catch(() => null);
      if (cur?.holder?.token === holder.token) await unlinkRetry(path).catch(() => undefined);
    }
  });
}

/** Who holds the lock right now; null when it is free. */
export async function inspectRepoLock(
  repoId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ holder: LockHolder | null; ageMs: number; stale: boolean } | null> {
  const cur = await readHolder(userPaths(repoId, env).lock);
  if (!cur) return null;
  const r: Resolved = {
    timeoutMs: 0,
    staleMs: DEFAULT_STALE_MS,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    now: Date.now,
    sleep: defaultSleep,
    isPidAlive: defaultPidAlive,
    pid: process.pid,
    host: hostname(),
  };
  return { holder: cur.holder, ageMs: Date.now() - cur.mtimeMs, stale: isStale(cur, r) };
}
