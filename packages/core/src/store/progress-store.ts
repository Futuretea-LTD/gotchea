// Personal progress at `$GOTCHEA_HOME/repos/<repoId>/progress.json` (never committed).
import type { ProgressFile } from '../model/progress.js';
import { readJsonFile, writeFileAtomic } from './atomic-write.js';
import { canonicalJson, compareCodeUnits } from './json.js';
import { userPaths } from './paths.js';
import type { ProgressStore } from './types.js';

function emptyProgress(repoId: string): ProgressFile {
  return { version: 1, repoId, chunks: {} };
}

/** Same file with chunk keys in code-unit order. */
function sortedProgress(file: ProgressFile): ProgressFile {
  const chunks: ProgressFile['chunks'] = {};
  for (const k of Object.keys(file.chunks).sort(compareCodeUnits)) chunks[k] = file.chunks[k]!;
  return { version: file.version, repoId: file.repoId, chunks };
}

export class FsProgressStore implements ProgressStore {
  readonly path: string;

  constructor(
    readonly repoId: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.path = userPaths(repoId, env).progress;
  }

  async load(): Promise<ProgressFile> {
    const file = await readJsonFile<ProgressFile>(this.path);
    if (file === null) return emptyProgress(this.repoId);
    if (file.version !== 1) throw new Error(`Unsupported progress file version in ${this.path}`);
    return file;
  }

  async save(file: ProgressFile): Promise<void> {
    await writeFileAtomic(this.path, canonicalJson(sortedProgress(file), { sortKeys: false }));
  }
}

export class InMemoryProgressStore implements ProgressStore {
  private file: ProgressFile;

  constructor(readonly repoId: string) {
    this.file = emptyProgress(repoId);
  }

  async load(): Promise<ProgressFile> {
    return structuredClone(this.file);
  }

  async save(file: ProgressFile): Promise<void> {
    this.file = structuredClone(sortedProgress(file));
  }
}
