// Zod schemas for every tool input and output. Outputs are strict: a key that is
// not listed here (e.g. a question's correctIndex or explanation) fails validation
// before anything is sent to the client.
import { PublicQuestionViewSchema, QUESTION_TYPES, REJECTION_REASONS, RevealViewSchema, SAVE_REJECT_REASONS } from 'gotchea-core';
import { z } from 'zod';

const ChunkKindSchema = z.enum(['module', 'file', 'group', 'symbol']);
const ColorSchema = z.enum(['grey', 'red', 'yellow', 'green']);
const LinesSchema = z.strictObject({ start: z.number().int(), end: z.number().int() });

// ---- inputs ----

export const ScanInputSchema = z.strictObject({});

export const GetMapInputSchema = z.strictObject({
  path: z.string().optional().describe('Only this directory, file or chunk id, relative to the repo root'),
  depth: z.number().int().min(0).optional().describe('Levels below the (filtered) root to include; unlimited when omitted'),
});

export const GetChunkForFileInputSchema = z.strictObject({
  path: z.string().min(1).describe('File path relative to the repo root'),
  line: z.number().int().min(1).optional().describe('1-based line; the innermost chunk containing it is returned'),
});

export const GetStatusInputSchema = z.strictObject({});

const LangInput = z.string().optional().describe('Question language code such as en, tr or pt-BR; defaults to config questions.lang');

export const GetGenerationTasksInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(10).optional().describe('Most tasks to return (1-10, default 3)'),
  lang: LangInput,
});

export const SaveQuestionsInputSchema = z.strictObject({
  chunkId: z.string().min(1).describe('chunkId of the generation task'),
  chunkHash: z.string().min(1).describe('chunkHash of the generation task; a mismatch means the code changed and the whole call is refused'),
  lang: LangInput,
  // Loose on purpose: one malformed item is reported as schema_invalid at its index instead of failing the call.
  questions: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(20)
    .describe(
      'Raw questions: { type, stem, options: [4 strings], correctIndex: 0-3, explanation (cites L<n>), refs: [{start, end}], difficulty: 1-3 }. Line numbers are chunk-relative, as in the task code.',
    ),
});

// ---- outputs ----

export interface MapNodeOut {
  id: string;
  kind: z.infer<typeof ChunkKindSchema>;
  title: string;
  path: string | null;
  lines: { start: number; end: number } | null;
  loc: number;
  complexity: number;
  fanIn: number;
  isLeaf: boolean;
  questionCount: number;
  okQuestions: number;
  state: { color: z.infer<typeof ColorSchema>; R: number | null; dueAt: string | null };
  children: MapNodeOut[];
}

export const MapNodeSchema: z.ZodType<MapNodeOut> = z.strictObject({
  id: z.string(),
  kind: ChunkKindSchema,
  title: z.string(),
  path: z.string().nullable(),
  lines: LinesSchema.nullable(),
  loc: z.number(),
  complexity: z.number(),
  fanIn: z.number(),
  isLeaf: z.boolean(),
  questionCount: z.number(),
  okQuestions: z.number(),
  state: z.strictObject({ color: ColorSchema, R: z.number().nullable(), dueAt: z.string().nullable() }),
  children: z.lazy(() => z.array(MapNodeSchema)),
});

/** Set on every output so clients can tell "run gotchea init / scan" from real data. */
const ReadinessShape = {
  initialized: z.boolean(),
  scanned: z.boolean(),
};

export const ScanOutputSchema = z.strictObject({
  ...ReadinessShape,
  summary: z
    .strictObject({
      added: z.number(),
      changed: z.number(),
      moved: z.number(),
      removed: z.number(),
      total: z.number(),
    })
    .nullable(),
});

export const GetMapOutputSchema = z.strictObject({
  ...ReadinessShape,
  filter: z.string().nullable(),
  depth: z.number().nullable(),
  root: MapNodeSchema.nullable(),
});

