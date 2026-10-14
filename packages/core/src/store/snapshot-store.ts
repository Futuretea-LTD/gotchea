// Line-fingerprint snapshots per content hash: `$GOTCHEA_HOME/repos/<id>/snapshots/<hash>.json`.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeFileAtomic } from './atomic-write.js';
import { userPaths } from './paths.js';
import type { SnapshotStore } from './types.js';

const HASH_RE = /^[0-9a-f]{8,64}$/;

/** Throws unless `hash` is 8–64 lowercase hex chars (guards against path traversal). */
export function assertSnapshotHash(hash: string): void {
  if (!HASH_RE.test(hash)) throw new Error(`Invalid snapshot hash: ${JSON.stringify(hash)}`);
}

export class FsSnapshotStore implements SnapshotStore {
  readonly dir: string;

  constructor(repoId: string, env: NodeJS.ProcessEnv = process.env) {
    this.dir = userPaths(repoId, env).snapshotsDir;
  }

  pathFor(hash: string): string {
    assertSnapshotHash(hash);
    return join(this.dir, `${hash}.json`);
  }

  async get(hash: string): Promise<string[] | null> {
    return readJsonFile<string[]>(this.pathFor(hash));
  }

  /** No-op when a snapshot for `hash` already exists (content is a function of the hash). */
  async put(hash: string, lineFingerprints: string[]): Promise<void> {
    const path = this.pathFor(hash);
    try {
      await access(path);
      return;
    } catch {
      // missing: write it
    }
    await writeFileAtomic(path, `${JSON.stringify(lineFingerprints)}\n`);
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, string[]>();

  async get(hash: string): Promise<string[] | null> {
    assertSnapshotHash(hash);
    const s = this.snapshots.get(hash);
    return s ? [...s] : null;
  }

  async put(hash: string, lineFingerprints: string[]): Promise<void> {
    assertSnapshotHash(hash);
    if (!this.snapshots.has(hash)) this.snapshots.set(hash, [...lineFingerprints]);
  }
}
