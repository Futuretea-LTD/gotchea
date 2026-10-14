// Filesystem layout. Shared repo state lives in `<root>/.gotchea/`; personal
// state lives in `$GOTCHEA_HOME` (default `~/.gotchea`) under `repos/<repoId>/`.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const GOTCHEA_DIR = '.gotchea';

export interface RepoPaths {
  root: string;
  dir: string;
  config: string;
  chunks: string;
  questionsDir: string;
}

export interface UserPaths {
  home: string;
  repoDir: string;
  progress: string;
  snapshotsDir: string;
  sessionsDir: string;
  scanCache: string;
  lock: string;
}

export function repoPaths(root: string): RepoPaths {
  const abs = resolve(root);
  const dir = join(abs, GOTCHEA_DIR);
  return {
    root: abs,
    dir,
    config: join(dir, 'config.json'),
    chunks: join(dir, 'chunks.json'),
    questionsDir: join(dir, 'questions'),
  };
}

/** `GOTCHEA_HOME` overrides `~/.gotchea` (used by tests). */
export function gotcheaHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['GOTCHEA_HOME'];
  return override && override.length > 0 ? resolve(override) : join(homedir(), GOTCHEA_DIR);
}

/** repoIds are sha256 hex in practice; anything that could leave `repos/` is rejected. */
const SAFE_REPO_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function userPaths(repoId: string, env: NodeJS.ProcessEnv = process.env): UserPaths {
  if (!SAFE_REPO_ID.test(repoId)) throw new Error(`Invalid repoId: ${JSON.stringify(repoId)}`);
  const home = gotcheaHome(env);
  const repoDir = join(home, 'repos', repoId);
  return {
    home,
    repoDir,
    progress: join(repoDir, 'progress.json'),
    snapshotsDir: join(repoDir, 'snapshots'),
    sessionsDir: join(repoDir, 'sessions'),
    scanCache: join(repoDir, 'scan-cache.json'),
    lock: join(repoDir, '.lock'),
  };
}