const ChunkInfoSchema = z.strictObject({
  id: z.string(),
  kind: ChunkKindSchema,
  title: z.string(),
  parentId: z.string().nullable(),
  ranges: z.array(z.strictObject({ path: z.string(), start: z.number().int(), end: z.number().int() })),
  loc: z.number(),
  complexity: z.number(),
  fanIn: z.number(),
  isLeaf: z.boolean(),
  questionCount: z.number(),
});

export const GetChunkForFileOutputSchema = z.strictObject({
  ...ReadinessShape,
  /** The match first; for a file lookup without `line`, followed by the file's leaf chunks. */
  chunks: z.array(ChunkInfoSchema),
});

export const GetStatusOutputSchema = z.strictObject({
  ...ReadinessShape,
  chunks: z.number(),
  leaves: z.number(),
  questions: z.number(),
  due: z.number(),
  colors: z.strictObject({ grey: z.number(), red: z.number(), yellow: z.number(), green: z.number() }),
});

const QuestionTypeSchema = z.enum(QUESTION_TYPES);

const GenerationTaskSchema = z.strictObject({
  chunkId: z.string(),
  chunkHash: z.string(),
  path: z.string(),
  title: z.string(),
  sourceLang: z.string().nullable(),
  lineCount: z.number().int(),
  /** Numbered code, chunk-relative from line 1. */
  code: z.string(),
  context: z.strictObject({
    imports: z.array(z.strictObject({ from: z.string(), name: z.string(), signature: z.string() })),
    enclosing: z.string().nullable(),
  }),
  /** Stems of the chunk's usable questions only (PLAN §6). */
  existingStems: z.array(z.string()),
  count: z.number().int(),
  typePlan: z.array(QuestionTypeSchema),
  questionLang: z.string(),
  /** Generation rules plus the JSON shape of one question and the save_questions call. */
  instructions: z.string(),
});

export const GetGenerationTasksOutputSchema = z.strictObject({
  ...ReadinessShape,
  tasks: z.array(GenerationTaskSchema),
  remaining: z.number().int(),
  /** Candidates skipped because their file was edited after the last scan. */
  changedSinceScan: z.array(z.string()),
});

const SaveRejectReasonSchema = z.enum(SAVE_REJECT_REASONS);

const RejectionReasonSchema = z.enum(REJECTION_REASONS);

/** Indices, ids, reason codes and fixed-template details only: never a stem, option, key or explanation. */
export const SaveQuestionsOutputSchema = z.strictObject({
  ...ReadinessShape,
  /** 'rejected' = the whole call was refused and nothing was saved. */
  status: z.enum(['saved', 'rejected']).nullable(),
  reason: SaveRejectReasonSchema.nullable(),
  chunkId: z.string().nullable(),
  savedCount: z.number().int(),
  accepted: z.array(z.strictObject({ index: z.number().int(), id: z.string() })),
  rejected: z.array(z.strictObject({ index: z.number().int(), reason: RejectionReasonSchema, detail: z.string() })),
  usableQuestions: z.number().int().nullable(),
  target: z.number().int().nullable(),
});

export type GenerationTaskOut = z.infer<typeof GenerationTaskSchema>;
export type SaveQuestionsOut = z.infer<typeof SaveQuestionsOutputSchema>;
export type ChunkInfo = z.infer<typeof ChunkInfoSchema>;

// ---- quiz ----

export const StartQuizInputSchema = z.strictObject({
  path: z.string().optional().describe('Directory, file or chunk-id prefix, relative to the repo root'),
  chunkId: z.string().optional().describe('Exact leaf chunk id (aliases accepted)'),
  count: z.number().int().min(1).max(10).optional().describe('Questions in this quiz; clamped to [quiz.minQuestions, the chunk size]'),
  lang: LangInput,
  includeCode: z
    .boolean()
    .optional()
    .describe(
      "Attach the chunk's source to each question (default: the config value quiz.showCode, true unless set; a resumed session keeps its own). The preview is the working-tree source, so the quiz is open book.",
    ),
});

