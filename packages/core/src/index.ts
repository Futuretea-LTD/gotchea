// Public API surface of gotchea-core.
import { createRequire } from 'node:module';

// Read from package.json so release version bumps can't drift. `../package.json`
// is the package root from both src/index.ts and the bundled dist/index.js.
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export { now } from './now.js';

// ---- assets ----
export { grammarPath, treeSitterRuntimePath, type GrammarName } from './assets.js';

// ---- model ----
export type { Chunk, ChunkKind, ChunkMetrics, ChunksFile, LineRange, NormalizationVersion } from './model/chunk.js';
export { MAX_ALIASES } from './model/chunk.js';
export type { QuestionLang, QuestionPublic, QuestionStatus, QuestionType } from './model/question.js';
export type { ChunkColor, ChunkState, Progress, ProgressFile, ProgressHistoryEntry } from './model/progress.js';
export {
  BODY_SEGMENT,
  GROUP_PREFIX,
  ROOT_MODULE_ID,
  TOP_SEGMENT,
  baseSymbolName,
  parentDir,
  questionFileName,
  symbolChunkId,
  toPosixPath,
} from './model/ids.js';

// ---- config ----
export {
  ChunkingConfigSchema,
  ConfigSchema,
  GenerateConfigSchema,
  ProviderConfigSchema,
  QuestionsConfigSchema,
  QuizConfigSchema,
  ScoreConfigSchema,
} from './config/schema.js';
export type {
  ChunkingConfig,
  GenerateConfig,
  GotcheaConfig,
  GotcheaConfigInput,
  ProviderConfig,
  ProviderName,
  QuestionBand,
  QuestionsConfig,
  QuizConfig,
  ScoreConfig,
} from './config/schema.js';
export { ALWAYS_EXCLUDE, DEFAULT_EXCLUDE, DEFAULT_TEST_PATTERNS } from './config/defaults.js';
export { ConfigError, defaultConfig, loadConfig, mergeConfig, resolveConfig } from './config/load.js';

// ---- fs ----
export { walkFiles } from './fs/walker.js';
export type { SkipReason, SkippedFile, WalkOptions, WalkResult } from './fs/walker.js';
export { createMatcher } from './fs/filters.js';
export { findIgnoredPaths, type IgnoreCheckOptions, type IgnoredPath } from './fs/ignore-check.js';

// ---- parse ----
export type { ImportName, ImportRef, LanguageParser, OffsetRange, ParsedFile, SymbolKind, SymbolNode } from './parse/parser.js';
export { ParserRegistry, createDefaultRegistry } from './parse/registry.js';
export { createJavaScriptParser, createTsxParser, createTypeScriptParser } from './parse/lang/typescript.js';
export { createPythonParser } from './parse/lang/python.js';

// ---- hash ----
export { NORMALIZATION_VERSION, canonicalText, normalizeFileLines, normalizeSource } from './hash/normalize.js';
export { contentHash, fnv1a32, lineFingerprints, moduleHash } from './hash/hash.js';

// ---- chunking ----
export type { ChunkDraft, Chunker, FileDraft, SourceReferences, SourceUnit } from './chunk/chunker.js';
export { CodeChunker } from './chunk/code-chunker.js';
export { buildFileDraft, type DraftContext } from './chunk/grouping.js';
export { buildFanIn, resolveImport, type FanInIndex, type FileReferences } from './chunk/fanin.js';
export { buildTree, type BuildTreeOptions, type BuiltFile, type BuiltTree } from './chunk/tree-builder.js';

// ---- scan ----
export { carryAliases, computeScanDiff, type ChunkChange, type ChunkMove, type DiffFingerprints, type ScanDiff } from './scan/diff.js';
export { changeRatio, lineDiff, type LineDiffStats } from './scan/line-diff.js';
export {
  applyScanDiff,
  reconcileProgress,
  reconcileSnapshotHashes,
  type ApplyDiffInput,
  type ApplyDiffResult,
  type ReconcileChange,
  type ReconcileInput,
} from './scan/reconcile.js';
export { scanRepo, type ScanOptions, type ScanResult, type ScanStores } from './scan/scan.js';

// ---- storage ----
export type { ChunkStore, ProgressStore, SnapshotStore } from './store/types.js';
export { GOTCHEA_DIR, gotcheaHome, repoPaths, userPaths, type RepoPaths, type UserPaths } from './store/paths.js';
export { computeRepoId, detectRemoteUrl, normalizeRemoteUrl, repoIdFromString } from './store/repo-id.js';
export { readJsonFile, writeFileAtomic } from './store/atomic-write.js';
export { serializeChunksFile, stableStringify } from './store/json.js';
export type { SessionStore } from './store/types.js';
export { FsSessionStore, InMemorySessionStore } from './store/session-store.js';
export { KeyedLock } from './store/keyed-lock.js';
export {
  LockTimeoutError,
  inspectRepoLock,
  withRepoLock,
  type LockHolder,
  type RepoLockOptions,
} from './store/repo-lock.js';
export { FsChunkStore, InMemoryChunkStore } from './store/chunk-store.js';
export { FsProgressStore, InMemoryProgressStore } from './store/progress-store.js';
export { FsSnapshotStore, InMemorySnapshotStore } from './store/snapshot-store.js';
export { initConfig, saveConfig } from './store/config-store.js';

// ---- index ----
export { ChunkIndex } from './index/chunk-index.js';

