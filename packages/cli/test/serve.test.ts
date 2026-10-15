import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, computeRepoId, type Chunk } from 'gotchea-core';
import { FsQuestionStore } from 'gotchea-core/internal';
import { forbiddenKeyIn, SERVE_FORBIDDEN_KEYS } from '../src/serve/leak-guard.js';
import { startServer, type RunningServer } from '../src/serve/server.js';
import { NOW, SentinelProvider, allKeys, answerDataIn, createSandbox, question, type Sandbox } from './helpers.js';
import { APP_JS, INDEX_HTML, makeWebRoot, raw, type WebRoot } from './serve-helpers.js';

let s: Sandbox;
let web: WebRoot;
const servers: RunningServer[] = [];

async function initAndScan(): Promise<void> {
  await s.gotchea(['init']);
  await writeFile(join(s.root, '.gotchea', 'config.json'), JSON.stringify({ chunking: { leafMaxLoc: 10, leafMinLoc: 8, mergeBelowLoc: 6 } }));
  expect((await s.gotchea(['scan'])).code).toBe(0);
}

async function start(opts: { now?: () => Date; webRoot?: string } = {}): Promise<RunningServer> {
  const server = await startServer({ repoRoot: s.root, port: 0, webRoot: opts.webRoot ?? web.dir, env: s.env, now: opts.now ?? (() => NOW) });
  servers.push(server);
  return server;
}

async function cli(...args: string[]): Promise<string> {
  const r = await s.gotchea(args);
  expect(r.code, r.stderr).toBe(0);
  return r.stdout;
}

async function chunk(id: string): Promise<Chunk> {
  return (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === id)!;
}

/** Every file and directory below `dir` with its mtime and size. */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = await stat(p);
    out.push(`${p} ${st.mtimeMs} ${st.size}`);
    if (e.isDirectory()) out.push(...(await listing(p)));
  }
  return out.sort();
}

beforeEach(async () => {
  s = await createSandbox();
  web = await makeWebRoot();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((x) => x.close()));
  await web.cleanup();
  await s.cleanup();
});

