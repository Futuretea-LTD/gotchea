// Question pools, one file per chunk: `.gotchea/questions/<questionFileName(id)>`.
// Files are v2 (M2_DESIGN.md §9); v1 files are upgraded on read and rewritten as v2 on the next save.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { questionFileName } from '../model/ids.js';
import type { QuestionPrivate, QuestionsFile } from '../model/question.js';
import { isErrno, readJsonFile, writeFileAtomic } from './atomic-write.js';
import { compareCodeUnits, stableStringify } from './json.js';
import { KeyedLock } from './keyed-lock.js';
import { repoPaths } from './paths.js';
import type { QuestionStore } from './types.js';

function sortById(qs: QuestionPrivate[]): QuestionPrivate[] {
  return [...qs].sort((a, b) => compareCodeUnits(a.id, b.id));
}

/** Destination wins on id collisions; every question gets `chunkId = toId`. */
function mergePools(dest: QuestionPrivate[], src: QuestionPrivate[], toId: string): QuestionPrivate[] {
  const byId = new Map<string, QuestionPrivate>();
  for (const q of src) byId.set(q.id, { ...q, chunkId: toId });
  for (const q of dest) byId.set(q.id, { ...q, chunkId: toId });
  return sortById([...byId.values()]);
}

/**
 * v1 → v2 (pure): `'flagged'` status becomes `ok + flagged`, absolute v1 refs are dropped
 * (they can't be made chunk-relative without the old ranges), and the new fields get
 * their "unknown" values. v2 files pass through; any other version throws.
 */
export function upgradeQuestionsFile(file: unknown, source = 'questions file'): QuestionsFile {
  const f = file as { version?: unknown; chunkId?: unknown; questions?: unknown };
  if (!f || typeof f !== 'object' || typeof f.chunkId !== 'string' || !Array.isArray(f.questions)) {
    throw new Error(`Malformed questions file in ${source}`);
  }
  if (f.version === 2) return f as QuestionsFile;
  if (f.version !== 1) throw new Error(`Unsupported questions file version in ${source}`);
  const questions = (f.questions as Record<string, unknown>[]).map((q): QuestionPrivate => {
    const { status, ...rest } = q as unknown as Omit<QuestionPrivate, 'status'> & { status: string };
    return {
      ...rest,
      chunkLines: 0,
      refs: [],
      promptVersion: 'p0',
      status: status === 'stale' ? 'stale' : 'ok',
      flagged: status === 'flagged',
      verifiedBy: null,
    };
  });
  return { version: 2, chunkId: f.chunkId, questions };
}

export class FsQuestionStore implements QuestionStore {
  readonly dir: string;
  private readonly lock = new KeyedLock();

  constructor(root: string) {
    this.dir = repoPaths(root).questionsDir;
  }

  pathFor(chunkId: string): string {
    return join(this.dir, questionFileName(chunkId));
  }

  async list(chunkId: string): Promise<QuestionPrivate[]> {
    const path = this.pathFor(chunkId);
    const raw = await readJsonFile<unknown>(path).catch((err: unknown) => {
      // V8 quotes a snippet of the file in parse errors; here that could be answer text (PLAN §6).
      if (err instanceof Error && err.cause instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}`);
      throw err;
    });
    if (raw === null) return [];
    const file = upgradeQuestionsFile(raw, path);
    // A file-name collision or a hand-edited file must not hand another chunk's pool out (PLAN §10.55).
    return file.chunkId === chunkId ? file.questions : [];
  }

  async save(chunkId: string, questions: QuestionPrivate[]): Promise<void> {
    if (questions.length === 0) return this.remove(chunkId);
    const file: QuestionsFile = { version: 2, chunkId, questions: sortById(questions) };
    await writeFileAtomic(this.pathFor(chunkId), stableStringify(file));
  }

  update(chunkId: string, fn: (pool: QuestionPrivate[]) => QuestionPrivate[] | Promise<QuestionPrivate[]>): Promise<QuestionPrivate[]> {
    return this.lock.run(chunkId, async () => {
      const next = await fn(await this.list(chunkId));
      await this.save(chunkId, next);
      return sortById(next);
    });
  }

  async remove(chunkId: string): Promise<void> {
    await rm(this.pathFor(chunkId), { force: true });
  }

  async move(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const src = await this.list(fromId);
    if (src.length === 0) return;
    const dest = await this.list(toId);
    await this.save(toId, mergePools(dest, src, toId));
    await this.remove(fromId);
  }

  async chunkIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
    const ids: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      // Question files are shared via git; one with merge-conflict markers must not break `map`.
      const file = await readJsonFile<{ chunkId?: unknown }>(join(this.dir, name)).catch(() => null);
      if (file && typeof file.chunkId === 'string') ids.push(file.chunkId);
    }
    return ids.sort(compareCodeUnits);
  }
}

export class InMemoryQuestionStore implements QuestionStore {
  private readonly pools = new Map<string, QuestionPrivate[]>();
  private readonly lock = new KeyedLock();

  async list(chunkId: string): Promise<QuestionPrivate[]> {
    const pool = this.pools.get(chunkId);
    return pool ? structuredClone(pool) : [];
  }

  async save(chunkId: string, questions: QuestionPrivate[]): Promise<void> {
    if (questions.length === 0) {
      this.pools.delete(chunkId);
      return;
    }
    this.pools.set(chunkId, structuredClone(sortById(questions)));
  }

  update(chunkId: string, fn: (pool: QuestionPrivate[]) => QuestionPrivate[] | Promise<QuestionPrivate[]>): Promise<QuestionPrivate[]> {
    return this.lock.run(chunkId, async () => {
      const next = await fn(await this.list(chunkId));
      await this.save(chunkId, next);
      return this.list(chunkId);
    });
  }

  async remove(chunkId: string): Promise<void> {
    this.pools.delete(chunkId);
  }

  async move(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const src = this.pools.get(fromId);
    if (!src || src.length === 0) return;
    this.pools.set(toId, mergePools(this.pools.get(toId) ?? [], src, toId));
    this.pools.delete(fromId);
  }

  async chunkIds(): Promise<string[]> {
    return [...this.pools.keys()].sort(compareCodeUnits);
  }
}
