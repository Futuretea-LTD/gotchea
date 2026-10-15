#!/usr/bin/env node
// Pack smoke test: builds the workspace, packs the three public packages, installs the
// tarballs together outside the repo (gotchea-core and gotchea-mcp resolve from the local
// tarballs, never the registry) and drives the installed CLI and MCP server against a
// temp git repo: init, scan, map --json, serve + GET /api/map, an MCP stdio handshake
// with tools/list, a save_questions round trip with fixture questions (no LLM) and the
// PLAN §6 answer-key leak scan over every agent-facing output.
//
// Plain Node ESM, no dependencies, meant to run on Linux, macOS and Windows:
//   node scripts/pack-smoke.mjs        (or `pnpm smoke:pack`)
// Set GOTCHEA_SMOKE_KEEP=1 to keep the temp dirs for debugging.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';
const PACKAGES = [
  { dir: 'packages/core', name: 'gotchea-core' },
  { dir: 'packages/mcp', name: 'gotchea-mcp' },
  { dir: 'packages/cli', name: 'gotchea' },
];

// Tool names registered in packages/mcp/src/server.ts (one file per tool in packages/mcp/src/tools/).
// Keep in sync when a tool is added or renamed.
const EXPECTED_TOOLS = [
  'scan',
  'get_map',
  'get_chunk_for_file',
  'get_status',
  'get_generation_tasks',
  'save_questions',
  'start_quiz',
  'submit_answer',
];

// FORBIDDEN_KEYS in packages/core/src/quiz/views.ts: none may appear in an agent-facing
// output before the question is answered (PLAN §6).
const FORBIDDEN_KEYS = ['correctIndex', 'correctDisplayIndex', 'correctOptionIndex', 'correctText', 'explanation', 'refs', 'answer', 'key'];
// Planted in every fixture explanation: if it shows up anywhere but a reveal, the key leaked.
const SENTINEL = 'SMOKESENTINEL';

const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------------------
// Fixture repo: three ~110-line functions in one file push it over `splitAboveLoc`, so
// `src/big.ts#alpha` becomes its own leaf (the same shape as packages/mcp/test/helpers.ts).
const bigFunction = (name) =>
  [`export function ${name}(x: number): number {`, ...Array.from({ length: 108 }, (_, i) => `  x += ${i} * x;`), '  return x;', '}', ''].join('\n');
const FIXTURE_FILES = {
  'src/big.ts': ['alpha', 'beta', 'gamma'].map(bigFunction).join('\n'),
  'src/math.ts': 'export function clamp(n: number, lo: number, hi: number): number {\n  if (n < lo) return lo;\n  if (n > hi) return hi;\n  return n;\n}\n',
  'src/index.ts': "import { clamp } from './math.js';\n\nexport const limit = (n: number) => clamp(n, 0, 10);\n",
  'lib/helper.js': "'use strict';\nfunction shout(s) {\n  return s.toUpperCase() + '!';\n}\nmodule.exports = { shout };\n",
  'README.md': '# fixture\n',
};
const QUIZ_CHUNK = 'src/big.ts#alpha';

