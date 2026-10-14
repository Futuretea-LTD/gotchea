// Generation tasks (M2_DESIGN.md §3.1): the per-chunk payload shared by the CLI
// provider path and the MCP host path. It carries stems of usable questions only,
// never options, keys or explanations (PLAN §6).
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { okQuestionCounts } from '../map/question-counts.js';
import type { Chunk } from '../model/chunk.js';
import type { QuestionType } from '../model/question.js';
import { compareCodeUnits } from '../hash/hash.js';
import { fanInFactor } from '../score/state.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { usableQuestions } from '../store/question-pool.js';
import { FsQuestionStore } from '../store/question-store.js';
import { chunkLineCount } from './chunk-code.js';
import { LangCodeSchema } from './schema.js';
import { SourceReader, enclosingDeclaration, importSignatures } from './source.js';

export interface ImportSignature {
  /** Import specifier as written in the source. */
  from: string;
  name: string;
  /** Declaration head of the resolved symbol; '' for external imports. */
  signature: string;
}

export interface GenerationTask {
  chunkId: string;
  chunkHash: string;
  path: string;
  title: string;
  /** 'typescript' | 'python' | ... */
  sourceLang: string | null;
  lineCount: number;
  /** Numbered code (`numberChunkCode`), chunk-relative from line 1. */
  code: string;
  context: { imports: ImportSignature[]; enclosing: string | null };
  /** Stems of the chunk's usable questions, for dedupe. */
  existingStems: string[];
  count: number;
  /** Length = `count`. */
  typePlan: QuestionType[];
  questionLang: string;
}

/**
 * Cycles through `types` (config order) starting with the type least represented
 * among `existing` (ties: config order), so a batch always mixes types.
 */
export function planQuestionTypes(count: number, types: readonly QuestionType[], existing: readonly QuestionType[] = []): QuestionType[] {
  if (count <= 0 || types.length === 0) return [];
  const seen = new Map<QuestionType, number>();
  for (const t of existing) seen.set(t, (seen.get(t) ?? 0) + 1);
  let start = 0;
  types.forEach((t, i) => {
    if ((seen.get(t) ?? 0) < (seen.get(types[start]!) ?? 0)) start = i;
  });
  return Array.from({ length: count }, (_, i) => types[(start + i) % types.length]!);
}

/** Chunks with more numbered lines than this are never offered for generation (§3.1 size guard). */
export const MAX_TASK_LINES = 800;

export interface GenerationCandidate {
  chunk: Chunk;
  /** Usable questions at the chunk's current hash. */
  usable: number;
  /** `ceil(poolMultiplier × questionCount)`. */
  target: number;
  deficit: number;
  /** Questions to request in one task: `min(deficit, questionCount, maxBatch)`. */
  count: number;
}

/** Pool target of a leaf: `ceil(poolMultiplier × questionCount)`. */
export function poolTarget(chunk: Pick<Chunk, 'questionCount'>, cfg: Pick<GotcheaConfig['questions'], 'poolMultiplier'>): number {
  return Math.ceil(cfg.poolMultiplier * chunk.questionCount);
}

/**
 * Leaves that need questions, in priority order (§7): grey (no usable questions)
 * first, then the most imported, then the largest gap, then the largest, then id.
 * Leaves below `minLoc`, above MAX_TASK_LINES or with a full pool are dropped.
 */
