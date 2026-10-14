// Question model (PLAN.md §3, §6; M2_DESIGN.md §2). `QuestionPrivate` carries the
// answer key and never leaves core; interfaces only ever see `QuestionPublic`.

export type QuestionType = 'behavior' | 'edge_case' | 'purpose' | 'impact' | 'bug_detection';
/** Language code such as `en`, `tr`, `pt-BR` (validated by `LangCodeSchema`). */
export type QuestionLang = string;
export type QuestionStatus = 'ok' | 'stale';

/**
 * 1-based, inclusive line range inside the chunk's numbered code (chunk-relative,
 * M2_DESIGN.md §2.3). Never rebased: absolute lines are computed at display time.
 */
export interface QuestionRef {
  start: number;
  end: number;
}

export interface QuestionPrivate {
  id: string;
  chunkId: string;
  /** Chunk contentHash the question was generated against. */
  chunkHash: string;
  /** Raw line count of the numbered code at generation time (ref drift detection); 0 = unknown. */
  chunkLines: number;
  type: QuestionType;
  stem: string;
  options: [string, string, string, string];
  correctIndex: 0 | 1 | 2 | 3;
  explanation: string;
  /** Chunk-relative; empty only for questions migrated from v1. */
  refs: QuestionRef[];
  difficulty: 1 | 2 | 3;
  lang: QuestionLang;
  /** 'host:<client>' | 'anthropic:<model>' | ... */
  generatedBy: string;
  promptVersion: string;
  status: QuestionStatus;
  /** Blind verify disagreed with the key: kept for review, never quizzed. */
  flagged: boolean;
  /** '<provider>:<model>' when blind verify ran, else null. */
  verifiedBy: string | null;
  createdAt: string;
}

/** What interfaces receive: no answer, no explanation, no refs. */
export interface QuestionPublic {
  id: string;
  type: QuestionType;
  stem: string;
  options: [string, string, string, string];
  difficulty: 1 | 2 | 3;
  lang: QuestionLang;
}

/** On-disk shape of `.gotchea/questions/<slug>--<sha1>.json`. */
export interface QuestionsFile {
  version: 2;
  chunkId: string;
  questions: QuestionPrivate[];
}

/** Alias kept because the task brief names the type `Question`. */
export type Question = QuestionPrivate;
