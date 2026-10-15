import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/serve/server.js';
import { NOW, createSandbox, type Sandbox } from './helpers.js';
import { INDEX_HTML, OUTSIDE_SECRET, makeWebRoot, raw, type RawResponse, type WebRoot } from './serve-helpers.js';

let s: Sandbox;
let web: WebRoot;
let server: RunningServer;
let port: number;

const CSP = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function expectSecurityHeaders(r: RawResponse, what: string): void {
  expect(r.headers['content-security-policy'], what).toBe(CSP);
  expect(r.headers['x-content-type-options'], what).toBe('nosniff');
  expect(r.headers['referrer-policy'], what).toBe('no-referrer');
  expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-')), what).toEqual([]);
}

beforeAll(async () => {
  s = await createSandbox();
  web = await makeWebRoot();
  // Symlinks inside the web root that point outside it.
  await symlink(join(web.base, 'secret.txt'), join(web.dir, 'assets', 'leak.txt'), 'file');
  // A junction on Windows (no privilege needed); the type is ignored elsewhere.
  await symlink(web.base, join(web.dir, 'out'), 'junction');
  await writeFile(join(web.dir, 'assets', 'ok.txt'), 'ok');
  await s.gotchea(['init']);
  expect((await s.gotchea(['scan'])).code).toBe(0);
  server = await startServer({ repoRoot: s.root, port: 0, webRoot: web.dir, env: s.env, now: () => NOW });
  port = server.port;
});

afterAll(async () => {
  await server.close();
  await web.cleanup();
  await s.cleanup();
});

describe('gotchea serve: security', () => {
  it('allows only Host 127.0.0.1:<port> and localhost:<port> (DNS rebinding)', async () => {
    for (const host of ['evil.com', `evil.com:${port}`, `127.0.0.1:${port + 1}`, 'localhost', '127.0.0.1', `[::1]:${port}`, `0.0.0.0:${port}`, 'localhost:', `localhost:${port}.evil.com`]) {
      const r = await raw(port, '/api/status', { headers: { host } });
      expect(r.status, `host=${JSON.stringify(host)}`).toBe(403);
      expect(r.body, host).not.toContain('"version"');
      expectSecurityHeaders(r, host);
    }
    const missing = await raw(port, '/api/status', { headers: { host: null } });
    expect(missing.status).toBe(403);
    // Checked before routing and before the method.
    expect((await raw(port, '/api/status', { method: 'POST', headers: { host: 'evil.com' } })).status).toBe(403);
    for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
      expect((await raw(port, '/api/status', { headers: { host } })).status, host).toBe(200);
    }
  });

  it('sends the security headers on every response and never CORS headers', async () => {
    const ok = await raw(port, '/api/map', { headers: { origin: 'https://evil.com' } });
    const cases: [string, RawResponse][] = [
      ['200 api', ok],
      ['200 static', await raw(port, '/assets/app.js')],
      ['200 spa', await raw(port, '/some/route')],
      ['304', await raw(port, '/api/map', { headers: { 'if-none-match': ok.headers.etag! } })],
      ['400', await raw(port, '/%E0%A4%A')],
      ['403', await raw(port, '/../package.json')],
      ['404', await raw(port, '/api/nope')],
      ['405', await raw(port, '/api/map', { method: 'POST' })],
      ['HEAD', await raw(port, '/', { method: 'HEAD' })],
      ['OPTIONS preflight', await raw(port, '/api/map', { method: 'OPTIONS', headers: { origin: 'https://evil.com', 'access-control-request-method': 'GET' } })],
    ];
    expect(cases.map(([, r]) => r.status)).toEqual([200, 200, 200, 304, 400, 403, 404, 405, 200, 405]);
    for (const [what, r] of cases) expectSecurityHeaders(r, what);
  });

  it('rejects path traversal on the raw request target', async () => {
    const attacks = [
      '/../package.json',
      '/../../package.json',
      '/%2e%2e/package.json',
      '/%2E%2E/package.json',
      '/%2e%2e%2fpackage.json',
      '/assets/..%2f..%2fpackage.json',
      '/assets/../../package.json',
      '/..\\package.json',
      '/%5c..%5cpackage.json',
      '/assets/%2e/app.js',
      '/./index.html',
      '/assets/app.js%00.html',
      '/../secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
    ];
    for (const p of attacks) {
      const r = await raw(port, p);
      expect([400, 403, 404], p).toContain(r.status);
      expect(r.body, p).not.toContain(OUTSIDE_SECRET);
    }
    expect((await raw(port, '/%zz')).status).toBe(400);
  });

  it('rejects Windows path forms (drive letters, trailing dots and spaces, encoded absolute paths)', async () => {
    // Win32 path normalisation strips trailing dots and spaces from segments, so `.. ` or
    // `...` may act as `..` there; the real-path containment check must still hold. Some of
    // these are harmless SPA routes elsewhere, so the shell is an acceptable answer too.
    const attacks = [
      '/%2e%2e%20/secret.txt',
      '/%2e%2e%2e/secret.txt',
      '/%2e%2e./package.json',
      '/assets/..%20/..%20/secret.txt',
      '/C:/Windows/win.ini',
      '/C:%5cWindows%5cwin.ini',
      `/${encodeURIComponent(join(web.base, 'secret.txt'))}`,
      '/index.html::$DATA',
    ];
    for (const p of attacks) {
      const r = await raw(port, p);
      expect(r.body, p).not.toContain(OUTSIDE_SECRET);
      if (r.status === 200) expect(r.body, p).toBe(INDEX_HTML);
      else expect([400, 403, 404], p).toContain(r.status);
    }
  });

  it('never resolves Windows device names, data streams or trailing dots and spaces on disk', async () => {
    // On Windows these would open a device (COM1), a data stream or `app.js` itself.
    for (const p of ['/COM1', '/assets/nul.js', '/aux', '/CONIN$', '/assets/app.js.', '/assets/app.js%20', '/assets/app.js::$DATA', '/assets/app.js:x']) {
      expect(await raw(port, p), p).toMatchObject({ status: 200, body: INDEX_HTML });
    }
    expect((await raw(port, '/assets/app.js')).body).not.toBe(INDEX_HTML);
  });

  it('refuses symlinks that leave the web root', async () => {
    for (const p of ['/assets/leak.txt', '/out/secret.txt', '/out/package.json']) {
      const r = await raw(port, p);
      expect([403, 404], p).toContain(r.status);
      expect(r.body, p).not.toContain(OUTSIDE_SECRET);
    }
    expect((await raw(port, '/assets/ok.txt')).body).toBe('ok');
  });

  it('rejects an absolute-form request target', async () => {
    const r = await raw(port, `http://127.0.0.1:${port}/api/status`);
    expect(r.status).toBe(400);
    expectSecurityHeaders(r, 'absolute-form');
  });

  it('serves the SPA shell for client-side routes', async () => {
    const r = await raw(port, '/src/auth/x');
    expect(r).toMatchObject({ status: 200, body: INDEX_HTML });
  });
});