// alpha(x) runs `x += i * x` for i = 0..107: an input of 0 stays 0. These pass the save-time
// validators (packages/mcp/test/quiz-e2e.test.ts uses the same set); five fill one quiz.
const q = (stem, options, explanation, extra = {}) => ({
  type: 'behavior',
  stem,
  options,
  correctIndex: 0,
  explanation: `${explanation} ${SENTINEL}`,
  refs: [{ start: 2, end: 110 }],
  difficulty: 1,
  ...extra,
});
const QUESTIONS = [
  q('What does alpha return when it is called with 0?', ['It returns 0', 'It returns 1', 'It returns 107', 'It returns NaN'], 'L2-L109 only ever multiply x by (1 + i), so 0 stays 0 and L110 returns it.'),
  q('Which value comes out of the function for a zero argument once the loop is done?', ['The value zero, unchanged', 'The value one', 'The value one hundred and seven', 'A NaN produced by the loop'], 'Every iteration on L2-L109 scales x, so zero is a fixed point and L110 returns it.', { type: 'edge_case', difficulty: 2 }),
  q('How does the accumulator behave across the loop body for an input of zero?', ['It stays at zero throughout', 'It grows by one each time', 'It jumps to 107 at the end', 'It turns into NaN midway'], 'Lines L2-L109 multiply x by a factor each step, so a zero accumulator never leaves zero.'),
  q('What would a caller observe after alpha finishes with a zero input?', ['Zero comes back to the caller', 'One comes back to the caller', 'The loop count comes back', 'An exception is thrown instead'], 'L110 returns the accumulator, which L2-L109 never moved away from zero.', { type: 'edge_case', difficulty: 2 }),
  q('If alpha receives zero, what is left in x when control reaches the end of the function?', ['Nothing but zero remains', 'Exactly one remains', 'The number 107 remains', 'Not-a-number remains'], 'L110 hands back x as the loop on L2-L109 left it, which for zero input is still zero.'),
];
const CORRECT_TEXT = new Map(QUESTIONS.map((x) => [x.stem, x.options[x.correctIndex]]));

// ---------------------------------------------------------------------------------------
// Process helpers. Node itself is always spawned as process.execPath (no shell, no .cmd
// shim), so killing a child kills the real process on every OS. npm/pnpm are .cmd shims on
// Windows, which since Node 20.12 can only be spawned through a shell.

const children = new Set();
const tempDirs = [];

function quoteWin(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function runTool(cmd, args, opts = {}) {
  const useShell = WIN && (cmd === 'npm' || cmd === 'pnpm');
  const res = useShell
    ? spawnSync([cmd, ...args].map(quoteWin).join(' '), { ...opts, shell: true, encoding: 'utf8', timeout: opts.timeout ?? 10 * TIMEOUT_MS })
    : spawnSync(cmd, args, { ...opts, encoding: 'utf8', timeout: opts.timeout ?? 10 * TIMEOUT_MS });
  if (res.error) throw new Error(`${cmd} ${args.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status}\n${tail(res.stdout)}\n${tail(res.stderr)}`);
  }
  return res;
}

function tail(s, n = 40) {
  return (s ?? '').split(/\r?\n/).slice(-n).join('\n');
}

