// `gotchea quiz [path|chunkId]`: answer a quiz in the terminal. A thin renderer over core's
// `startQuiz` / `submitAnswer`; answers come from an `AnswerSource` so tests need no TTY.
// An interrupted quiz is a session file on disk (origin 'cli'), resumable on the next run.
import {
  FsSessionStore,
  LangCodeSchema,
  QuizSessions,
  abandonQuiz,
  computeRepoId,
  loadConfig,
  startQuiz,
  submitAnswer,
  type QuizOpsDeps,
  type Rng,
  type StartQuizResult,
} from 'gotchea-core';
import { CliError, requireRepoRoot, type CommandContext } from '../context.js';
import type { AnswerSource } from '../quiz/answer-source.js';
import { ClackAnswerSource, isInteractive } from '../quiz/clack-source.js';
import { questionHeader, resultLines, revealLines } from '../render/quiz.js';
import { toFilter } from '../target.js';
import { generateCommand, type GenerateDeps } from './generate.js';

export interface QuizOptions {
  count?: string;
  lang?: string;
  /** commander: `--new` → true. Don't resume an unfinished CLI quiz. */
  new?: boolean;
}

export interface QuizDeps extends GenerateDeps {
  answerSource?: AnswerSource;
  rng?: Rng;
}

const REFUSAL_HINT: Record<string, string> = {
  not_scanned: 'Run `gotchea scan` first.',
  no_match: 'Check the path with `gotchea map`.',
  unknown_chunk: 'Check the id with `gotchea map --json`.',
  not_leaf: 'Pass it as a path instead to quiz the best chunk inside it.',
  no_quizzable_chunk: 'Generate questions first with `gotchea generate`.',
  not_enough_questions: 'Generate more questions first with `gotchea generate`.',
};

export async function quizCommand(ctx: CommandContext, target: string | undefined, opts: QuizOptions, deps: QuizDeps = {}): Promise<void> {
  const count = opts.count === undefined ? undefined : parseCount(opts.count);
  if (opts.lang !== undefined && !LangCodeSchema.safeParse(opts.lang).success) throw new CliError(`--lang: expected a language code such as en, tr or pt-BR, got "${opts.lang}"`, 2);
  const source = deps.answerSource ?? (isInteractive() ? new ClackAnswerSource() : null);
  if (!source) throw new CliError('quiz needs an interactive terminal.', 2);

  const root = await requireRepoRoot(ctx.dir);
  const config = await loadConfig(root);
  const env = ctx.io.env;
  const sessions = QuizSessions.fromConfig(new FsSessionStore(await computeRepoId(root), env), config.quiz, { now: ctx.io.now, ...(deps.rng ? { rng: deps.rng } : {}) });
  const quizDeps: QuizOpsDeps = { sessions, origin: 'cli', config, env, now: ctx.io.now, ...(deps.rng ? { rng: deps.rng } : {}) };
  const rest = { ...(count !== undefined ? { count } : {}), ...(opts.lang !== undefined ? { lang: opts.lang } : {}) };
  const filter = target === undefined ? undefined : (await toFilter(target, ctx.dir, root)) || '.';

  // A leaf chunk id (or alias; contains `#`) selects that chunk; anything else is a path, like `map [path]`.
  const startTarget = async (): Promise<StartQuizResult> => {
    if (filter?.includes('#')) {
      const byId = await startQuiz(root, { chunkId: filter, ...rest }, quizDeps);
      if (byId.status !== 'refused' || (byId.reason !== 'unknown_chunk' && byId.reason !== 'not_leaf')) return byId;
    }
    return startQuiz(root, filter === undefined ? rest : { path: filter, ...rest }, quizDeps);
  };

  const start = async (): Promise<StartQuizResult> => {
    let first = await startTarget();
    if (first.status === 'resumed') {
      const s = first.session;
      const keep = !opts.new && (await source.confirm(`Resume your unfinished quiz on ${s.chunkTitle}? (${s.answered}/${s.total} answered)`));
      if (!keep) {
        await abandonQuiz(s.id, quizDeps);
        first = await startTarget();
      }
    }
    return first;
  };

  let res = await start();
  // Not enough questions: offer to generate them, once.
  if (res.status === 'refused' && (res.reason === 'no_quizzable_chunk' || res.reason === 'not_enough_questions') && res.detail.chunkId) {
    const { have, need, chunkId } = res.detail;
    if (await source.confirm(`"${chunkId}" has ${have ?? 0} of ${need ?? '?'} questions. Generate now?`)) {
      await generateCommand(ctx, { chunk: chunkId, ...(opts.lang ? { lang: opts.lang } : {}) }, deps);
      res = await start();
    }
  }
  if (res.status === 'refused') {
    throw new CliError(`no quiz started (${res.reason}): ${res.message}${REFUSAL_HINT[res.reason] ? `\n${REFUSAL_HINT[res.reason]}` : ''}`);
  }

  const { session } = res;
  ctx.out(ctx.pc.bold(`${res.status === 'resumed' ? 'Resumed' : 'Quiz'}: ${session.path ? `${session.path} › ` : ''}${session.chunkTitle}`) + ctx.pc.dim(`  (${session.needed} of ${session.total} correct to pass)`));
  let question = res.question;
  for (;;) {
    ctx.out();
    ctx.out(questionHeader(ctx.pc, question));
    const choice = await source.ask(question);
    if (choice.kind === 'quit') {
      await abandonQuiz(session.id, quizDeps);
      ctx.out('Quiz abandoned, nothing was scored.');
      return;
    }
    const sub = await submitAnswer(root, { sessionId: session.id, questionId: question.questionId, displayIndex: choice.displayIndex }, quizDeps);
    if (sub.status === 'refused') throw new CliError(`answer not recorded (${sub.reason}): ${sub.message}`);
    for (const line of revealLines(ctx.pc, sub.reveal)) ctx.out(line);
    if (sub.status === 'completed') {
      for (const line of resultLines(ctx.pc, sub.result, config.score)) ctx.out(line);
      return;
    }
    question = sub.next;
  }
}

function parseCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new CliError(`--count: expected an integer from 1 to 10, got "${raw}"`, 2);
  return n;
}
