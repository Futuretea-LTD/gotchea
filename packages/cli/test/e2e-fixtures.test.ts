// End-to-end CLI flow on temp copies of the core fixture repos:
// init → scan → map → map --json, then edit files and rescan to check the diff.
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FsChunkStore,
  FsProgressStore,
  FsSnapshotStore,
  changeRatio,
  computeRepoId,
  userPaths,
  type Chunk,
  type ChunksFile,
  type Progress,
} from 'gotchea-core';
import { FsQuestionStore } from 'gotchea-core/internal';
import { copyFixture, type FixtureName, type FixtureRepo } from '../../core/test/helpers/fixture-repo.js';
import { run, type CliIo, type MapJson, type MapNode, type ProgramDeps } from '../src/program.js';
import { NOW, SentinelProvider, allKeys, answerDataIn, question, type RunResult } from './helpers.js';

interface Edit {
  path: string;
  from: string;
  to: string;
}

interface FixtureSpec {
  name: FixtureName;
  /** Files the scan must chunk. */
  files: string[];
  /** Skip counts by printed label. */
  skipped: Record<string, number>;
  /** No chunk id may match these (skipped or gitignored files). */
  forbidden: RegExp[];
  /** Chunk ids that must exist after the first scan. */
  knownIds: string[];
  /** Leaf titles / file names expected in the text map. */
  mapTexts: string[];
  subpath: string;
  /** One-line edit inside a leaf: `[leaf id, edit]`. */
  smallEdit: [string, Edit];
  /** File that gets a comment/whitespace-only edit. */
  cosmetic: { path: string; transform: (text: string) => string };
  newFile: { path: string; text: string };
  deleteFile: string;
  /** Rewrites > 50% of a leaf. */
  heavy: [string, Edit];
  /** Small edit on a different leaf for the green contrast. */
  light: [string, Edit];
}

const TS_WORDWRAP_OLD = `  const limit = Math.max(1, width);
  const words = input.split(/\\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= limit) {
      current = \`\${current} \${word}\`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;`;

const TS_WORDWRAP_NEW = `  const max = width < 1 ? 1 : width;
  const out: string[] = [];
  let buffer: string[] = [];
  let used = 0;
  for (const token of input.trim().split(/ +/)) {
    if (token === '') continue;
    const extra = buffer.length === 0 ? token.length : token.length + 1;
    if (used + extra > max && buffer.length > 0) {
      out.push(buffer.join(' '));
      buffer = [token];
      used = token.length;
    } else {
      buffer.push(token);
      used += extra;
    }
  }
  if (buffer.length !== 0) out.push(buffer.join(' '));
  return out;`;

const PY_WORDWRAP_OLD = `    limit = max(1, width)
    words = [w for w in value.split() if w]
    lines = []
    current = ""
    for word in words:
        if not current:
            current = word
            continue
        if len(current) + 1 + len(word) <= limit:
            current = current + " " + word
            continue
        lines.append(current)
        current = word
    if current:
        lines.append(current)
    if not lines:
        lines.append("")
    return lines`;

const PY_WORDWRAP_NEW = `    cap = width if width >= 1 else 1
    result = []
    buf = []
    used = 0
    for token in value.strip().split(" "):
        if token == "":
            pass
        elif used + len(token) + (1 if buf else 0) > cap and buf:
            result.append(" ".join(buf))
            buf = [token]
            used = len(token)
        else:
            used += len(token) + (1 if buf else 0)
            buf.append(token)
    if buf:
        result.append(" ".join(buf))
    return result or [""]`;