function spawnNode(args, opts) {
  const child = spawn(process.execPath, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Asks politely (SIGTERM on POSIX), then kills the whole tree; taskkill /T covers Windows. */
async function stopChild(child, graceMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  if (!WIN) {
    child.kill('SIGTERM');
    const done = await waitExit(child, graceMs);
    if (done) return done;
  }
  forceKill(child);
  return waitExit(child, graceMs);
}

function forceKill(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}

function makeTemp(prefix) {
  // realpath: macOS hands out /var/... for /private/var/..., Windows may hand out 8.3 short names.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const child of children) forceKill(child);
  if (process.env.GOTCHEA_SMOKE_KEEP) {
    for (const dir of tempDirs) console.log(`kept ${dir}`);
    return;
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      // Windows can hold a handle on a just-killed child's cwd for a moment (EBUSY/EPERM).
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.error(`warning: could not remove ${dir}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Assertions and the leak scan.

class SmokeError extends Error {}
function assert(cond, message) {
  if (!cond) throw new SmokeError(message);
}

/** Every agent-facing output, checked by the final leak step. */
const outputs = [];
function record(label, value, opts = {}) {
  outputs.push({ label, value, ...opts });
}

function forbiddenKeyPaths(value, path = '$') {
  const hits = [];
  if (Array.isArray(value)) {
    for (const [i, x] of value.entries()) hits.push(...forbiddenKeyPaths(x, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(k)) hits.push(`${path}.${k}`);
      hits.push(...forbiddenKeyPaths(v, `${path}.${k}`));
    }
  }
  return hits;
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SmokeError(`${label}: stdout is not JSON (${err.message}):\n${tail(text, 10)}`);
  }
}

// ---------------------------------------------------------------------------------------
// State shared between steps.

const ctx = {
  packDir: '',
  installDir: '',
  fixture: '',
  home: '',
  bin: '',
  version: '',
  env: {},
};

function gotchea(args, opts = {}) {
  const res = spawnSync(process.execPath, [ctx.bin, ...args], {
    cwd: ctx.fixture,
    env: ctx.env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  if (res.error) throw new SmokeError(`gotchea ${args.join(' ')}: ${res.error.message}`);
  if (res.status !== (opts.expectCode ?? 0)) {
    throw new SmokeError(`gotchea ${args.join(' ')} exited with ${res.status}\nstdout:\n${tail(res.stdout)}\nstderr:\n${tail(res.stderr)}`);
  }
  return res;
}

function gotcheaJson(args) {
  const res = gotchea(args);
  const label = `gotchea ${args.join(' ')}`;
  const json = parseJson(label, res.stdout);
  record(label, json, { raw: res.stdout });
  return json;
}

// ---------------------------------------------------------------------------------------
// MCP stdio client: newline-delimited JSON-RPC, one request at a time.

class McpClient {
  constructor(child) {
    this.child = child;
    this.lines = [];
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 1;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        this.onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    child.stdout.on('end', () => {
      if (buf.length > 0) this.onLine(buf);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (this.stderr += chunk));
    child.once('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new SmokeError(`MCP server exited (${code ?? signal}) before replying\nstderr:\n${tail(this.stderr)}`));
      this.pending.clear();
    });
  }

  onLine(line) {
    this.lines.push(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // reported by the stdout-hygiene check
    }
    const waiter = msg && msg.id !== undefined ? this.pending.get(msg.id) : undefined;
    if (waiter) {
      this.pending.delete(msg.id);
      waiter.resolve(msg);
    }
  }

  send(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SmokeError(`MCP ${method}: no reply within ${TIMEOUT_MS} ms\nstderr:\n${tail(this.stderr)}`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return reply;
  }

  /** tools/call; returns the CallToolResult and records it for the leak scan. */
  async call(name, args = {}, opts = {}) {
    const msg = await this.request('tools/call', { name, arguments: args });
    assert(!msg.error, `MCP ${name}: JSON-RPC error ${JSON.stringify(msg.error)}`);
    const result = msg.result;
    assert(result && Array.isArray(result.content), `MCP ${name}: malformed result ${JSON.stringify(result).slice(0, 300)}`);
    if (!opts.allowError) assert(!result.isError, `MCP ${name} failed: ${toolText(result)}`);
    record(`mcp ${name}`, result, { reveal: name === 'submit_answer' });
    return result;
  }
}

const toolText = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function withMcp(fn) {
  const child = spawnNode([ctx.bin, 'mcp'], { cwd: ctx.fixture, env: ctx.env });
  const client = new McpClient(child);
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pack-smoke', version: '0.0.0' },
    });
    assert(!init.error, `initialize failed: ${JSON.stringify(init.error)}`);
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await fn(client, init.result);
  } finally {
    // A closed stdin is the client leaving: the server must exit on its own.
    child.stdin.end();
    const exited = await waitExit(child, 10_000);
    if (!exited) await stopChild(child);
    client.exitedCleanly = exited !== null && exited.code === 0;
  }
  return client;
}

/** Every stdout line of the MCP server must be a JSON-RPC 2.0 message: logs belong on stderr. */
function assertJsonRpcOnly(client) {
  const bad = client.lines.filter((line) => {
    try {
      const m = JSON.parse(line);
      return !(m && m.jsonrpc === '2.0' && ('id' in m || 'method' in m));
    } catch {
      return true;
    }
  });
  assert(client.lines.length > 0, 'MCP stdout was empty');
  assert(bad.length === 0, `MCP stdout carried ${bad.length} non-JSON-RPC line(s):\n${bad.slice(0, 5).join('\n')}`);
}

// ---------------------------------------------------------------------------------------
// HTTP GET against 127.0.0.1 (the serve Host allowlist wants 127.0.0.1:<port> exactly).

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` }, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------
// Steps.

const steps = [
  [
    'build workspace (pnpm -r build)',
    () => {
      runTool('pnpm', ['-r', 'build'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
      return 'ok';
    },
  ],
  [
    'pack public packages (pnpm pack)',
    () => {
      ctx.packDir = makeTemp('gotchea-smoke-pack-');
      for (const p of PACKAGES) {
        runTool('pnpm', ['pack', '--pack-destination', ctx.packDir], { cwd: join(REPO, p.dir), stdio: ['ignore', 'pipe', 'pipe'] });
      }
      const tgz = readdirSync(ctx.packDir).filter((f) => f.endsWith('.tgz'));
      for (const p of PACKAGES) assert(tgz.some((f) => new RegExp(`^${p.name}-\\d`).test(f)), `no tarball for ${p.name} in ${tgz.join(', ')}`);
      assert(!tgz.some((f) => f.startsWith('gotchea-web')), 'the private gotchea-web package must not be packed');
      return tgz.join(', ');
    },
  ],
  [
    'npm install the three tarballs together',
    () => {
      ctx.installDir = makeTemp('gotchea-smoke-install-');
      writeFileSync(join(ctx.installDir, 'package.json'), `${JSON.stringify({ name: 'gotchea-smoke-consumer', version: '0.0.0', private: true }, null, 2)}\n`);
      const tarballs = readdirSync(ctx.packDir).filter((f) => f.endsWith('.tgz')).map((f) => join(ctx.packDir, f));
      runTool('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], { cwd: ctx.installDir, stdio: ['ignore', 'pipe', 'pipe'] });

      const lock = JSON.parse(readFileSync(join(ctx.installDir, 'package-lock.json'), 'utf8'));
      const versions = [];
      for (const p of PACKAGES) {
        const key = `node_modules/${p.name}`;
        const entry = lock.packages?.[key];
        assert(entry, `${p.name} is not installed`);
        // Only one copy, and it came from the tarball, not the registry.
        assert(typeof entry.resolved === 'string' && entry.resolved.startsWith('file:'), `${p.name} resolved to ${entry.resolved}, expected the local tarball`);
        const nested = Object.keys(lock.packages).filter((k) => k !== key && k.endsWith(`/node_modules/${p.name}`));
        assert(nested.length === 0, `${p.name} installed more than once: ${nested.join(', ')}`);
        const dir = join(ctx.installDir, 'node_modules', p.name);
        assert(!lstatSync(dir).isSymbolicLink(), `${p.name} is a symlink, expected an extracted tarball`);
        const manifest = readFileSync(join(dir, 'package.json'), 'utf8');
        assert(!manifest.includes('workspace:'), `${p.name}/package.json still has a workspace: range`);
        versions.push(`${p.name}@${JSON.parse(manifest).version}`);
      }
      const cli = JSON.parse(readFileSync(join(ctx.installDir, 'node_modules', 'gotchea', 'package.json'), 'utf8'));
      ctx.version = cli.version;
      // The bin target itself, run with this Node: node_modules/.bin holds .cmd shims on Windows.
      ctx.bin = join(ctx.installDir, 'node_modules', 'gotchea', typeof cli.bin === 'string' ? cli.bin : cli.bin.gotchea);
      assert(existsSync(ctx.bin), `bin not found: ${ctx.bin}`);
      const shim = join(ctx.installDir, 'node_modules', '.bin', WIN ? 'gotchea.cmd' : 'gotchea');
      assert(existsSync(shim), `npm did not link the bin: ${shim}`);
      for (const wasm of ['typescript', 'tsx', 'javascript', 'python']) {
        assert(existsSync(join(ctx.installDir, 'node_modules', 'gotchea-core', 'wasm', `tree-sitter-${wasm}.wasm`)), `missing grammar ${wasm}`);
      }
      return versions.join(', ');
    },
  ],
  [
    'create fixture git repo',
    () => {
      ctx.fixture = makeTemp('gotchea-smoke-repo-');
      // GOTCHEA_HOME keeps personal progress and sessions out of the real ~/.gotchea.
      ctx.home = makeTemp('gotchea-smoke-home-');
      ctx.env = { ...process.env, GOTCHEA_HOME: ctx.home, NO_COLOR: '1' };
      delete ctx.env.FORCE_COLOR;
      for (const [rel, text] of Object.entries(FIXTURE_FILES)) {
        const file = join(ctx.fixture, ...rel.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      const git = (...args) => runTool('git', args, { cwd: ctx.fixture, stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q');
      // Local identity and line-ending config: CI runners have no global git config, and
      // Windows' core.autocrlf=true would rewrite the fixture to CRLF.
      git('config', 'user.name', 'gotchea smoke');
      git('config', 'user.email', 'smoke@gotchea.invalid');
      git('config', 'core.autocrlf', 'false');
      git('config', 'commit.gpgsign', 'false');
      git('add', '-A');
      git('commit', '-q', '-m', 'fixture');
      return `${Object.keys(FIXTURE_FILES).length} files committed`;
    },
  ],
  [
    'gotchea --version',
    () => {
      const out = gotchea(['--version']).stdout.trim();
      assert(out === ctx.version, `--version printed ${JSON.stringify(out)}, expected ${ctx.version}`);
      return out;
    },
  ],
  [
    '(a) gotchea init',
    () => {
      gotchea(['init']);
      assert(existsSync(join(ctx.fixture, '.gotchea', 'config.json')), '.gotchea/config.json was not written');
      assert(!existsSync(join(ctx.installDir, '.gotchea')), '.gotchea/ landed in the install dir instead of the fixture');
      return '.gotchea/config.json written';
    },
  ],
  [
    '(b) gotchea scan',
    () => {
      gotchea(['scan']);
      const json = gotcheaJson(['scan', '--json']);
      const chunks = JSON.parse(readFileSync(join(ctx.fixture, '.gotchea', 'chunks.json'), 'utf8'));
      const ids = JSON.stringify(chunks);
      // Symbol leaves prove the tree-sitter WASM loaded from the installed gotchea-core.
      assert(ids.includes(QUIZ_CHUNK), `chunks.json has no ${QUIZ_CHUNK} leaf (grammar did not load?)`);
      assert(ids.includes('lib/helper.js'), 'chunks.json misses lib/helper.js');
      assert(!ids.includes('\\\\'), 'chunks.json contains backslash paths');
      return `scan --json keys: ${Object.keys(json).join(',')}`;
    },
  ],
  [
    '(c) gotchea map --json',
    () => {
      const json = gotcheaJson(['map', '--json']);
      assert(json.root && Array.isArray(json.root.children), 'map --json has no root.children');
      const names = [];
      const walk = (n) => {
        names.push(n.id);
        for (const c of n.children) walk(c);
      };
      walk(json.root);
      assert(names.includes(QUIZ_CHUNK), `map --json has no ${QUIZ_CHUNK}`);
      return `${names.length} nodes, top keys: ${Object.keys(json).join(',')}`;
    },
  ],
  [
    '(d) gotchea serve --port 0 --no-open + GET /api/map',
    async () => {
      const child = spawnNode([ctx.bin, 'serve', '--port', '0', '--no-open'], { cwd: ctx.fixture, env: ctx.env });
      child.stdin.end();
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => (err += c));
      try {
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new SmokeError(`serve printed no URL within ${TIMEOUT_MS} ms\nstdout:\n${out}\nstderr:\n${err}`)), TIMEOUT_MS);
          child.stdout.on('data', (c) => {
            out += c;
            const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
            if (m) {
              clearTimeout(timer);
              resolve(Number(m[1]));
            }
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new SmokeError(`serve exited early (${code})\nstdout:\n${out}\nstderr:\n${err}`));
          });
        });
        assert(port > 0, `serve reported port ${port}`);
        const res = await httpGet(port, '/api/map');
        assert(res.status === 200, `GET /api/map -> ${res.status}: ${res.body.slice(0, 200)}`);
        assert(/^application\/json/.test(res.headers['content-type'] ?? ''), `GET /api/map content-type ${res.headers['content-type']}`);
        const json = parseJson('GET /api/map', res.body);
        record('GET /api/map', json, { raw: res.body });
        assert(json.root, 'GET /api/map has no root');
        const index = await httpGet(port, '/');
        assert(index.status === 200 && /<html/i.test(index.body), `GET / -> ${index.status}, expected the bundled web UI`);
        return `port ${port}, /api/map 200 (${res.body.length} bytes), / 200`;
      } finally {
        const exit = await stopChild(child);
        assert(exit !== null, 'serve did not stop');
      }
    },
  ],
  [
    '(e) MCP stdio: initialize + tools/list, stdout is JSON-RPC only',
    async () => {
      let tools = [];
      let serverInfo = null;
      const client = await withMcp(async (c, init) => {
        serverInfo = init.serverInfo;
        const list = await c.request('tools/list', {});
        assert(!list.error, `tools/list failed: ${JSON.stringify(list.error)}`);
        tools = list.result.tools.map((t) => t.name);
        // Tool definitions describe submit_answer's reveal in its outputSchema: names, not data.
        record('mcp tools/list', list.result, { schema: true });
      });
      assertJsonRpcOnly(client);
      assert(client.exitedCleanly, 'MCP server did not exit with code 0 after stdin closed');
      assert(serverInfo?.name === 'gotchea' && serverInfo?.version === ctx.version, `serverInfo ${JSON.stringify(serverInfo)}`);
      const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
      assert(missing.length === 0, `tools/list misses ${missing.join(', ')} (got ${tools.join(', ')})`);
      return `${tools.length} tools: ${tools.join(', ')}; ${client.lines.length} stdout lines, all JSON-RPC`;
    },
  ],
  [
    '(f) save fixture questions over MCP, then read paths (CLI --json + MCP)',
    async () => {
      const notes = [];
      const client = await withMcp(async (c) => {
        await c.call('scan');
        const tasksRes = await c.call('get_generation_tasks', { limit: 10 });
        const task = tasksRes.structuredContent.tasks.find((t) => t.chunkId === QUIZ_CHUNK);
        assert(task, `get_generation_tasks has no task for ${QUIZ_CHUNK}`);

        const saved = (await c.call('save_questions', { chunkId: QUIZ_CHUNK, chunkHash: task.chunkHash, questions: QUESTIONS })).structuredContent;
        assert(saved.status === 'saved' && saved.rejected.length === 0, `save_questions rejected: ${JSON.stringify(saved.rejected)}`);
        assert(saved.savedCount === QUESTIONS.length, `saved ${saved.savedCount}/${QUESTIONS.length}`);
        notes.push(`saved ${saved.savedCount}`);

        // Agent-facing read paths after the save.
        await c.call('get_map');
        await c.call('get_status');
        await c.call('get_chunk_for_file', { path: 'src/big.ts', line: 50 });
        await c.call('get_generation_tasks', { limit: 10 });

        // One full quiz: the client only knows option texts, so it picks by text.
        const start = (await c.call('start_quiz', { chunkId: QUIZ_CHUNK })).structuredContent;
        assert(start.status === 'started', `start_quiz: ${start.status} ${start.reason}`);
        let question = start.question;
        let answered = 0;
        for (;;) {
          const right = CORRECT_TEXT.get(question.stem);
          const pick = question.options.find((o) => o.text === right);
          assert(pick, `start_quiz/submit_answer served an unknown question: ${question.stem}`);
          const res = (await c.call('submit_answer', { sessionId: start.session.id, questionId: question.questionId, displayIndex: pick.index })).structuredContent;
          answered++;
          assert(res.reveal?.correct === true, `answer ${answered} was not accepted as correct`);
          if (res.status === 'completed') {
            assert(res.result?.passed === true, `quiz did not pass: ${JSON.stringify(res.result)}`);
            break;
          }
          question = res.next;
        }
        notes.push(`quiz passed (${answered} answers)`);
      });
      assertJsonRpcOnly(client);

      const status = gotcheaJson(['status', '--json']);
      const map = gotcheaJson(['map', '--json']);
      const filtered = gotcheaJson(['map', 'src/big.ts', '--json']);
      gotcheaJson(['generate', '--dry-run', '--json']);
      const find = (n, id) => (n.id === id ? n : n.children.map((ch) => find(ch, id)).find(Boolean) ?? null);
      const leaf = find(map.root, QUIZ_CHUNK);
      assert(leaf && leaf.okQuestions === QUESTIONS.length, `map --json okQuestions ${leaf?.okQuestions}, expected ${QUESTIONS.length}`);
      assert(leaf.state.color === 'green', `map --json colour after a passed quiz is ${leaf.state.color}`);
      assert(find(filtered.root, QUIZ_CHUNK), 'map src/big.ts --json has no alpha leaf');
      assert(status.questions >= QUESTIONS.length, `status --json questions ${status.questions}`);
      notes.push(`map: ${QUIZ_CHUNK} green, status: ${status.questions} questions`);

      // The question file in the documented format holds the keys (accepted leak, PLAN §6).
      const qdir = join(ctx.fixture, '.gotchea', 'questions');
      const files = readdirSync(qdir).filter((f) => f.endsWith('.json'));
      assert(files.length === 1, `expected one question file, got ${files.join(', ')}`);
      const qf = JSON.parse(readFileSync(join(qdir, files[0]), 'utf8'));
      assert(qf.version === 2 && qf.chunkId === QUIZ_CHUNK && qf.questions.length === QUESTIONS.length, `unexpected question file ${files[0]}`);
      notes.push(`question file ${files[0]}`);
      return notes.join('; ');
    },
  ],
  [
    '(g) leak scan: no answer keys before an answer (PLAN §6)',
    () => {
      const problems = [];
      let checked = 0;
      let reveals = 0;
      for (const o of outputs) {
        const raw = o.raw ?? JSON.stringify(o.value);
        checked++;
        if (o.schema) {
          if (raw.includes(SENTINEL)) problems.push(`${o.label}: contains ${SENTINEL}`);
          continue;
        }
        if (o.reveal) {
          // submit_answer's reveal is the one sanctioned place for the key of the question just answered;
          // the next question and the rest of the result must stay clean.
          const sc = o.value.structuredContent;
          if (JSON.stringify(sc?.reveal ?? null).includes(SENTINEL)) reveals++;
          const rest = { ...o.value, content: [], structuredContent: { ...sc, reveal: null } };
          for (const hit of forbiddenKeyPaths(rest)) problems.push(`${o.label}: key ${hit}`);
          if (JSON.stringify(rest).includes(SENTINEL)) problems.push(`${o.label}: ${SENTINEL} outside the reveal`);
          continue;
        }
        for (const hit of forbiddenKeyPaths(o.value)) problems.push(`${o.label}: key ${hit}`);
        for (const word of ['"correctIndex"', '"explanation"', SENTINEL]) if (raw.includes(word)) problems.push(`${o.label}: contains ${word}`);
      }
      // Positive control: the reveals must carry the planted explanation, or the scan proves nothing.
      assert(reveals === QUESTIONS.length, `expected ${QUESTIONS.length} reveals with the planted explanation, saw ${reveals}`);
      assert(problems.length === 0, `answer-key leak:\n${problems.join('\n')}`);
      return `${checked} outputs clean, ${reveals} reveals carry the key only after an answer`;
    },
  ],
];

// ---------------------------------------------------------------------------------------

async function main() {
  console.log(`gotchea pack smoke · node ${process.version} · ${process.platform}-${process.arch}`);
  let failed = false;
  for (const [name, fn] of steps) {
    if (failed) {
      console.log(`SKIP  ${name}`);
      continue;
    }
    const t0 = Date.now();
    try {
      const detail = await fn();
      console.log(`PASS  ${name} (${Date.now() - t0} ms)${detail ? ` · ${detail}` : ''}`);
    } catch (err) {
      failed = true;
      console.log(`FAIL  ${name} (${Date.now() - t0} ms)`);
      console.log(String(err instanceof SmokeError ? err.message : (err?.stack ?? err)).replace(/^/gm, '      '));
    }
  }
  console.log(failed ? 'pack smoke: FAIL' : 'pack smoke: PASS');
  return failed ? 1 : 0;
}

for (const [sig, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(sig, () => {
    cleanup();
    process.exit(exitCode);
  });
}

let code = 1;
try {
  code = await main();
} finally {
  cleanup();
}
process.exitCode = code;
