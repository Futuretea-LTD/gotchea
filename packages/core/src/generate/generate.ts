// CLI generation over a provider (M2_DESIGN.md §7): select chunks like
// get_generation_tasks → prompt → provider → saveQuestions (hash gate, validator,
// optional blind verify, persist). One retry per chunk for rejected items. The report
// carries ids, counts and reason codes only, never a stem, option, key or explanation.
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { okQuestionCounts } from '../map/question-counts.js';
import type { Chunk } from '../model/chunk.js';
import type { QuestionPrivate, QuestionType } from '../model/question.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { chunkLineCount } from './chunk-code.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { ProviderError, isConfigError, providerLabel, requestQuestionBatch, type LLMProvider } from './providers/provider.js';
import { saveQuestions } from './save.js';
import { type GenerationTask, MAX_TASK_LINES, getGenerationTasks, poolTarget } from './tasks.js';
import type { RejectionReason } from './validate.js';
import { blindVerify } from './verify.js';

export type GenerateErrorCode = 'not_scanned' | 'unknown_chunk' | 'not_leaf';

/** The run could not start (bad `chunkId`, no scan); nothing was requested or saved. */
export class GenerateError extends Error {
  override readonly name = 'GenerateError';

  constructor(
    readonly code: GenerateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ChunkSkipReason = 'pool_full' | 'too_large' | 'too_small' | 'changed_since_scan' | 'error';

export interface ChunkReport {
  chunkId: string;
  /** Questions asked for in the first attempt. */
  requested: number;
  saved: number;
  /** Saved but flagged by the blind verify (not usable). */
  flagged: number;
  /** `attempt` is 1 for the first request, 2 for the retry; `index` is within that attempt's batch. */
  rejected: { attempt: number; index: number; reason: RejectionReason | 'batch_overflow' }[];
  skipped?: ChunkSkipReason;
  /** Provider or save failure message, or the skip explanation; never contains model output. */
  error?: string;
  /** Dry run only: the planned type order. */
  typePlan?: QuestionType[];
  /** Usable / target pool after the run (or at selection for a dry run / skip). */
  usable?: number;
  target?: number;
}

export interface GenerateReport {
  chunks: ChunkReport[];
  totals: { saved: number; rejected: number; flagged: number };
  /** Leaves still needing questions beyond this run's page. */
  remaining: number;
  /** Candidates skipped because their file changed since the last scan. */
  changedSinceScan: string[];
  /** Blind verify calls that failed (those questions were saved unverified). */
  verifyErrors: number;
  dryRun: boolean;
}

export interface RunGenerateOptions {
  /** Required unless `dryRun`. */
  provider?: LLMProvider;
  /** Blind verify provider; null/undefined = no verify. */
  verifier?: LLMProvider | null;
  config?: GotcheaConfig;
  /** Restrict to one leaf (current id or alias). */
  chunkId?: string;
  /** Question language code (default `config.questions.lang`). */
  lang?: string;
  /** Most chunks to process (default `config.generate.maxChunksPerRun`). */
  limit?: number;
  dryRun?: boolean;
  now?: Date;
  /** Called after each chunk finishes, for progress output. */
  onChunk?: (report: ChunkReport) => void;
}

export async function runGenerate(root: string, opts: RunGenerateOptions): Promise<GenerateReport> {
  const config = opts.config ?? (await loadConfig(root));
  if (!opts.dryRun && !opts.provider) throw new Error('runGenerate: a provider is required unless dryRun is set');

  let only: Chunk | undefined;
  if (opts.chunkId !== undefined) {
    const file = await new FsChunkStore(root).load();
    if (!file) throw new GenerateError('not_scanned', 'No scan yet: run `gotchea scan` first.');
    only = file.chunks.find((c) => c.id === opts.chunkId) ?? file.chunks.find((c) => c.aliases?.includes(opts.chunkId!));
    if (!only) throw new GenerateError('unknown_chunk', `Unknown chunk ${opts.chunkId}. Run \`gotchea map\` to list chunk ids.`);
    if (!only.isLeaf) throw new GenerateError('not_leaf', `${only.id} is not a leaf chunk; questions belong to leaf chunks (see \`gotchea map ${only.id}\`).`);
  }

  const selection = await getGenerationTasks(root, {
    config,
    ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(only ? { chunkId: only.id } : {}),
  });
  if (!selection) throw new GenerateError('not_scanned', 'No scan yet: run `gotchea scan` first.');

  const report: GenerateReport = {
    chunks: [],
    totals: { saved: 0, rejected: 0, flagged: 0 },
    remaining: selection.remaining,
    changedSinceScan: selection.changedSinceScan,
    verifyErrors: 0,
    dryRun: opts.dryRun ?? false,
  };
  const emit = (r: ChunkReport): void => {
    report.chunks.push(r);
    report.totals.saved += r.saved;
    report.totals.rejected += r.rejected.length;
    report.totals.flagged += r.flagged;
    opts.onChunk?.(r);
  };

  if (only && selection.tasks.length === 0) {
    emit(await explainSkip(root, only, config, selection.changedSinceScan.includes(only.id)));
    return report;
  }

  for (const task of selection.tasks) {
    if (opts.dryRun) {
      emit({ chunkId: task.chunkId, requested: task.count, saved: 0, flagged: 0, rejected: [], typePlan: [...task.typePlan] });
      continue;
    }
    const outcome = await generateChunk(root, task, config, opts.provider!, opts.verifier ?? null, opts.now);
    report.verifyErrors += outcome.verifyErrors;
    emit(outcome.report);
  }
  return report;
}

async function explainSkip(root: string, chunk: Chunk, config: GotcheaConfig, changed: boolean): Promise<ChunkReport> {
  const base = { chunkId: chunk.id, requested: 0, saved: 0, flagged: 0, rejected: [] };
  if (changed) return { ...base, skipped: 'changed_since_scan', error: `${chunk.id} was edited after the last scan: run \`gotchea scan\` first.` };
  const lines = chunkLineCount(chunk);
  if (lines > MAX_TASK_LINES) return { ...base, skipped: 'too_large', error: `${chunk.id} has ${lines} lines (max ${MAX_TASK_LINES}).` };
  if (chunk.metrics.loc < config.questions.minLoc) {
    return { ...base, skipped: 'too_small', error: `${chunk.id} has ${chunk.metrics.loc} LOC (min ${config.questions.minLoc}, questions.minLoc).` };
  }
  const usable = (await okQuestionCounts(root, [chunk])).get(chunk.id) ?? 0;
  return { ...base, skipped: 'pool_full', usable, target: poolTarget(chunk, config.questions) };
}

async function generateChunk(
  root: string,
  task: GenerationTask,
  config: GotcheaConfig,
  provider: LLMProvider,
  verifier: LLMProvider | null,
  now: Date | undefined,
): Promise<{ report: ChunkReport; verifyErrors: number }> {
  const report: ChunkReport = { chunkId: task.chunkId, requested: task.count, saved: 0, flagged: 0, rejected: [] };
  let verifyErrors = 0;
  const verify = verifier
    ? (q: QuestionPrivate) =>
        blindVerify({ answer: (req) => verifier.completeJson(req), verifier: providerLabel(verifier), task, question: q, seed: q.id })
    : undefined;

  let attemptTask = task;
  let retryNote = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let items: unknown[];
    try {
      const prompt = { system: buildSystemPrompt(), user: buildUserPrompt(attemptTask) + retryNote };
      items = (await requestQuestionBatch(provider, prompt)).questions;
    } catch (err) {
      if (isConfigError(err) || !(err instanceof ProviderError)) throw err;
      if (report.saved === 0) report.skipped = 'error';
      report.error = err.message;
      break;
    }
    // A model that over-delivers would trip the batch cap; extra items are dropped.
    for (let i = attemptTask.count; i < items.length; i++) report.rejected.push({ attempt, index: i, reason: 'batch_overflow' });
    items = items.slice(0, attemptTask.count);

    const result = await saveQuestions(
      root,
      { chunkId: task.chunkId, chunkHash: task.chunkHash, lang: task.questionLang, questions: items },
      { generatedBy: providerLabel(provider), config, ...(now ? { now } : {}), ...(verify ? { verify } : {}) },
    );
    if (result.status === 'rejected') {
      if (report.saved === 0) report.skipped = 'error';
      report.error = result.message;
      break;
    }
    verifyErrors += result.verifyErrors.length;
    report.saved += result.accepted.length;
    report.flagged += result.accepted.filter((a) => a.flagged).length;
    for (const r of result.rejected) report.rejected.push({ attempt, index: r.index, reason: r.reason });
    report.usable = result.usableQuestions;
    report.target = result.target;

    const missing = attemptTask.count - result.accepted.length;
    if (attempt === 2 || missing <= 0) break;

    // Retry: the same prompt for the missing count, the stems accepted so far added to
    // existingStems, and the rejection reasons (codes only) appended.
    const acceptedIdx = new Set(result.accepted.map((a) => a.index));
    const acceptedStems = items.flatMap((item, i) => (acceptedIdx.has(i) ? [stemOf(item)] : [])).filter((s): s is string => s !== null);
    const typePlan = attemptTask.typePlan.filter((_, i) => !acceptedIdx.has(i)).slice(0, missing);
    while (typePlan.length < missing) typePlan.push(attemptTask.typePlan[typePlan.length % attemptTask.typePlan.length]!);
    attemptTask = { ...attemptTask, count: missing, typePlan, existingStems: [...attemptTask.existingStems, ...acceptedStems] };
    retryNote =
      result.rejected.length > 0
        ? `\n\nPrevious attempt rejected: ${result.rejected.map((r) => `${r.index}: ${r.reason}`).join(', ')}. Avoid these problems.`
        : `\n\nPrevious attempt returned ${items.length} of ${result.accepted.length + missing} questions.`;
  }
  return { report, verifyErrors };
}

function stemOf(item: unknown): string | null {
  const stem = (item as { stem?: unknown } | null)?.stem;
  return typeof stem === 'string' ? stem.trim() : null;
}