// ---- score (pure) ----
export { addDays, daysUntil, elapsedDays, retrievability } from './score/retrievability.js';
export { emptyProgress, onContentChange, onSessionResult, type SessionResult } from './score/transitions.js';
export {
  aggregate,
  chunkState,
  colorFor,
  fanInFactor,
  parentState,
  passThreshold,
  questionCount,
  selectionPriority,
  type ColorFlags,
} from './score/state.js';
export { computeTreeStates, type TreeStateInput } from './score/aggregate.js';

// ---- map ----
export { buildMapTree, filterTree, matchesFilter, type MapNode } from './map/tree.js';
export { HEAT, HEAT_COLORS, ansiPaint, heatColor, renderHeatCell, type AnsiColorName } from './map/palette.js';
export { okQuestionCounts } from './map/question-counts.js';
export { loadMapTree, type LoadMapOptions, type MapSnapshot } from './map/load.js';
export {
  copyMapNode,
  mapJsonFrom,
  statusJsonFrom,
  type MapJson,
  type MapJsonOptions,
  type MapJsonResult,
  type StatusJson,
} from './map/json.js';

// ---- generate (inputs and prompts only; nothing here returns a stored question) ----
export {
  LangCodeSchema,
  QUESTION_TYPES,
  RAW_BATCH_JSON_SCHEMA,
  RawBatchSchema,
  RawQuestionSchema,
  RefSchema,
  type RawBatch,
  type RawQuestion,
} from './generate/schema.js';
export { REJECTION_REASONS, type Rejection, type RejectionReason } from './generate/validate.js';
export { RANGE_SEPARATOR, chunkLineCount, numberChunkCode, readChunkCode, toAbsoluteLine, type ChunkCode } from './generate/chunk-code.js';
export {
  MAX_TASK_LINES,
  generationCandidates,
  getGenerationTasks,
  planQuestionTypes,
  poolTarget,
  type GenerationCandidate,
  type GenerationTask,
  type GenerationTasksResult,
  type GetGenerationTasksOptions,
  type ImportSignature,
} from './generate/tasks.js';
export {
  SAVE_REJECT_REASONS,
  saveQuestions,
  type SaveInput,
  type SaveOptions,
  type SaveRejectReason,
  type SaveResult,
} from './generate/save.js';
export { SourceReader, enclosingDeclaration, importSignatures } from './generate/source.js';
export {
  GENERATION_INSTRUCTIONS,
  PROMPT_VERSION,
  RAW_QUESTION_SHAPE,
  buildGenerationPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  renderHostInstructions,
  type GenerationPrompt,
  type GenerationPromptInput,
  type PromptPair,
} from './generate/prompt.js';
export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  isConfigError,
  providerLabel,
  requestQuestionBatch,
  type JsonRequest,
  type LLMProvider,
  type ProviderErrorCode,
} from './generate/providers/provider.js';
export {
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  type AnthropicClientLike,
  type AnthropicCreateParams,
  type AnthropicMessage,
} from './generate/providers/anthropic.js';
export { OpenAIChatProvider, type FetchLike, type OpenAIChatProviderOptions, type StructuredMode } from './generate/providers/openai-chat.js';
export { OPENAI_BASE_URL, createOpenAIProvider, type OpenAIProviderOptions } from './generate/providers/openai.js';
export { createOpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from './generate/providers/openai-compatible.js';
export { API_KEY_ENV, PROVIDER_NAMES, createProvider, type CreateProvider, type CreateProviderOptions } from './generate/providers/factory.js';
export {
  GenerateError,
  runGenerate,
  type ChunkReport,
  type ChunkSkipReason,
  type GenerateErrorCode,
  type GenerateReport,
  type RunGenerateOptions,
} from './generate/generate.js';

// ---- shared operations (CLI + MCP) ----
export { isInitialized } from './ops/init-check.js';
export { runScan, summarizeScan, type RunScanOptions, type ScanSummary } from './ops/scan.js';
export { getStatus, type GetStatusOptions, type StatusReport } from './ops/status.js';

// ---- quiz ----
export {
  QuizSelectError,
  selectChunk,
  selectQuestions,
  sessionSize,
  type ChunkSelection,
  type QuizSelectErrorCode,
  type QuizTarget,
  type SelectChunkInput,
  type SelectQuestionsInput,
} from './quiz/select.js';
export {
  QuizSessions,
  SESSION_ID,
  SessionError,
  SessionSchema,
  cryptoRng,
  makePermutation,
  scoreSession,
  seededRng,
  type Answer,
  type Permutation,
  type QuizSessionsOptions,
  type Rng,
  type ScoreOutcome,
  type ScoreSessionOptions,
  type Session,
  type SessionErrorCode,
  type SessionOrigin,
  type SessionStatus,
} from './quiz/session.js';
export {
  CODE_PREVIEW_MAX_LINES,
  FORBIDDEN_KEYS,
  LABELS,
  PublicCodePreviewSchema,
  PublicQuestionViewSchema,
  RevealRefSchema,
  RevealViewSchema,
  assertPublicView,
  type PublicCodePreview,
  type PublicQuestionView,
  type RevealView,
} from './quiz/views.js';
export { sanitizeTerminalText } from './quiz/sanitize.js';
export { ensureReconciled, type EnsureReconciledOptions, type ReconcileOutcome } from './ops/reconcile.js';
export {
  abandonQuiz,
  startQuiz,
  submitAnswer,
  type QuizOpsDeps,
  type SessionHeader,
  type SessionResultView,
  type StartQuizInput,
  type StartQuizRefusal,
  type StartQuizResult,
  type SubmitAnswerInput,
  type SubmitAnswerResult,
  type SubmitRefusal,
} from './ops/quiz.js';
export { buildMiniHeatmap, renderMiniHeatmapText, type MiniHeatmap } from './map/mini-heatmap.js';
