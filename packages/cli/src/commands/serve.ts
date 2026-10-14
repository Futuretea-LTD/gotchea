// `gotchea serve [path] [--port <n>] [--no-open]`: the web heat map on 127.0.0.1 until
// Ctrl+C. Read-only after startup (one reconcile, like every other command).
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from 'gotchea-core';
import { CliError, requireRepoRoot, type CommandContext } from '../context.js';
import { startServer, type RunningServer } from '../serve/server.js';

export const DEFAULT_PORT = 4477;

export interface ServeOptions {
  port?: string;
  /** False with `--no-open`. */
  open?: boolean;
}

export interface ServeDeps {
  serve?: {
    /** Built web app; default: `dist/web/` next to the bundled CLI. */
    webRoot?: string;
    /** Stops the server like SIGINT does (tests). */
    signal?: AbortSignal;
    /** Replaces the browser launch. */
    openUrl?: (url: string) => void;
    onListening?: (server: RunningServer) => void;
  };
}

// tsup bundles the CLI into dist/*.js; the build copies the web bundle to dist/web/.
const defaultWebRoot = (): string => fileURLToPath(new URL('./web/', import.meta.url));

export async function serveCommand(ctx: CommandContext, pathArg: string | undefined, opts: ServeOptions, deps: ServeDeps = {}): Promise<void> {
  const port = parsePort(opts.port);
  const dir = resolve(ctx.dir, pathArg ?? '.');
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new CliError(`not a directory: ${dir}`);
  const root = await requireRepoRoot(dir);
  const config = await loadConfig(root);
  const d = deps.serve ?? {};

  const server = await startServer({ repoRoot: root, port, webRoot: d.webRoot ?? defaultWebRoot(), env: ctx.io.env, now: ctx.io.now, config });
  ctx.out(`gotchea serve: ${server.url}`);
  ctx.out('Press Ctrl+C to stop.');
  d.onListening?.(server);
  if (opts.open !== false) (d.openUrl ?? openBrowser)(server.url);

  let stop = (): void => {};
  const stopped = new Promise<void>((r) => (stop = r));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  d.signal?.addEventListener('abort', stop, { once: true });
  if (d.signal?.aborted) stop();
  try {
    await stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    d.signal?.removeEventListener('abort', stop);
    await server.close();
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const n = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!(n >= 0 && n <= 65535)) throw new CliError(`--port must be an integer from 0 to 65535, got ${JSON.stringify(value)}`, 2);
  return n;
}

/** Best effort: a missing opener or a headless machine is not an error. */
function openBrowser(url: string): void {
  const win = process.platform === 'win32';
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] : win ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    // Verbatim on Windows so `""` (the empty window title) reaches cmd unescaped; the URL has no metacharacters.
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: win });
    child.on('error', () => {});
    child.unref();
  } catch {
    // silent
  }
}