const SPECS: FixtureSpec[] = [
  {
    name: 'ts-basic',
    files: [
      'src/index.ts',
      'src/models/user.ts',
      'src/services/report-engine.ts',
      'src/services/user-service.ts',
      'src/util/math.ts',
      'src/util/strings.ts',
    ],
    skipped: { 'always-excluded': 4, test: 1, unsupported: 1 },
    forbidden: [/node_modules/, /^dist/, /\.min\./, /\.spec\./, /\.local\./, /^public/, /package-lock/],
    knownIds: [
      '.',
      'src/util/strings.ts#~group:slugify',
      'src/util/strings.ts#wordWrap',
      'src/services/report-engine.ts#ReportEngine.addRow',
    ],
    mapTexts: ['strings.ts', 'math.ts', 'report-engine.ts', 'wordWrap', 'addRow'],
    subpath: 'src/util',
    smallEdit: ['src/util/strings.ts#wordWrap', { path: 'src/util/strings.ts', from: 'const limit = Math.max(1, width);', to: 'const limit = Math.max(2, width);' }],
    cosmetic: {
      path: 'src/util/math.ts',
      transform: (t) =>
        `// extra header comment\n/* block\n   comment */\n${t
          .split('\n')
          .map((l) => (l.startsWith('  ') ? `    ${l.trimStart()}   // trailing note` : l))
          .join('\n')}\n\n// footer\n`,
    },
    newFile: { path: 'src/util/extra.ts', text: 'export function double(n: number): number {\n  return n * 2;\n}\n' },
    deleteFile: 'src/services/user-service.ts',
    heavy: ['src/util/strings.ts#wordWrap', { path: 'src/util/strings.ts', from: TS_WORDWRAP_OLD, to: TS_WORDWRAP_NEW }],
    light: ['src/util/strings.ts#~group:slugify', { path: 'src/util/strings.ts', from: 'input.trim().toLowerCase()', to: 'input.trim().toLocaleLowerCase()' }],
  },
  {
    name: 'py-basic',
    files: [
      'app/__init__.py',
      'app/models/__init__.py',
      'app/models/user.py',
      'app/services/__init__.py',
      'app/services/billing.py',
      'app/util/__init__.py',
      'app/util/text.py',
      'main.py',
    ],
    skipped: { excluded: 2, 'always-excluded': 1, test: 1, unsupported: 1 },
    forbidden: [/\.venv/, /__pycache__/, /poetry\.lock/, /^tests/, /test_/, /\.local\./],
    knownIds: ['.', 'app/util/text.py#word_wrap', 'app/util/text.py#~group:_SLUG_RE'],
    mapTexts: ['text.py', 'billing.py', 'main.py', 'word_wrap'],
    subpath: 'app/util',
    smallEdit: ['app/util/text.py#word_wrap', { path: 'app/util/text.py', from: 'limit = max(1, width)', to: 'limit = max(2, width)' }],
    cosmetic: {
      path: 'main.py',
      transform: (t) => `# extra header comment\n\n${t.split('\n').map((l) => (l.trim() ? `${l}   ` : l)).join('\n')}\n\n# footer comment\n`,
    },
    newFile: { path: 'app/util/extra.py', text: 'def double(n):\n    return n * 2\n' },
    deleteFile: 'app/services/billing.py',
    heavy: ['app/util/text.py#word_wrap', { path: 'app/util/text.py', from: PY_WORDWRAP_OLD, to: PY_WORDWRAP_NEW }],
    light: ['app/util/text.py#~group:_SLUG_RE', { path: 'app/util/text.py', from: 'trimmed = dashed.strip("-")', to: 'trimmed = dashed.strip("-_")' }],
  },
];

/** `<n> <label>` row of the scan summary (NaN when absent). */
const count = (stdout: string, label: string) => Number(new RegExp(`^\\s+(\\d+) ${label}$`, 'm').exec(stdout)?.[1]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const flatten = (node: MapNode): MapNode[] => [node, ...node.children.flatMap(flatten)];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Recursively lists every entry name under `dir`. */
async function allNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.map((e) => e.name);
}

interface Diff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

function diffChunks(before: ChunksFile, after: ChunksFile): Diff {
  const prev = new Map(before.chunks.map((c) => [c.id, c.contentHash]));
  const next = new Map(after.chunks.map((c) => [c.id, c.contentHash]));
  const d: Diff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [id, hash] of next) {
    const old = prev.get(id);
    if (old === undefined) d.added.push(id);
    else if (old === hash) d.unchanged.push(id);
    else d.changed.push(id);
  }
  for (const id of prev.keys()) if (!next.has(id)) d.removed.push(id);
  return d;
}