export function generationCandidates(
  chunks: readonly Chunk[],
  usable: ReadonlyMap<string, number>,
  cfg: Pick<GotcheaConfig, 'questions' | 'quiz'>,
): GenerationCandidate[] {
  const out: (GenerationCandidate & { weight: number })[] = [];
  for (const chunk of chunks) {
    if (!chunk.isLeaf || chunk.metrics.loc < cfg.questions.minLoc || chunkLineCount(chunk) > MAX_TASK_LINES) continue;
    const have = usable.get(chunk.id) ?? 0;
    const target = poolTarget(chunk, cfg.questions);
    const deficit = target - have;
    if (deficit <= 0) continue;
    const count = Math.min(deficit, chunk.questionCount, cfg.questions.maxBatch);
    if (count <= 0) continue;
    const weight = fanInFactor(chunk.metrics.fanIn, cfg.quiz);
    out.push({ chunk, usable: have, target, deficit, count, weight });
  }
  out.sort(
    (a, b) =>
      Number(a.usable > 0) - Number(b.usable > 0) ||
      b.weight - a.weight ||
      b.deficit - a.deficit ||
      b.chunk.metrics.loc - a.chunk.metrics.loc ||
      compareCodeUnits(a.chunk.id, b.chunk.id),
  );
  return out.map(({ weight: _w, ...c }) => c);
}

export interface GetGenerationTasksOptions {
  /** Most tasks to return; defaults to `config.generate.maxChunksPerRun`. */
  limit?: number;
  /** Question language; defaults to `config.questions.lang`. Throws when it is not a language code. */
  lang?: string;
  /** Restrict to this leaf (current id; resolve aliases first). */
  chunkId?: string;
  config?: GotcheaConfig;
}

export interface GenerationTasksResult {
  tasks: GenerationTask[];
  /** Leaves still needing questions beyond the returned page. */
  remaining: number;
  /** Candidates whose working-tree code no longer matches the last scan (run `scan`). */
  changedSinceScan: string[];
}

/**
 * The next generation tasks for the repo at `root` (shared by CLI and MCP), or null
 * when it has not been scanned. Candidates whose file changed since the scan are
 * skipped: a question written against them would be stale on the next scan.
 */
export async function getGenerationTasks(root: string, opts: GetGenerationTasksOptions = {}): Promise<GenerationTasksResult | null> {
  const config = opts.config ?? (await loadConfig(root));
  const file = await new FsChunkStore(root).load();
  if (!file) return null;
  const questionLang = LangCodeSchema.parse(opts.lang ?? config.questions.lang);
  const limit = Math.max(1, opts.limit ?? config.generate.maxChunksPerRun);

  const pool = opts.chunkId === undefined ? file.chunks : file.chunks.filter((c) => c.id === opts.chunkId);
  const candidates = generationCandidates(pool, await okQuestionCounts(root, file.chunks), config);
  const byId = new Map(file.chunks.map((c) => [c.id, c]));
  const knownFiles = new Set(file.chunks.filter((c) => c.kind === 'file').map((c) => c.id));
  const reader = new SourceReader(root, config);
  const store = new FsQuestionStore(root);

  const tasks: GenerationTask[] = [];
  const changedSinceScan: string[] = [];
  let next = 0;
  for (; next < candidates.length && tasks.length < limit; next++) {
    const cand = candidates[next]!;
    const { chunk } = cand;
    if ((await reader.currentHash(chunk)) !== chunk.contentHash) {
      changedSinceScan.push(chunk.id);
      continue;
    }
    const usable = usableQuestions(await store.list(chunk.id), chunk.contentHash);
    const code = await reader.chunkCode(chunk);
    tasks.push({
      chunkId: chunk.id,
      chunkHash: chunk.contentHash,
      path: chunk.ranges[0]?.path ?? chunk.id,
      title: chunk.title,
      sourceLang: chunk.lang ?? null,
      lineCount: code.lineCount,
      code: code.numbered,
      context: {
        imports: await importSignatures(reader, chunk, code, knownFiles),
        enclosing: await enclosingDeclaration(reader, chunk.parentId === null ? undefined : byId.get(chunk.parentId)),
      },
      existingStems: usable.map((q) => q.stem),
      count: cand.count,
      typePlan: planQuestionTypes(
        cand.count,
        config.questions.types,
        usable.map((q) => q.type),
      ),
      questionLang,
    });
  }
  return { tasks, remaining: candidates.length - next, changedSinceScan };
}
