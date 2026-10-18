// Config schema for `.gotchea/config.json` (PLAN.md §3). Every field is optional
// in the file; parsing fills defaults and deep-merges nested objects (arrays replace).
import { z } from 'zod';
import {
  DEFAULT_EXCLUDE,
  DEFAULT_GENERATED_MARKERS,
  DEFAULT_LANGUAGES,
  DEFAULT_QUESTION_BANDS,
  DEFAULT_QUESTION_TYPES,
  DEFAULT_TEST_PATTERNS,
} from './defaults.js';
import { LangCodeSchema, QUESTION_TYPES } from '../generate/schema.js';

const positive = z.number().positive();
const ratio = z.number().min(0).max(1);
/** A color threshold of 0 would make `dueAt` infinite. */
const threshold = z.number().gt(0).max(1);
const count = z.number().int().positive();

export const QuestionBandSchema = z.object({
  maxLoc: count.optional(),
  maxComplexity: count.optional(),
  count,
});

export const ChunkingConfigSchema = z
  .object({
    leafMinLoc: count.default(40),
    leafMaxLoc: count.default(200),
    mergeBelowLoc: count.default(15),
    splitAboveLoc: count.default(300),
  })
  .refine((c) => c.leafMinLoc <= c.leafMaxLoc, { message: 'leafMinLoc must be <= leafMaxLoc' });

export const QuestionsConfigSchema = z.object({
  /** Evaluated in order; the first band whose limits hold wins. The last band should be open-ended. */
  bands: z.array(QuestionBandSchema).min(1).default(() => DEFAULT_QUESTION_BANDS.map((b) => ({ ...b }))),
  poolMultiplier: positive.default(2),
  lang: LangCodeSchema.default('en'),
  types: z
    .array(z.enum(QUESTION_TYPES))
    .min(1)
    .default(() => [...DEFAULT_QUESTION_TYPES]),
  dedupeJaccard: ratio.default(0.8),
  maxCorrectLengthRatio: positive.default(1.4),
  /** Leak check: share of the correct option's content words found in the stem. */
  leakWordOverlap: ratio.default(0.6),
  /** Leak check: how much more the correct option must overlap than the best distractor. */
  leakMargin: ratio.default(0.25),
  /** Length skew is ignored below this absolute difference (short code-token options). */
  lengthSkewMinChars: z.number().int().min(0).default(8),
  /** Most questions accepted per save call. */
  maxBatch: count.default(20),
  /** Leaves below this LOC are not offered for generation. */
  minLoc: z.number().int().min(0).default(5),
  verify: z.boolean().default(false),
});

export const GenerateConfigSchema = z.object({
  maxChunksPerRun: count.default(10),
});

export const QuizConfigSchema = z.object({
  passRatio: ratio.default(0.75),
  excludeRecentSessions: z.number().int().min(0).default(2),
  fanInWeight: z.number().min(0).default(0.5),
  /** Smallest allowed session size. */
  minQuestions: z.number().int().min(1).default(3),
  /** Idle timeout of a quiz session; refreshed on every answer. */
  sessionTtlMinutes: z.number().int().min(1).default(120),
  /** Finished or expired session files are deleted after this many days. */
  sessionRetentionDays: z.number().int().min(0).default(7),
  /** Show a working-tree code preview with each question. Makes the quiz "open book"; turn off for a recall test. */
  showCode: z.boolean().default(true),
});

export const ScoreConfigSchema = z
  .object({
    initialStability: positive.default(3),
    passMultiplier: positive.default(2.5),
    failMultiplier: positive.default(0.3),
    minStability: positive.default(1),
    forgettingFactor: positive.default(9),
    greenAt: threshold.default(0.85),
    yellowAt: threshold.default(0.5),
    changeDecayFloor: ratio.default(0.1),
    redOnChangeRatio: ratio.default(0.5),
  })
  .refine((s) => s.yellowAt <= s.greenAt, { message: 'yellowAt must be <= greenAt' });

export const ProviderNameSchema = z.enum(['anthropic', 'openai', 'openai-compatible']);

export const ProviderConfigSchema = z.object({
  default: ProviderNameSchema.default('anthropic'),
  /** Provider used by the optional blind verify pass; null = same as `default`. */
  verify: ProviderNameSchema.nullable().default(null),
  models: z
    .object({
      anthropic: z.string().nullable().default('claude-sonnet-5-5'),
      openai: z.string().nullable().default(null),
      'openai-compatible': z.string().nullable().default(null),
    })
    .prefault({}),
  baseUrl: z.string().url().default('http://localhost:11434/v1'),
});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  include: z.array(z.string()).default(() => ['**/*']),
  exclude: z.array(z.string()).default(() => [...DEFAULT_EXCLUDE]),
  /** Extra ignore globs appended to `exclude` (so overriding them never drops the defaults). */
  ignore: z.array(z.string()).default(() => []),
  respectGitignore: z.boolean().default(true),
  includeTests: z.boolean().default(false),
  testPatterns: z.array(z.string()).default(() => [...DEFAULT_TEST_PATTERNS]),
  generatedMarkers: z.array(z.string()).default(() => [...DEFAULT_GENERATED_MARKERS]),
  maxFileBytes: count.default(524288),
  languages: z.array(z.string()).default(() => [...DEFAULT_LANGUAGES]),
  chunking: ChunkingConfigSchema.prefault({}),
  questions: QuestionsConfigSchema.prefault({}),
  generate: GenerateConfigSchema.prefault({}),
  quiz: QuizConfigSchema.prefault({}),
  score: ScoreConfigSchema.prefault({}),
  provider: ProviderConfigSchema.prefault({}),
});

export type GotcheaConfig = z.output<typeof ConfigSchema>;
/** What `.gotchea/config.json` may contain: every field optional. */
export type GotcheaConfigInput = z.input<typeof ConfigSchema>;
export type ChunkingConfig = GotcheaConfig['chunking'];
export type QuestionsConfig = GotcheaConfig['questions'];
export type QuestionBand = QuestionsConfig['bands'][number];
export type GenerateConfig = GotcheaConfig['generate'];
export type QuizConfig = GotcheaConfig['quiz'];
export type ScoreConfig = GotcheaConfig['score'];
export type ProviderConfig = GotcheaConfig['provider'];
export type ProviderName = z.output<typeof ProviderNameSchema>;