describe.each(SPECS)('e2e on fixture $name', (spec) => {
  let fx: FixtureRepo;

  const gotchea = async (args: string[], deps?: ProgramDeps): Promise<RunResult> => {
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
      cwd: fx.root,
      env: fx.env,
      color: false,
      now: () => NOW,
    };
    const code = await run(args, io, deps);
    return { code, stdout, stderr };
  };

  const chunksPath = () => join(fx.root, '.gotchea', 'chunks.json');
  const chunksFile = async (): Promise<ChunksFile> => JSON.parse(await readFile(chunksPath(), 'utf8')) as ChunksFile;
  const chunk = async (id: string): Promise<Chunk> => {
    const c = (await new FsChunkStore(fx.root).load())!.chunks.find((x) => x.id === id);
    if (!c) throw new Error(`no chunk ${id}`);
    return c;
  };
  const mapJson = async (...args: string[]): Promise<MapJson> => {
    const r = await gotchea(['map', '--json', ...args]);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as MapJson;
  };

  async function initAndScan(): Promise<RunResult> {
    const init = await gotchea(['init']);
    expect(init.code, init.stderr).toBe(0);
    const scan = await gotchea(['scan']);
    expect(scan.code, scan.stderr).toBe(0);
    return scan;
  }

  /** One ok question + a fresh pass for `id` at its current hash. */
  async function seedPassed(ids: string[]): Promise<FsProgressStore> {
    const repoId = await computeRepoId(fx.root);
    const progress = new FsProgressStore(repoId, fx.env);
    const chunks: Record<string, Progress> = {};
    for (const id of ids) {
      const c = await chunk(id);
      await new FsQuestionStore(fx.root).save(id, [question(id, c.contentHash)]);
      chunks[id] = {
        stability: 30,
        lastReviewedAt: NOW.toISOString(),
        lastPassedHash: c.contentHash,
        lastSeenHash: c.contentHash,
        mustRepass: false,
        history: [],
      };
    }
    await progress.save({ version: 1, repoId, chunks });
    return progress;
  }

  beforeEach(async () => {
    fx = await copyFixture(spec.name);
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('init creates the config; scan chunks the expected files and skips the rest', async () => {
    const init = await gotchea(['init']);
    expect(init.code, init.stderr).toBe(0);
    expect(await exists(join(fx.root, '.gotchea', 'config.json'))).toBe(true);

    const scan = await gotchea(['scan']);
    expect(scan.code, scan.stderr).toBe(0);
    const total = Object.values(spec.skipped).reduce((a, b) => a + b, 0);
    const m = new RegExp(`^Scanned ${spec.files.length} files in \\d+ ms \\(${total} skipped: (.*)\\)$`, 'm').exec(scan.stdout);
    expect(m, scan.stdout).not.toBeNull();
    const reasons = Object.fromEntries(
      m![1]!.split(', ').map((part) => {
        const [, n, label] = /^(\d+) (.+)$/.exec(part)!;
        return [label!, Number(n)];
      }),
    );
    expect(reasons).toEqual(spec.skipped);

    const file = await chunksFile();
    const ids = file.chunks.map((c) => c.id);
    for (const id of spec.knownIds) expect(ids).toContain(id);
    for (const id of ids) for (const re of spec.forbidden) expect(id).not.toMatch(re);
    const files = file.chunks.filter((c) => c.kind === 'file').map((c) => c.id).sort();
    expect(files).toEqual([...spec.files].sort());
    // Every range points into a scanned file.
    for (const c of file.chunks) for (const r of c.ranges) expect(spec.files).toContain(r.path);
    expect(scan.stdout).toMatch(new RegExp(`^${file.chunks.length} chunks, ${file.chunks.filter((c) => c.isLeaf).length} leaves$`, 'm'));
    expect(count(scan.stdout, 'added')).toBe(file.chunks.length);
    expect(count(scan.stdout, 'changed')).toBe(0);
    expect(count(scan.stdout, 'removed')).toBe(0);
    expect(count(scan.stdout, 'unchanged')).toBe(0);
  });

  it('map (text) lists leaves and files, all grey', async () => {
    await initAndScan();
    const file = await chunksFile();
    const leaves = file.chunks.filter((c) => c.isLeaf).length;
    const r = await gotchea(['map']);
    expect(r.code, r.stderr).toBe(0);
    for (const text of spec.mapTexts) expect(r.stdout).toContain(text);
    expect(r.stdout).toMatch(/^● \S.*\/\s+\d+ LOC\s+–$/m);
    expect(r.stdout).toContain(`grey: no questions (${leaves})`);
    expect(r.stdout).toMatch(/green ≥\d+% \(0\)/);
    expect(r.stdout).toMatch(/yellow ≥\d+% \(0\)/);
    expect(r.stdout).toContain('red (0)');
    expect(r.stdout).not.toContain('\u001b[');
  });

  it('map --json mirrors chunks.json, is all grey and never leaks answer keys; a subpath narrows it', async () => {
    await initAndScan();
    const file = await chunksFile();
    const out = await mapJson();
    expect(out).toMatchObject({ version: 1, repoId: await computeRepoId(fx.root), filter: null, generatedAt: NOW.toISOString() });
    expect(Object.keys(out).sort()).toEqual(['filter', 'generatedAt', 'repoId', 'root', 'version']);

    const nodes = flatten(out.root);
    expect(nodes.map((n) => n.id).sort()).toEqual(file.chunks.map((c) => c.id).sort());
    expect(out.root.id).toBe('.');
    expect(out.root.title.length).toBeGreaterThan(0);
    const parentOf = new Map<string, string | null>([[out.root.id, null]]);
    for (const n of nodes) for (const child of n.children) parentOf.set(child.id, n.id);
    for (const c of file.chunks) expect(parentOf.get(c.id), c.id).toBe(c.parentId);
    for (const n of nodes) {
      expect(n.state.color, n.id).toBe('grey');
      expect(n.state.R, n.id).toBeNull();
      if (n.isLeaf) expect([3, 5, 7], n.id).toContain(n.questionCount);
      expect(n.isLeaf, n.id).toBe(n.children.length === 0);
    }
    // Plant a question so answer keys exist on disk, then check they never reach the output.
    const leaf = await chunk(spec.smallEdit[0]);
    await new FsQuestionStore(fx.root).save(leaf.id, [question(leaf.id, leaf.contentHash)]);
    const keys = allKeys(await mapJson());
    expect(keys.has('correctIndex')).toBe(false);
    expect(keys.has('explanation')).toBe(false);

    // Subpath: the matching subtree plus its ancestors.
    const sub = await mapJson(spec.subpath);
    expect(sub.filter).toBe(spec.subpath);
    const byId = new Map(file.chunks.map((c) => [c.id, c]));
    const matching = file.chunks.filter((c) => c.id === spec.subpath || c.id.startsWith(`${spec.subpath}/`) || c.id.startsWith(`${spec.subpath}#`));
    expect(matching.length).toBeGreaterThan(1);
    const expected = new Set<string>();
    for (const c of matching) {
      let cur: Chunk | undefined = c;
      while (cur) {
        expected.add(cur.id);
        cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
      }
    }
    expect(flatten(sub.root).map((n) => n.id).sort()).toEqual([...expected].sort());
  });

  it('generate (--json and text) and the map after it carry counts only, never answer data', async () => {
    await initAndScan();
    const provider = new SentinelProvider();
    const json = await gotchea(['generate', '--json', '--limit', '2'], provider.deps());
    expect(json.code, json.stderr).toBe(0);
    const report = JSON.parse(json.stdout) as { chunks: { chunkId: string; saved: number }[]; totals: { saved: number } };
    expect(report.totals.saved).toBeGreaterThan(0);
    const keys = allKeys(report);
    for (const k of ['correctIndex', 'explanation', 'options', 'stem', 'refs']) expect(keys.has(k), k).toBe(false);
    expect(answerDataIn(json.stdout + json.stderr)).toEqual([]);

    const human = await gotchea(['generate', '--limit', '2'], provider.deps());
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/Total: \d+ saved/);
    expect(answerDataIn(human.stdout + human.stderr)).toEqual([]);
    for (const stem of SentinelProvider.STEMS) expect(human.stdout + json.stdout).not.toContain(stem);

    // The provider really saw and wrote the sentinels, and they are on disk.
    const saved = report.chunks.filter((c) => c.saved > 0);
    expect(saved.length).toBeGreaterThan(0);
    const pool = await new FsQuestionStore(fx.root).list(saved[0]!.chunkId);
    expect(pool.length).toBe(saved[0]!.saved);
    expect(pool[0]!.options[0]).toContain('GEN-OPT-SENTINEL');

    const out = await mapJson();
    const nodes = flatten(out.root);
    for (const c of saved) expect(nodes.find((n) => n.id === c.chunkId)!.okQuestions, c.chunkId).toBeGreaterThanOrEqual(c.saved);
    for (const k of ['correctIndex', 'explanation', 'options', 'stem', 'refs']) expect(allKeys(out).has(k), k).toBe(false);
    const text = await gotchea(['map']);
    expect(text.stdout).toMatch(/ · \d+ q$/m);
    expect(answerDataIn(text.stdout + JSON.stringify(out))).toEqual([]);
  });

  it('a second scan without edits reports everything unchanged and writes identical bytes', async () => {
    await initAndScan();
    const before = await readFile(chunksPath(), 'utf8');
    const n = (JSON.parse(before) as ChunksFile).chunks.length;
    const r = await gotchea(['scan']);
    expect(r.code, r.stderr).toBe(0);
    expect(count(r.stdout, 'added')).toBe(0);
    expect(count(r.stdout, 'changed')).toBe(0);
    expect(count(r.stdout, 'removed')).toBe(0);
    expect(count(r.stdout, 'unchanged')).toBe(n);
    expect(r.stdout).not.toContain('Changed leaves');
    expect(await readFile(chunksPath(), 'utf8')).toBe(before);
  });

  it('edits, a new file and a deletion show up in the rescan diff', async () => {
    await initAndScan();
    const before = await chunksFile();
    const [smallId, small] = spec.smallEdit;
    const smallLoc = before.chunks.find((c) => c.id === smallId)!.metrics.loc;
    const cosmeticIds = before.chunks.filter((c) => c.ranges.some((r) => r.path === spec.cosmetic.path)).map((c) => c.id);
    expect(cosmeticIds.length).toBeGreaterThan(0);

    await fx.edit(small.path, small.from, small.to);
    await fx.write(spec.cosmetic.path, spec.cosmetic.transform(await fx.read(spec.cosmetic.path)));
    await fx.write(spec.newFile.path, spec.newFile.text);
    await rm(join(fx.root, spec.deleteFile));

    const r = await gotchea(['scan']);
    expect(r.code, r.stderr).toBe(0);
    const after = await chunksFile();
    const d = diffChunks(before, after);

    expect(r.stdout).toMatch(new RegExp(`^Scanned ${spec.files.length} files in`, 'm'));
    expect(count(r.stdout, 'added')).toBe(d.added.length);
    expect(count(r.stdout, 'changed')).toBe(d.changed.length);
    expect(count(r.stdout, 'removed')).toBe(d.removed.length);
    expect(count(r.stdout, 'unchanged')).toBe(d.unchanged.length);
    expect(r.stdout).not.toMatch(/^\s+\d+ moved$/m);

    // Specific buckets.
    expect(d.added).toContain(spec.newFile.path);
    expect(d.added.every((id) => id === spec.newFile.path || id.startsWith(`${spec.newFile.path}#`))).toBe(true);
    expect(d.removed).toContain(spec.deleteFile);
    expect(d.removed.every((id) => id === spec.deleteFile || id.startsWith(`${spec.deleteFile}#`))).toBe(true);
    expect(d.changed).toContain(smallId);
    expect(d.changed).toContain(small.path);
    expect(d.changed).toContain('.');
    for (const id of cosmeticIds) expect(d.unchanged, id).toContain(id);
    expect(d.changed).not.toContain(spec.cosmetic.path);

    // Changed leaf listed with ≈ 1/loc.
    const pct = Math.round((1 / smallLoc) * 100);
    expect(r.stdout).toContain('Changed leaves (changeRatio):');
    expect(r.stdout).toMatch(new RegExp(`^ {2}${esc(smallId)}\\s+${pct}%$`, 'm'));
    expect(pct).toBeLessThan(10);
    // No questions and no progress: nothing stale or decayed.
    expect(r.stdout).not.toContain('marked stale');
    expect(r.stdout).not.toContain('Progress decayed');
  });

  /** Seeds a passed leaf, applies `edit`, rescans; returns what the checks need. */
  async function rewriteAndRescan(id: string, edit: Edit) {
    await initAndScan();
    const repoId = await computeRepoId(fx.root);
    const before = await chunk(id);
    const progress = await seedPassed([id]);
    await fx.edit(edit.path, edit.from, edit.to);
    const r = await gotchea(['scan']);
    expect(r.code, r.stderr).toBe(0);
    const after = await chunk(id);
    expect(after.contentHash).not.toBe(before.contentHash);
    // Expected ratio from the stored line snapshots.
    const snapshots = new FsSnapshotStore(repoId, fx.env);
    const ratio = changeRatio(await snapshots.get(before.contentHash), (await snapshots.get(after.contentHash))!);
    const line = new RegExp(`^ {2}${esc(id)}\\s+(\\d+)%$`, 'm').exec(r.stdout);
    expect(line, r.stdout).not.toBeNull();
    expect(Number(line![1])).toBe(Math.round(ratio * 100));
    expect(r.stdout).toContain('1 question marked stale');
    expect(r.stdout).toContain('Progress decayed for 1 chunk');
    expect((await new FsQuestionStore(fx.root).list(id)).map((q) => q.status)).toEqual(['stale']);
    const p = (await progress.load()).chunks[id]!;
    expect(p).toMatchObject({ lastSeenHash: after.contentHash, lastPassedHash: before.contentHash });
    expect(p.stability).toBeCloseTo(Math.max(1, 30 * Math.max(0.1, 1 - ratio)), 9);
    // A fresh ok question at the new hash, then the map.
    await new FsQuestionStore(fx.root).save(id, [question(id, after.contentHash)]);
    const node = flatten((await mapJson()).root).find((n) => n.id === id)!;
    return { repoId, ratio, p, node };
  }

  it('a heavy rewrite (>50%) stales the question, forces a re-pass and turns the leaf red', async () => {
    const [id, edit] = spec.heavy;
    const { repoId, ratio, p, node } = await rewriteAndRescan(id, edit);
    expect(ratio).toBeGreaterThan(0.5);
    expect(p.mustRepass).toBe(true);
    expect(node.state.color).toBe('red');

    // Personal state lives in GOTCHEA_HOME, never in the repo.
    const paths = userPaths(repoId, fx.env);
    expect(paths.progress).toBe(join(fx.home, 'repos', repoId, 'progress.json'));
    expect(await exists(paths.progress)).toBe(true);
    const names = await allNames(fx.root);
    expect(names).not.toContain('progress.json');
    expect(names).not.toContain('snapshots');
  });

  it('a light edit (<50%) on another leaf decays progress but keeps it green', async () => {
    const [id, edit] = spec.light;
    const { ratio, p, node } = await rewriteAndRescan(id, edit);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.5);
    expect(p.mustRepass).toBe(false);
    expect(node.state.color).toBe('green');
    expect(node.state.R).toBeCloseTo(1, 6);
  });
});
