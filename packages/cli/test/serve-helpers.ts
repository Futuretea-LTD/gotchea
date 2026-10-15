// Raw HTTP for the serve tests: `http.request` with `path` sends the request target
// verbatim (fetch and `new URL` would normalise `/../` away).
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RawRequest {
  method?: string;
  /** Header overrides; `host: null` sends no Host header at all. */
  headers?: Record<string, string | null>;
}

export function raw(port: number, path: string, opts: RawRequest = {}): Promise<RawResponse> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  let setHost = true;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) {
      delete headers[k];
      if (k === 'host') setHost = false;
    } else headers[k] = v;
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export const INDEX_HTML = '<!doctype html><title>gotchea web test</title>\n';
export const APP_JS = 'console.log("gotchea web test");\n';
/** Lives next to webRoot, never inside it: no response may ever contain it. */
export const OUTSIDE_SECRET = 'OUTSIDE-WEBROOT-SECRET';

export interface WebRoot {
  /** Parent of `dir`, holding package.json and secret.txt (outside the web root). */
  base: string;
  dir: string;
  cleanup: () => Promise<void>;
}

/** A fake built web app: index.html and assets/app.js, with secrets one level up. */
export async function makeWebRoot(opts: { index?: boolean } = {}): Promise<WebRoot> {
  const base = await mkdtemp(join(tmpdir(), 'gotchea-cli-web-'));
  const dir = join(base, 'web');
  await mkdir(join(dir, 'assets'), { recursive: true });
  if (opts.index !== false) await writeFile(join(dir, 'index.html'), INDEX_HTML);
  await writeFile(join(dir, 'assets', 'app.js'), APP_JS);
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: OUTSIDE_SECRET }));
  await writeFile(join(base, 'secret.txt'), OUTSIDE_SECRET);
  return { base, dir, cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5 }) };
}