describe('gotchea serve: server', () => {
  it('binds to 127.0.0.1 on the real port', async () => {
    await initAndScan();
    const server = await start();
    expect(server.address).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    expect((await raw(server.port, '/api/status')).status).toBe(200);
  });

  it('/api/map and /api/status are byte-identical to `map --json` and `status --json`', async () => {
    await initAndScan();
    const server = await start();
    const map = await raw(server.port, '/api/map');
    expect(map.status).toBe(200);
    expect(map.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(map.headers['cache-control']).toBe('no-cache');
    expect(map.body).toBe(await cli('map', '--json'));
    expect((await raw(server.port, '/api/map?filter=src/math.ts')).body).toBe(await cli('map', 'src/math.ts', '--json'));
    expect((await raw(server.port, '/api/map?filter=./src/format/')).body).toBe(await cli('map', 'src/format', '--json'));
    expect((await raw(server.port, '/api/map?filter=src%2Fmath.ts%23Stats')).body).toBe(await cli('map', 'src/math.ts#Stats', '--json'));
    expect((await raw(server.port, '/api/status')).body).toBe(await cli('status', '--json'));
  });

  it('validates the filter and maps core results to JSON errors', async () => {
    await initAndScan();
    const { port } = await start();
    for (const q of ['filter=', 'filter=%00', `filter=${'a'.repeat(4097)}`]) {
      const r = await raw(port, `/api/map?${q}`);
      expect(r.status, q).toBe(400);
      expect(JSON.parse(r.body).error).toBe('bad_filter');
    }
    const none = await raw(port, '/api/map?filter=src/ma');
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body)).toEqual({ error: 'no_match', filter: 'src/ma' });
    // './' and '' normalise to the root.
    expect(JSON.parse((await raw(port, '/api/map?filter=./')).body).filter).toBe('.');
    for (const p of ['/api', '/api/', '/api/nope', '/api/map/', '/api/status/x']) {
      const r = await raw(port, p);
      expect(r.status, p).toBe(404);
      expect(JSON.parse(r.body), p).toEqual({ error: 'not_found' });
    }
  });

  it('answers 404 not_scanned before the first scan and reloads after it', async () => {
    await s.gotchea(['init']);
    const { port } = await start();
    const map = await raw(port, '/api/map');
    expect(map.status).toBe(404);
    expect(JSON.parse(map.body)).toEqual({ error: 'not_scanned', message: 'Run `gotchea scan` first.' });
    const status = await raw(port, '/api/status');
    expect(status.status).toBe(200);
    expect(status.body).toBe(await cli('status', '--json'));
    expect(JSON.parse(status.body)).toMatchObject({ scanned: false, chunks: 0 });

    await cli('scan');
    const after = await raw(port, '/api/map');
    expect(after.status).toBe(200);
    expect(after.body).toBe(await cli('map', '--json'));
    expect(JSON.parse((await raw(port, '/api/status')).body)).toMatchObject({ scanned: true, chunks: 8 });
  });

  it('ETag: 304 on a match, a new tag once questions or progress change on disk', async () => {
    await initAndScan();
    const { port } = await start();
    const first = await raw(port, '/api/map');
    const etag = first.headers.etag!;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27,}"$/);
    for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, '*']) {
      const r = await raw(port, '/api/map', { headers: { 'if-none-match': inm } });
      expect(r.status, inm).toBe(304);
      expect(r.body).toBe('');
      expect(r.headers.etag).toBe(etag);
    }
    expect((await raw(port, '/api/map', { headers: { 'if-none-match': '"other"' } })).status).toBe(200);

    const stats = await chunk('src/math.ts#Stats');
    await new FsQuestionStore(s.root).save(stats.id, [question(stats.id, stats.contentHash)]);
    const changed = await raw(port, '/api/map', { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
    expect(changed.body).toBe(await cli('map', '--json'));

    const repoId = await computeRepoId(s.root);
    await new FsProgressStore(repoId, s.env).save({
      version: 1,
      repoId,
      chunks: {
        [stats.id]: {
          stability: 10,
          lastReviewedAt: NOW.toISOString(),
          lastPassedHash: stats.contentHash,
          lastSeenHash: stats.contentHash,
          mustRepass: false,
          history: [],
        },
      },
    });
    const passed = await raw(port, '/api/map', { headers: { 'if-none-match': changed.headers.etag! } });
    expect(passed.status).toBe(200);
    expect(passed.body).toBe(await cli('map', '--json'));
    expect(passed.body).toContain('"color": "green"');
  });

  it('keeps generatedAt stable between reloads and recomputes after 60 s (R decays)', async () => {
    await initAndScan();
    let t = NOW.getTime();
    const { port } = await start({ now: () => new Date(t) });
    const a = JSON.parse((await raw(port, '/api/status')).body);
    t += 30_000;
    expect(JSON.parse((await raw(port, '/api/status')).body).generatedAt).toBe(a.generatedAt);
    t += 31_000;
    expect(JSON.parse((await raw(port, '/api/status')).body).generatedAt).toBe(new Date(t).toISOString());
  });

  it('reloads the config when config.json changes', async () => {
    await initAndScan();
    const { port } = await start();
    const before = JSON.parse((await raw(port, '/api/map')).body);
    expect(before.root.children.length).toBeGreaterThan(0);
    await writeFile(join(s.root, '.gotchea', 'config.json'), '{ "chunking": { "leafMaxLoc": "big" } }');
    const bad = await raw(port, '/api/map');
    expect(bad.status).toBe(500);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'config' });
  });

  it('never leaks answers, options, stems or generated sentinels', async () => {
    await initAndScan();
    const stats = await chunk('src/math.ts#Stats');
    const mean = await chunk('src/math.ts#mean');
    const questions = new FsQuestionStore(s.root);
    await questions.save(stats.id, [question(stats.id, stats.contentHash)]);
    await questions.save(mean.id, [question(mean.id, mean.contentHash)]);
    const gen = await s.gotchea(['generate', '--json', '--limit', '2'], { deps: new SentinelProvider().deps() });
    expect(gen.code, gen.stderr).toBe(0);

    const { port } = await start();
    const paths = ['/api/map', '/api/map?filter=src/math.ts', `/api/map?filter=${encodeURIComponent(stats.id)}`, '/api/map?filter=src', '/api/status'];
    for (const p of paths) {
      const r = await raw(port, p);
      expect(r.status, p).toBe(200);
      expect(answerDataIn(r.body), p).toEqual([]);
      expect(r.body).not.toContain('second guard');
      const keys = allKeys(JSON.parse(r.body));
      for (const k of SERVE_FORBIDDEN_KEYS) expect(keys.has(k), `${p} ${k}`).toBe(false);
    }
    expect(JSON.parse((await raw(port, '/api/status')).body).questions).toBeGreaterThan(2);
  });

  it('the leak guard finds forbidden keys at any depth', () => {
    expect(forbiddenKeyIn({ a: [{ b: { stem: 'x' } }] })).toBe('stem');
    expect(forbiddenKeyIn([{ ok: 1 }, { correctIndex: 0 }])).toBe('correctIndex');
    expect(forbiddenKeyIn({ options: [] })).toBe('options');
    expect(forbiddenKeyIn({ root: { children: [], title: 'stem' } })).toBeNull();
    expect(forbiddenKeyIn(null)).toBeNull();
  });

  it('never writes to the repo or GOTCHEA_HOME while serving', async () => {
    await initAndScan();
    const stats = await chunk('src/math.ts#Stats');
    await new FsQuestionStore(s.root).save(stats.id, [question(stats.id, stats.contentHash)]);
    const { port } = await start();
    const before = [...(await listing(s.root)), ...(await listing(s.home))];
    const paths = ['/api/map', '/api/map?filter=src', '/api/status', '/', '/assets/app.js', '/x/y', '/api/nope', '/../x'];
    await Promise.all(Array.from({ length: 5 }, () => paths.map((p) => raw(port, p))).flat());
    await Promise.all(paths.map((p) => raw(port, p, { method: 'POST' })));
    expect([...(await listing(s.root)), ...(await listing(s.home))]).toEqual(before);
  });

  it('serves static files with content types and falls back to index.html', async () => {
    await initAndScan();
    await writeFile(join(web.dir, 'assets', 'blob.bin'), 'bin');
    const { port } = await start();
    const index = await raw(port, '/');
    expect(index).toMatchObject({ status: 200, body: INDEX_HTML });
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    const js = await raw(port, '/assets/app.js');
    expect(js).toMatchObject({ status: 200, body: APP_JS });
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await raw(port, '/assets/blob.bin')).headers['content-type']).toBe('application/octet-stream');
    for (const p of ['/src/auth/x', '/assets', '/assets/', '/index.html?x=1', '/missing.js']) {
      const r = await raw(port, p);
      expect(r.status, p).toBe(200);
      expect(r.body, p).toBe(INDEX_HTML);
    }
  });

  it('reports missing web assets with a rebuild hint, API still up', async () => {
    await initAndScan();
    const empty = await makeWebRoot({ index: false });
    try {
      const { port } = await start({ webRoot: empty.dir });
      for (const p of ['/', '/src/x']) {
        const r = await raw(port, p);
        expect(r.status).toBe(500);
        expect(r.body).toBe('web assets are missing; rebuild gotchea (pnpm build)\n');
      }
      expect((await raw(port, '/api/status')).status).toBe(200);
    } finally {
      await empty.cleanup();
    }
  });

  it('allows only GET and HEAD; HEAD sends the headers without a body', async () => {
    await initAndScan();
    const { port } = await start();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      for (const p of ['/api/map', '/']) {
        const r = await raw(port, p, { method });
        expect(r.status, `${method} ${p}`).toBe(405);
        expect(r.headers.allow).toBe('GET, HEAD');
      }
    }
    const get = await raw(port, '/api/map');
    const head = await raw(port, '/api/map', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(get.body)));
  });

  it('rejects a port in use with a --port hint', async () => {
    await initAndScan();
    const a = await start();
    const err = await startServer({ repoRoot: s.root, port: a.port, webRoot: web.dir, env: s.env, now: () => NOW }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1, message: `port ${a.port} is already in use. Try another one with --port <n>.` });
  });

  it('close() drops idle keep-alive connections', async () => {
    await initAndScan();
    const server = await start();
    const res = await fetch(`${server.url}api/status`);
    await res.text();
    const t = Date.now();
    await server.close();
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('gotchea serve: command', () => {
  async function serve(args: string[], extra: { open?: (url: string) => void; cwd?: string } = {}) {
    const ac = new AbortController();
    let status: { status: number; body: string } | null = null;
    let url = '';
    const sigint = process.listenerCount('SIGINT');
    const r = await s.gotchea(['serve', ...args], {
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
      deps: {
        serve: {
          webRoot: web.dir,
          signal: ac.signal,
          ...(extra.open ? { openUrl: extra.open } : {}),
          onListening: (server) => {
            url = server.url;
            void raw(server.port, '/api/status').then((x) => {
              status = x;
              ac.abort();
            });
          },
        },
      },
    });
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    return { ...r, url, status: status as { status: number; body: string } | null };
  }

  it('serves until aborted, prints the URL and exits 0', async () => {
    await initAndScan();
    const r = await serve(['--port', '0', '--no-open']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(r.stdout).toBe(`gotchea serve: ${r.url}\nPress Ctrl+C to stop.\n`);
    expect(r.status?.status).toBe(200);
    expect(r.status?.body).toBe(await cli('status', '--json'));
  });

  it('opens the browser unless --no-open', async () => {
    await initAndScan();
    const opened: string[] = [];
    const r = await serve(['--port', '0'], { open: (u) => opened.push(u) });
    expect(r.code).toBe(0);
    expect(opened).toEqual([r.url]);
    const quiet: string[] = [];
    await serve(['--port', '0', '--no-open'], { open: (u) => quiet.push(u) });
    expect(quiet).toEqual([]);
  });

  it('serves the repository given as [path]', async () => {
    await initAndScan();
    const r = await serve([s.root, '--port', '0', '--no-open'], { cwd: '/' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.status?.status).toBe(200);
  });

  it('validates --port and the path', async () => {
    await initAndScan();
    for (const p of ['-1', '65536', 'abc', '1.5', '']) {
      const r = await s.gotchea(['serve', '--port', p, '--no-open']);
      expect(r.code, p).toBe(2);
      expect(r.stderr).toContain('--port must be an integer from 0 to 65535');
    }
    const missing = await s.gotchea(['serve', join(s.root, 'nope'), '--no-open']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('not a directory');
  });

  it('fails before init with the init hint', async () => {
    const r = await s.gotchea(['serve', '--port', '0', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('gotchea init');
  });

  it('is a real command now, not a stub', async () => {
    const help = await s.gotchea(['--help']);
    expect(help.stdout).toMatch(/serve \[options\] \[path\]/);
    expect(help.stdout).not.toContain('not implemented');
    expect((await s.gotchea(['serve', '--help'])).stdout).toContain('--no-open');
  });
});
