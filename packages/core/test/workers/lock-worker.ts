// Child-process worker for lock-concurrency.test.ts (bundled with esbuild at test time; never run by vitest).
// Modes: `counter` (read-modify-write a counter file under the lock), `score` (the real quiz scoring path),
// `hold` (take the lock and sit on it until killed).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultConfig } from '../../src/config/load.js';
import { scoreSession, type Session } from '../../src/quiz/session.js';
import { withRepoLock } from '../../src/store/repo-lock.js';

const [mode, repoId, home, a, b, c, d] = process.argv.slice(2) as [string, string, string, string, string, string, string];
const env = { ...process.env, GOTCHEA_HOME: home };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => process.hrtime.bigint().toString();

async function counter(counterFile: string, logFile: string, iterations: number, useLock: boolean): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    const body = async () => {
      appendFileSync(logFile, `${stamp()} enter ${process.pid}\n`);
      const n = Number(readFileSync(counterFile, 'utf8'));
      await sleep(Math.random() * 5);
      writeFileSync(counterFile, String(n + 1));
      appendFileSync(logFile, `${stamp()} exit ${process.pid}\n`);
    };
    if (useLock) await withRepoLock(repoId, body, { env, label: 'counter', timeoutMs: 60_000 });
    else await body();
  }
}

/** Scores `count` distinct, fully answered sessions on one chunk: what the CLI and MCP do on the last answer. */
async function score(chunkId: string, tag: string, count: number): Promise<void> {
  const config = defaultConfig();
  for (let i = 0; i < count; i++) {
    const ids = ['q_000000000001', 'q_000000000002', 'q_000000000003'];
    const at = new Date().toISOString();
    const session: Session = {
      version: 1,
      id: `qs_${tag}${String(i).padStart(16 - tag.length, '0')}`,
      origin: tag === 'a' ? 'cli' : 'mcp',
      chunkId,
      chunkHash: 'h1',
      lang: 'en',
      questionIds: ids,
      permutations: Object.fromEntries(ids.map((q) => [q, [0, 1, 2, 3]])) as Session['permutations'],
      answers: Object.fromEntries(ids.map((q) => [q, { displayIndex: 0, correct: true, answeredAt: at }])) as Session['answers'],
      status: 'active',
      startedAt: at,
      lastActivityAt: at,
      expiresAt: at,
    };
    await scoreSession(session, { repoId, config, env, now: new Date(), lock: { timeoutMs: 60_000 } });
  }
}

if (mode === 'counter') await counter(a, b, Number(c), d !== 'nolock');
else if (mode === 'score') await score(a, b, Number(c));
else if (mode === 'hold') {
  await withRepoLock(repoId, async () => {
    process.stdout.write('locked\n');
    setInterval(() => undefined, 1_000); // the lock's heartbeat is unref'd: keep the process alive until killed
    await new Promise(() => undefined);
  }, { env, label: 'hold', heartbeatMs: 100 });
}
