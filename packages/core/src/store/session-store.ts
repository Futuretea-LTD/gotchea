// Quiz sessions at `$GOTCHEA_HOME/repos/<repoId>/sessions/<sessionId>.json`, written atomically.
// A session file holds permutations and answer flags only: never stems, options or the key.
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_ID, SessionSchema, type Session } from '../quiz/session.js';
import { isErrno, writeFileAtomic } from './atomic-write.js';
import { canonicalJson } from './json.js';
import { userPaths } from './paths.js';
import type { SessionStore } from './types.js';

export class FsSessionStore implements SessionStore {
  readonly dir: string;

  constructor(repoId: string, env: NodeJS.ProcessEnv = process.env) {
    this.dir = userPaths(repoId, env).sessionsDir;
  }

  /** The id is the only client-supplied path component: validated before any path is built. */
  pathFor(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<Session | null> {
    if (!SESSION_ID.test(id)) return null;
    return this.read(this.pathFor(id));
  }

  async put(session: Session): Promise<void> {
    await writeFileAtomic(this.pathFor(SessionSchema.parse(session).id), canonicalJson(session, { sortKeys: false }));
  }

  async delete(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  async list(): Promise<Session[]> {
    const out: Session[] = [];
    for (const name of await this.names()) {
      if (!name.endsWith('.json')) continue;
      const s = await this.read(join(this.dir, name));
      if (s) out.push(s);
    }
    return out;
  }

  async purgeBroken(olderThanMs: number): Promise<number> {
    let removed = 0;
    for (const name of await this.names()) {
      const path = join(this.dir, name);
      const broken = name.endsWith('.tmp') || (name.endsWith('.json') && (await this.read(path)) === null);
      if (!broken) continue;
      const st = await stat(path).catch(() => null);
      if (st && st.mtimeMs < olderThanMs) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }

  private async names(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
  }

  private async read(path: string): Promise<Session | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      const parsed = SessionSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as Session) : null;
    } catch {
      return null;
    }
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async get(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async put(session: Session): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async list(): Promise<Session[]> {
    return [...this.sessions.values()].map((s) => structuredClone(s));
  }

  async purgeBroken(): Promise<number> {
    return 0;
  }
}
