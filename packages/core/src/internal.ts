// Internal entry point (`gotchea-core/internal`): question stores and the private
// question shape, which carries the answer key. Not part of the public API (PLAN §6,
// §10.57). For the CLI and tests only; MCP and other interfaces must not import it.
export type { Question, QuestionPrivate, QuestionRef, QuestionsFile } from './model/question.js';
export type { QuestionStore } from './store/types.js';
export { FsQuestionStore, InMemoryQuestionStore, upgradeQuestionsFile } from './store/question-store.js';
export {
  countUsable,
  dedupeBase,
  insertQuestions,
  isStale,
  isUsable,
  markStale,
  usableQuestions,
  type InsertResult,
} from './store/question-pool.js';
export { QuestionsFileV2Schema, StoredQuestionSchema, VERIFY_ANSWER_JSON_SCHEMA, VerifyAnswerSchema, type VerifyAnswer } from './generate/schema.js';
export { validateBatch, type ValidateInput, type ValidationResult, type ValidatorConfig } from './generate/validate.js';
export { questionId, stampQuestion, type StampMeta } from './generate/stamp.js';
export { blindVerify, optionPermutation, type AnswerFn, type BlindVerifyInput, type VerifyOutcome, type VerifyRequest } from './generate/verify.js';
export { VERIFY_INSTRUCTIONS, buildVerifyPrompt, type VerifyPromptInput } from './generate/prompt.js';
export { citations, contentTokens, normalizeText, overlap, STOPWORDS } from './generate/text.js';
export { jaccard, trigrams } from './generate/dedupe.js';
export { toPrivateView, toPublicView, toRevealView, type PrivateQuestionView } from './quiz/views.js';
