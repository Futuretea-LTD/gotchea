// Fixture `py-basic`: packages, classes, docstrings, relative imports, grouping and filters.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig, resolveConfig } from '../../src/config/load.js';
import type { GotcheaConfigInput } from '../../src/config/schema.js';
import { scanRepo } from '../../src/scan/scan.js';
import { copyFixture, type FixtureRepo } from '../helpers/fixture-repo.js';
import { byId, childrenOf, expectTreeInvariants, leavesOf } from '../helpers/tree-invariants.js';

let f: FixtureRepo;
const scan = (over: GotcheaConfigInput = {}) =>
  scanRepo({ root: f.root, repoId: 'py-basic', useGit: false, env: f.env, config: resolveConfig(mergeConfig({}, over)), dryRun: true });

beforeEach(async () => {
  f = await copyFixture('py-basic');
});
afterEach(async () => {
  await f.cleanup();
});

const TEXT = 'app/util/text.py';

describe('py-basic: files', () => {
  it('scans package sources and skips .venv, __pycache__, poetry.lock, gitignored files and tests', async () => {
    const r = await scan();
    expect(r.files).toEqual([
      'app/__init__.py',
      'app/models/__init__.py',
      'app/models/user.py',
      'app/services/__init__.py',
      'app/services/billing.py',
      'app/util/__init__.py',
      TEXT,
      'main.py',
    ]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toMatchObject({
      '.venv/lib/site_hook.py': 'excluded',
      'poetry.lock': 'always',
      'tests/test_billing.py': 'test',
    });
    expect(r.skipped.some((s) => s.path.startsWith('__pycache__/'))).toBe(true);
    expect([...r.files, ...r.skipped.map((s) => s.path)].filter((p) => p.includes('settings.local'))).toEqual([]);
  });

  it('includes tests/ only with includeTests=true', async () => {
    const r = await scan({ includeTests: true });
    expect(r.files).toContain('tests/test_billing.py');
    expect(byId(r.chunks).get('tests')).toMatchObject({ kind: 'module', parentId: '.' });
    // The test imports app.models and app.services.billing.
    expect(byId(r.chunks).get('app/services/billing.py')!.metrics.fanIn).toBe(2);
  });
});

describe('py-basic: hierarchy', () => {
  it('builds package modules with __init__ files and passes every tree invariant', async () => {
    const { chunks } = await scan();
    expectTreeInvariants(chunks, defaultConfig().chunking);
    expect(chunks.filter((c) => c.kind === 'module').map((c) => c.id)).toEqual(['.', 'app', 'app/models', 'app/services', 'app/util']);
    expect(byId(chunks).get('main.py')).toMatchObject({ kind: 'file', parentId: '.', isLeaf: true, lang: 'python' });
  });

  it('does not count docstrings or comments as LOC', async () => {
    const { chunks } = await scan();
    // app/__init__.py is a docstring plus `__version__ = "0.1.0"`.
    expect(byId(chunks).get('app/__init__.py')!.metrics.loc).toBe(1);
    // app/util/__init__.py holds only a docstring.
    expect(byId(chunks).get('app/util/__init__.py')!.metrics.loc).toBe(0);
  });

  it('groups the tiny helpers of text.py; word_wrap stays a symbol; module-level code joins as a variable', async () => {
    const { chunks } = await scan();
    const cfg = defaultConfig().chunking;
    const file = byId(chunks).get(TEXT)!;
    expect(file.isLeaf).toBe(false);
    expect(file.metrics.loc).toBeGreaterThan(cfg.leafMaxLoc);
    const kids = childrenOf(chunks, TEXT);
    const groups = kids.filter((c) => c.kind === 'group');
    expect(groups.length).toBeGreaterThanOrEqual(4);
    for (const g of groups) expect(g.metrics.loc).toBeLessThanOrEqual(cfg.leafMaxLoc);
    expect(byId(chunks).get(`${TEXT}#word_wrap`)).toMatchObject({ kind: 'symbol', isLeaf: true });
    // `_SLUG_RE = re.compile(...)` is a variable symbol, the first member of the first group.
    expect(byId(chunks).get(`${TEXT}#~group:_SLUG_RE`)!.title).toMatch(/^_SLUG_RE … /);
    expect(byId(chunks).get(`${TEXT}#~top`)).toBeDefined(); // `import re`
    expect(leavesOf(chunks, TEXT).reduce((s, c) => s + c.metrics.loc, 0)).toBe(file.metrics.loc);
  });
});

describe('py-basic: fanIn through relative, absolute and submodule imports', () => {
  it('resolves `from ..models.user`, `from .user`, `from ..util import text` and `from app.x import y`', async () => {
    const map = byId((await scan()).chunks);
    const fanIn = (id: string) => map.get(id)!.metrics.fanIn;
    expect(fanIn('app/models/user.py')).toBe(2); // app/models/__init__.py (.user), billing.py (..models.user)
    expect(fanIn('app/models/__init__.py')).toBe(1); // main.py (from app.models import User)
    expect(fanIn(TEXT)).toBe(3); // user.py, billing.py, main.py
    expect(fanIn('app/services/billing.py')).toBe(1); // main.py
    expect(fanIn('main.py')).toBe(0);
    expect(fanIn('app')).toBe(1); // only main.py is outside app/
    expect(fanIn('app/util')).toBe(3);
  });

  it('counts symbol references per group, including namespace access (text.pad_right)', async () => {
    const map = byId((await scan()).chunks);
    const fanIn = (id: string) => map.get(id)!.metrics.fanIn;
    expect(fanIn(`${TEXT}#~group:_SLUG_RE`)).toBe(3); // slugify: user.py, billing.py, main.py
    expect(fanIn(`${TEXT}#~group:pad_right`)).toBe(1); // billing.py via `text.pad_right`
    expect(fanIn(`${TEXT}#word_wrap`)).toBe(0);
  });
});
