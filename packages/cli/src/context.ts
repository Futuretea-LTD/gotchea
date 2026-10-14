// Process boundary for commands: output, cwd, env and clock are injected so the
// commands can be driven programmatically in tests.
import { access, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import pc from 'picocolors';
import { repoPaths } from 'gotchea-core';

export type Colors = ReturnType<typeof pc.createColors>;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Whether ANSI colors may be used (further gated by `--no-color`). */
  color: boolean;
  now: () => Date;
}

export function processIo(): CliIo {
  return {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    cwd: process.cwd(),
    env: process.env,
    color: pc.isColorSupported,
    now: () => new Date(),
  };
}

/** A user-facing failure: printed as `error: <message>` and mapped to an exit code. */
export class CliError extends Error {
  override readonly name = 'CliError';

  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface GlobalOptions {
  cwd?: string;
  color?: boolean;
}

export interface CommandContext {
  io: CliIo;
  pc: Colors;
  /** Absolute directory the command runs in (`--cwd`, else the process cwd). */
  dir: string;
  out: (line?: string) => void;
  warn: (line: string) => void;
}

export async function createContext(io: CliIo, opts: GlobalOptions): Promise<CommandContext> {
  const dir = resolve(io.cwd, opts.cwd ?? '.');
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new CliError(`--cwd: not a directory: ${dir}`);
  const colors = pc.createColors(io.color && opts.color !== false);
  return {
    io,
    pc: colors,
    dir,
    out: (line = '') => io.stdout(`${line}\n`),
    warn: (line) => io.stderr(`${colors.yellow('warning:')} ${line}\n`),
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The nearest directory at or above `dir` holding `.gotchea/config.json`. The search
 * stops at a git work-tree root so it never escapes into an unrelated parent repo.
 */
export async function requireRepoRoot(dir: string): Promise<string> {
  let cur = dir;
  for (;;) {
    if (await exists(repoPaths(cur).config)) return cur;
    const parent = dirname(cur);
    if (parent === cur || (await exists(join(cur, '.git')))) break;
    cur = parent;
  }
  throw new CliError(`not initialized: no .gotchea/config.json in ${dir} or its parents.\nRun \`gotchea init\` in the repository root first.`);
}