export const SubmitAnswerInputSchema = z.strictObject({
  sessionId: z.string().regex(/^qs_[0-9a-f]{16}$/).describe('Session id from start_quiz'),
  questionId: z.string().describe('questionId of the question being answered'),
  displayIndex: z.number().int().min(0).max(3).describe('Position of the option the user picked, as displayed: A=0, B=1, C=2, D=3'),
  includeCode: z
    .boolean()
    .optional()
    .describe(
      "Attach the chunk's source to the next question (default: the session's value, set by start_quiz from includeCode or quiz.showCode, default true). The preview is the working-tree source, so the quiz is open book.",
    ),
});

const SessionHeaderSchema = z.strictObject({
  id: z.string(),
  chunkId: z.string(),
  chunkTitle: z.string(),
  path: z.string().nullable(),
  total: z.number().int(),
  answered: z.number().int(),
  needed: z.number().int(),
  expiresAt: z.string(),
});

const HeatCellShape = { id: z.string(), title: z.string(), color: ColorSchema, R: z.number().nullable() };

const MiniHeatmapSchema = z.strictObject({
  focus: z.strictObject({ ...HeatCellShape, path: z.string().nullable() }),
  fileLeaves: z.array(z.strictObject({ ...HeatCellShape, isFocus: z.boolean() })),
  omitted: z.number().int(),
  ancestors: z.array(z.strictObject({ ...HeatCellShape, kind: ChunkKindSchema })),
});

/** Only present after the last answer was recorded and scored. */
export const SessionResultViewSchema = z.strictObject({
  passed: z.boolean(),
  correct: z.number().int(),
  total: z.number().int(),
  needed: z.number().int(),
  chunk: z.strictObject({ id: z.string(), title: z.string(), path: z.string().nullable() }),
  before: z.strictObject({ color: ColorSchema, R: z.number().nullable() }),
  after: z.strictObject({ color: ColorSchema, R: z.number().nullable(), dueAt: z.string().nullable() }),
  stabilityDays: z.number().nullable(),
  heatmap: MiniHeatmapSchema,
});

export const START_QUIZ_REASONS = ['both_targets', 'unknown_chunk', 'not_leaf', 'no_match', 'no_quizzable_chunk', 'not_enough_questions', 'lang_invalid'] as const;

/**
 * Before submit, `question` is the strict public view: stem, display-indexed options and, when the working tree
 * still matches the scanned chunk, a strict `code` preview (path, lines, language, source text), nothing else.
 * `result` is set only when an elicitation-driven quiz ran to the end inside this call; the reveals of those
 * answers are in the text only, so this schema can never carry an explanation or a key.
 */
export const StartQuizOutputSchema = z.strictObject({
  ...ReadinessShape,
  status: z.enum(['started', 'resumed', 'completed', 'cancelled', 'refused']).nullable(),
  reason: z.enum(START_QUIZ_REASONS).nullable(),
  session: SessionHeaderSchema.nullable(),
  question: PublicQuestionViewSchema.nullable(),
  result: SessionResultViewSchema.nullable(),
});

export const SUBMIT_ANSWER_REASONS = [
  'unknown_session',
  'session_expired',
  'session_completed',
  'chunk_changed',
  'unknown_question',
  'out_of_order',
  'already_answered',
  'invalid_index',
  'question_unavailable',
] as const;

export const SubmitAnswerOutputSchema = z.strictObject({
  ...ReadinessShape,
  status: z.enum(['answered', 'completed', 'refused']).nullable(),
  reason: z.enum(SUBMIT_ANSWER_REASONS).nullable(),
  repeat: z.boolean(),
  sessionId: z.string().nullable(),
  /** The question just answered: the only place the explanation, line references and key may appear. */
  reveal: RevealViewSchema.nullable(),
  progress: z.strictObject({ answered: z.number().int(), total: z.number().int(), correct: z.number().int() }).nullable(),
  next: PublicQuestionViewSchema.nullable(),
  result: SessionResultViewSchema.nullable(),
});

export type StartQuizOut = z.infer<typeof StartQuizOutputSchema>;
export type SubmitAnswerOut = z.infer<typeof SubmitAnswerOutputSchema>;
