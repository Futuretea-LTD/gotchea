// Question schemas (M2_DESIGN.md §2). The raw shape is what an LLM or MCP host
// submits; the server stamps every identity/metadata field to get the stored shape.
import { z } from 'zod';
import type { QuestionPrivate, QuestionType } from '../model/question.js';

export const QUESTION_TYPES = ['behavior', 'edge_case', 'purpose', 'impact', 'bug_detection'] as const satisfies readonly QuestionType[];

/** `en`, `tr`, `de`, `pt-BR`, ... (decision D4). */
export const LangCodeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'expected a language code such as en, tr or pt-BR');

/** 1-based line range inside the numbered chunk code; range checks are validator rules (§4). */
export const RefSchema = z.strictObject({
  start: z.number().int(),
  end: z.number().int(),
});

const Option = z.string().trim().min(1).max(300);
const CorrectIndex = z
  .number()
  .int()
  .min(0)
  .max(3)
  .transform((n) => n as 0 | 1 | 2 | 3);
const Difficulty = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const RawQuestionSchema = z.strictObject({
  type: z.enum(QUESTION_TYPES),
  stem: z.string().trim().min(10).max(600),
  options: z.tuple([Option, Option, Option, Option]),
  correctIndex: CorrectIndex,
  /** Must cite lines as L<n> or L<n>-L<m> (validator rule `explanation_citation`). */
  explanation: z.string().trim().min(20).max(1200),
  refs: z.array(RefSchema).min(1).max(5),
  difficulty: Difficulty,
});
export type RawQuestion = z.output<typeof RawQuestionSchema>;

/** Items stay `unknown` so one malformed item is reported at its index instead of failing the batch. */
export const RawBatchSchema = z.strictObject({ questions: z.array(z.unknown()).min(1) });
export type RawBatch = z.output<typeof RawBatchSchema>;

/** `QuestionPrivate` v2. Allows `refs: []` and `chunkLines: 0` for questions migrated from v1. */
export const StoredQuestionSchema: z.ZodType<QuestionPrivate> = z.strictObject({
  id: z.string().regex(/^q_[0-9a-f]{12}$/),
  chunkId: z.string(),
  chunkHash: z.string(),
  chunkLines: z.number().int().min(0),
  type: z.enum(QUESTION_TYPES),
  stem: z.string(),
  options: z.tuple([z.string(), z.string(), z.string(), z.string()]),
  correctIndex: CorrectIndex,
  explanation: z.string(),
  refs: z.array(RefSchema),
  difficulty: Difficulty,
  lang: LangCodeSchema,
  generatedBy: z.string(),
  promptVersion: z.string(),
  status: z.enum(['ok', 'stale']),
  flagged: z.boolean(),
  verifiedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const QuestionsFileV2Schema = z.strictObject({
  version: z.literal(2),
  chunkId: z.string(),
  questions: z.array(StoredQuestionSchema),
});

/** Answer of the blind verify pass (§5). */
export const VerifyAnswerSchema = z.object({
  answerIndex: z.number().int().min(0).max(3),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type VerifyAnswer = z.output<typeof VerifyAnswerSchema>;

const RAW_REF_JSON_SCHEMA = {
  type: 'object',
  properties: { start: { type: 'integer' }, end: { type: 'integer' } },
  required: ['start', 'end'],
  additionalProperties: false,
} as const;

/**
 * Provider-facing JSON Schema for `{ questions: RawQuestion[] }`. Structured-output
 * engines support only a subset of JSON Schema, so it carries no length or numeric
 * bounds; zod enforces them after the call.
 */
export const RAW_BATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...QUESTION_TYPES] },
          stem: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctIndex: { type: 'integer' },
          explanation: { type: 'string' },
          refs: { type: 'array', items: RAW_REF_JSON_SCHEMA },
          difficulty: { type: 'integer', enum: [1, 2, 3] },
        },
        required: ['type', 'stem', 'options', 'correctIndex', 'explanation', 'refs', 'difficulty'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

export const VERIFY_ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answerIndex: { type: 'integer', enum: [0, 1, 2, 3] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['answerIndex', 'confidence'],
  additionalProperties: false,
} as const;
