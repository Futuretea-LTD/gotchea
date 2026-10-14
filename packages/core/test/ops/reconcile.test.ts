import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRepoId, ensureReconciled, initConfig, runScan } from '../../src/index.js';
import type { Progress } from '../../src/model/progress.js';
import { FsProgressStore } from '../../src/store/progress-store.js';
import { copyFixture, type FixtureRepo } from '../helpers/fixture-repo.js';

let fx: FixtureRepo;
let teammateHome: string;
beforeEach(async () => {
  fx = await copyFixture('ts-basic');
  teammateHome = await mkdtemp(join(tmpdir(), 'gotchea-mate-'));
});
afterEach(async () => {
  await fx.cleanup();
  await rm(teammateHome, { recursive: true, force: true });
});

const passed = (hash: string): Progress => ({
  stability: 10,
  lastReviewedAt: '2026-10-10T00:00:00.000Z',
  lastPassedHash: hash,
  lastSeenHash: hash,
  mustRepass: false,
  history: [],
});

/** The user has progress on a leaf of `src/util/math.ts`; a teammate then changes it and scans (chunks.json is shared). */
async function afterPull() {
  await initConfig(fx.root);
  const { result } = await runScan(fx.root, { env: fx.env, useGit: false });
  const leaf = result.chunks.find((c) => c.isLeaf && c.ranges[0]?.path === 'src/util/math.ts')!;
  const repoId = await computeRepoId(fx.root);
  const store = new FsProgressStore(repoId, fx.env);
  await store.save({ version: 1, repoId, chunks: { [leaf.id]: passed(leaf.contentHash) } });
  const source = await fx.read('src/util/math.ts');
  const edited = source.replace(/(\n\s*return [^\n]*;)/, '\n  const touched = 1;$1');
  expect(edited).not.toBe(source);
  await fx.write('src/util/math.ts', edited);
  await runScan(fx.root, { env: { GOTCHEA_HOME: teammateHome }, useGit: false });
  return { leaf, store };
}

describe('ensureReconciled', () => {
  it('does nothing when progress already matches chunks.json', async () => {
    await initConfig(fx.root);
    await runScan(fx.root, { env: fx.env, useGit: false });
    expect(await ensureReconciled(fx.root, { env: fx.env })).toEqual({ changes: [], deferred: [] });
  });

  it('applies the decay of a pulled change once, without a scan', async () => {
    const { leaf, store } = await afterPull();
    const first = await ensureReconciled(fx.root, { env: fx.env });
    expect(first.deferred).toEqual([]);
    const after = (await store.load()).chunks[leaf.id]!;
    const changed = first.changes.filter((c) => c.id === leaf.id);
    expect(changed).toHaveLength(1);
    expect(after.lastSeenHash).not.toBe(leaf.contentHash);
    expect(after.stability!).toBeLessThan(10);

    // Idempotent: a second call (or a concurrent one) must not decay again.
    expect(await ensureReconciled(fx.root, { env: fx.env })).toEqual({ changes: [], deferred: [] });
    expect((await store.load()).chunks[leaf.id]!.stability).toBe(after.stability);
  });

  it('defers a leaf whose working tree differs from chunks.json', async () => {
    const { leaf, store } = await afterPull();
    await fx.write('src/util/math.ts', `${await fx.read('src/util/math.ts')}\nexport const local = 42;\n`);
    const out = await ensureReconciled(fx.root, { env: fx.env });
    expect(out.deferred).toEqual([leaf.id]);
    const p = (await store.load()).chunks[leaf.id]!;
    expect(p.stability).toBe(10);
    expect(p.lastSeenHash).toBe(leaf.contentHash);
  });
});
