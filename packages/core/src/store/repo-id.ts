// repoId (PLAN.md §10.22): hash of the normalized `origin` remote (else the first
// remote), so SSH and HTTPS clones share progress; falls back to the real path.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const SSH_PROTOCOLS = new Set(['ssh', 'git+ssh', 'ssh+git']);

/**
 * `git@github.com:Owner/Repo.git`, `https://user:tok@GitHub.com/Owner/Repo` and
 * `ssh://git@github.com:22/Owner/Repo.git` all become `github.com/Owner/Repo`.
 * Credentials, protocol, ssh ports, trailing `.git` and slashes are stripped; only the host is lowercased.
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim();
  let protocol: string | null = null;
  const proto = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (proto) {
    protocol = proto[1]!.toLowerCase();
    s = s.slice(proto[0].length);
  }

  let host: string;
  let path: string;
  if (protocol === null) {
    // scp-style `[user@]host:path` (a colon before any slash), else a plain path.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(s);
    if (!scp) return stripTrailing(s.replace(/\\/g, '/'));
    host = scp[1]!;
    path = scp[2]!;
  } else {
    const slash = s.indexOf('/');
    let authority = slash < 0 ? s : s.slice(0, slash);
    path = slash < 0 ? '' : s.slice(slash + 1);
    const at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1);
    const colon = authority.lastIndexOf(':');
    if (colon >= 0 && !authority.startsWith('[')) {
      const after = authority.slice(colon + 1);
      if (/^\d*$/.test(after)) {
        // Numeric port: dropped for ssh-like protocols, kept otherwise.
        if (SSH_PROTOCOLS.has(protocol) || protocol === 'git') authority = authority.slice(0, colon);
      } else {
        // `ssh://git@host:owner/repo` (scp path written as a URL).
        path = after + (path ? `/${path}` : '');
        authority = authority.slice(0, colon);
      }
    }
    host = authority;
  }

  path = path.replace(/^\/+/, '');
  const out = path ? `${host.toLowerCase()}/${path}` : host.toLowerCase();
  return stripTrailing(out);
}

function stripTrailing(s: string): string {
  let out = s.replace(/\/+$/, '');
  if (out.toLowerCase().endsWith('.git')) out = out.slice(0, -4);
  return out.replace(/\/+$/, '');
}

/** sha256 hex, first 16 chars. */
export function repoIdFromString(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['-C', root, ...args], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      done(err ? null : stdout.toString());
    });
  });
}

/** URL of `origin`, else of the first listed remote; `null` without git or remotes. */
export async function detectRemoteUrl(root: string): Promise<string | null> {
  const origin = (await git(root, ['remote', 'get-url', 'origin']))?.trim();
  if (origin) return origin;
  const remotes = (await git(root, ['remote']))?.split('\n').map((r) => r.trim()).filter(Boolean) ?? [];
  const first = remotes[0];
  if (!first) return null;
  const url = (await git(root, ['remote', 'get-url', first]))?.trim();
  return url || null;
}

/** Stable per-repository id: hashed normalized remote, else hashed real path of `root`. */
export async function computeRepoId(root: string): Promise<string> {
  const remote = await detectRemoteUrl(root);
  if (remote) return repoIdFromString(normalizeRemoteUrl(remote));
  let abs = resolve(root);
  try {
    abs = await realpath(abs);
  } catch {
    // keep the resolved path
  }
  return repoIdFromString(abs.replace(/\\/g, '/'));
}
