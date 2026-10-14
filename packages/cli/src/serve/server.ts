// The `gotchea serve` HTTP server: the web heat map and its read-only JSON API, on
// 127.0.0.1 only and without auth (PLAN §10.28). Host allowlist against DNS rebinding,
// traversal checks on the raw request path, strict headers on every response.
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, join, sep } from 'node:path';
import { ConfigError, mapJsonFrom, statusJsonFrom, toPosixPath, type GotcheaConfig } from 'gotchea-core';
import { CliError } from '../context.js';
import { toJson } from '../render/json.js';
import { forbiddenKeyIn } from './leak-guard.js';
import { MapSource } from './map-source.js';

export const SERVE_HOST = '127.0.0.1';

export interface ServerOptions {
  repoRoot: string;
  /** 0 picks a free port; the bound one is in `RunningServer.port`. */
  port: number;
  /** Directory holding the built web app (index.html, assets/). */
  webRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  config?: GotcheaConfig;
}

export interface RunningServer {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  address: string;
  /** Stops listening and drops every connection, idle keep-alive ones included. */
  close(): Promise<void>;
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const ALLOW = 'GET, HEAD';
const MAX_FILTER = 4096;
const MISSING_ASSETS = 'web assets are missing; rebuild gotchea (pnpm build)';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': JSON_TYPE,
  '.map': JSON_TYPE,
  '.woff2': 'font/woff2',
  '.txt': TEXT_TYPE,
};

interface Reply {
  status: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

const text = (status: number, body: string, headers?: Record<string, string>): Reply => ({
  status,
  type: TEXT_TYPE,
  body: `${body}\n`,
  ...(headers ? { headers } : {}),
});

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const source = await MapSource.open(opts.repoRoot, { env: opts.env, now: opts.now, ...(opts.config ? { config: opts.config } : {}) });
  const rootTitle = basename(opts.repoRoot);
  // Filled in once the port is known.
  const hosts = new Set<string>();

  const route = async (req: IncomingMessage): Promise<Reply> => {
    // DNS rebinding: a page on evil.com resolving to 127.0.0.1 still sends `Host: evil.com`.
    if (!hosts.has(req.headers.host?.toLowerCase() ?? '')) return text(403, 'forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed', { Allow: ALLOW });
    // The raw target: `new URL` would collapse `/../` before it could be rejected.
    const raw = req.url ?? '';
    const q = raw.indexOf('?');
    const path = q < 0 ? raw : raw.slice(0, q);
    if (!path.startsWith('/')) return text(400, 'bad request');
    if (path === '/api' || path.startsWith('/api/')) return api(path, q < 0 ? '' : raw.slice(q + 1));
    return serveStatic(opts.webRoot, path);
  };

  const api = async (path: string, query: string): Promise<Reply> => {
    try {
      if (path === '/api/map') {
        const params = new URLSearchParams(query);
        const raw = params.get('filter');
        if (raw !== null && (raw === '' || raw.length > MAX_FILTER || raw.includes('\0'))) {
          return json(400, { error: 'bad_filter', message: 'filter must be a non-empty repo-relative path or chunk id' });
        }
        // Same normalization as the CLI target: './src/' -> 'src', '' -> '.'.
        const filter = raw === null ? null : toPosixPath(raw);
        const data = await source.get();
        if (!data.snapshot) return json(404, { error: 'not_scanned', message: 'Run `gotchea scan` first.' });
        const r = mapJsonFrom(data.snapshot, { rootTitle, filter, generatedAt: data.generatedAt });
        if (r.status === 'no_root') return json(404, { error: 'no_root', message: '.gotchea/chunks.json has no root chunk. Run `gotchea scan` to rebuild it.' });
        if (r.status === 'no_match') return json(404, { error: 'no_match', filter: r.filter });
        return json(200, r.json);
      }
      if (path === '/api/status') {
        const data = await source.get();
        return json(200, statusJsonFrom(data.status, data.generatedAt));
      }
      return json(404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof ConfigError) return json(500, { error: 'config', message: err.message });
      return json(500, { error: 'internal' });
    }
  };

  // Our Host check answers a missing Host (403 with the security headers), not Node's bare 400.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    route(req)
      .then(
        (reply) => send(req, res, reply),
        () => send(req, res, text(500, 'internal error')),
      )
      .catch(() => res.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(
        err.code === 'EADDRINUSE'
          ? new CliError(`port ${opts.port} is already in use. Try another one with --port <n>.`)
          : new CliError(`cannot listen on ${SERVE_HOST}:${opts.port}: ${err.message}`),
      );
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, SERVE_HOST);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  hosts.add(`${SERVE_HOST}:${port}`);
  hosts.add(`localhost:${port}`);

  let closing: Promise<void> | null = null;
  return {
    url: `http://${SERVE_HOST}:${port}/`,
    port,
    address: typeof addr === 'object' && addr ? addr.address : SERVE_HOST,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })),
  };
}

/** An API document; bodies with answer-bearing keys are refused (500), never sent. */
function json(status: number, value: unknown): Reply {
  if (forbiddenKeyIn(value) !== null) return { status: 500, type: JSON_TYPE, body: toJson({ error: 'internal', message: 'refusing to send answer data' }) };
  return { status, type: JSON_TYPE, body: toJson(value) };
}

async function serveStatic(webRoot: string, path: string): Promise<Reply> {
  const segments: string[] = [];
  for (const part of path.split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return text(400, 'bad request');
    }
    if (seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) return text(403, 'forbidden');
    if (seg !== '') segments.push(seg);
  }

  const root = await realpath(webRoot).catch(() => null);
  if (!root) return text(500, MISSING_ASSETS);
  if (segments.length === 0) return serveIndex(root);
  // Real paths, so a symlink inside webRoot cannot point outside it.
  const real = await realpath(join(root, ...segments)).catch(() => null);
  if (real === null) return serveIndex(root);
  if (real !== root && !real.startsWith(`${root}${sep}`)) return text(403, 'forbidden');
  const st = await stat(real).catch(() => null);
  // SPA: client-side routes (and directories) get the app shell.
  if (!st?.isFile()) return serveIndex(root);
  return { status: 200, type: MIME[extname(real).toLowerCase()] ?? 'application/octet-stream', body: await readFile(real) };
}

async function serveIndex(root: string): Promise<Reply> {
  const body = await readFile(join(root, 'index.html')).catch(() => null);
  return body ? { status: 200, type: MIME['.html']!, body } : text(500, MISSING_ASSETS);
}

/** Strong ETag over the exact body. */
function etagOf(body: string | Buffer): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`;
}

/** `If-None-Match` matches: a comma list of (possibly weak) tags, or `*`. */
function notModified(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || (tag.startsWith('W/') ? tag.slice(2) : tag) === etag;
  });
}

function send(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string | number> = { 'Cache-Control': 'no-cache', ...reply.headers };
  if (reply.status === 200) {
    const etag = etagOf(reply.body);
    headers['ETag'] = etag;
    if (notModified(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  headers['Content-Type'] = reply.type;
  headers['Content-Length'] = Buffer.byteLength(reply.body);
  res.writeHead(reply.status, headers);
  res.end(req.method === 'HEAD' ? undefined : reply.body);
}
