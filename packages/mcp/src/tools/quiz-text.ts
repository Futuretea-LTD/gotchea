// All user-facing quiz text (M3_DESIGN.md §7). Everything before an answer is recorded is built from
// the public view only; the reveal text is built only from a `RevealView`.
import {
  HEAT,
  LABELS,
  renderMiniHeatmapText,
  type PublicQuestionView,
  type RevealView,
  type SessionHeader,
  type SessionResultView,
  type StartQuizResult,
  type SubmitRefusal,
} from 'gotchea-core';

/** Required in both tool descriptions: the agent must not answer for the user. */
export const ASK_USER = 'Ask the question to the user, do not guess the answer yourself.';
export const CHOICE_UI = 'If your client can show a multiple-choice or selection UI, present the options as choices there; otherwise list them as A–D and let the user reply with a letter.';

export const START_QUIZ_DESCRIPTION = `Start a comprehension quiz on one chunk of this repository. Pass \`path\` (a directory, file or symbol: the chunk that most needs review under it is picked) or \`chunkId\`; with neither, the whole repo is considered. Optional \`count\` shortens the quiz (default: the chunk's size, 3–7). Returns the first multiple-choice question. ${ASK_USER} ${CHOICE_UI} Then call \`submit_answer\` with the option the user picked. The correct answer and explanation are revealed only after you submit.`;

export const SUBMIT_ANSWER_DESCRIPTION = `Submit the user's answer to the current quiz question. \`displayIndex\` is the position of the option the user picked, as shown by \`start_quiz\` or the previous \`submit_answer\` (A=0, B=1, C=2, D=3). Answers are final and must be given in order. Returns whether it was correct, the correct option, the explanation and the line references, then the next question. ${ASK_USER} ${CHOICE_UI} After the last question this returns the result: pass/fail, the chunk's new colour and an updated mini heatmap.`;

const pct = (R: number | null): string => (R === null ? '–' : `${Math.round(R * 100)}%`);
const day = (iso: string): string => iso.slice(0, 10);

export function optionLines(q: PublicQuestionView): string {
  return q.options.map((o) => `${o.label}) ${o.text}`).join('\n');
}

export function questionBlock(q: PublicQuestionView): string {
  return `${q.stem}\n\n${optionLines(q)}`;
}

const callHint = (sessionId: string, questionId: string): string =>
  `Then call submit_answer with { "sessionId": "${sessionId}", "questionId": "${questionId}", "displayIndex": <0-3> } (A=0, B=1, C=2, D=3).`;

const where = (s: Pick<SessionHeader, 'path' | 'chunkTitle'>): string => (s.path ? `${s.path} › ${s.chunkTitle}` : s.chunkTitle);

export function startedText(status: 'started' | 'resumed', s: SessionHeader, q: PublicQuestionView): string {
  const lines = [`Quiz ${status}: ${where(s)}  (session ${s.id})`, `Question ${q.position} of ${q.total} · ${s.needed} correct to pass · expires ${s.expiresAt}`];
  if (status === 'resumed') lines.push(`Resumed an unfinished quiz: ${s.answered} of ${s.total} already answered. count and lang were ignored.`);
  lines.push(
    '',
    questionBlock(q),
    '',
    `${ASK_USER} If your client can show a multiple-choice UI, present the four options as choices there; otherwise list them and let the user reply with A, B, C or D.`,
    callHint(s.id, q.questionId),
  );
  return lines.join('\n');
}

export function formatRefs(refs: RevealView['refs']): string {
  return refs
    .map((r) => {
      const span = r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}–L${r.endLine}`;
      return `${r.path} ${r.approximate ? '≈ ' : ''}${span}`;
    })
    .join(', ');
}

export function revealText(r: RevealView): string {
  const lines = [`${r.correct ? '✅ Correct.' : '❌ Incorrect.'} You chose ${LABELS[r.selectedDisplayIndex]}.`];
  if (!r.correct) lines.push(`Correct answer: ${LABELS[r.correctDisplayIndex]}) ${r.correctText}`);
  lines.push(`Explanation: ${r.explanation}`);
  if (r.refs.length > 0) lines.push(`Look at: ${formatRefs(r.refs)}`);
  return lines.join('\n');
}

export function answeredText(sessionId: string, r: RevealView, progress: { answered: number; total: number; correct: number }, next: PublicQuestionView): string {
  return [
    revealText(r),
    '',
    `Score so far: ${progress.correct}/${progress.answered} · question ${progress.answered} of ${progress.total} done`,
    '',
    `Next — question ${next.position} of ${next.total}:`,
    '',
    questionBlock(next),
    '',
    `${ASK_USER} If your client can show a multiple-choice UI, present the four options as choices there. ${callHint(sessionId, next.questionId)}`,
  ].join('\n');
}

export function resultText(res: SessionResultView, greenAt: number): string {
  const { before, after, chunk } = res;
  const lines = [
    `Quiz complete: ${res.correct}/${res.total} correct (needed ${res.needed}) — ${res.passed ? 'PASSED' : 'NOT PASSED'}`,
    `${where({ path: chunk.path, chunkTitle: chunk.title })}: ${HEAT[before.color].emoji} → ${HEAT[after.color].emoji}  (R ${pct(before.R)} → ${pct(after.R)})${after.dueAt ? ` · green until ${day(after.dueAt)}` : ''}`,
    res.passed ? `Next review is due when retrievability falls below ${Math.round(greenAt * 100)}%.` : 'This chunk must be passed again; it stays red until then.',
    '',
    `Heatmap (${chunk.path ?? chunk.title}):`,
    renderMiniHeatmapText(res.heatmap, 'emoji'),
  ];
  return lines.join('\n');
}

export function startRefusal(r: Extract<StartQuizResult, { status: 'refused' }>, input: { path?: string | undefined; chunkId?: string | undefined; lang?: string | undefined }): string {
  const d = r.detail;
  const msg: Record<typeof r.reason, string> = {
    both_targets: 'Pass either path or chunkId, not both.',
    unknown_chunk: `No chunk with id "${input.chunkId}". Use get_map to list chunk ids.`,
    not_leaf: `"${input.chunkId}" is a container, not a leaf. Pass it as path to quiz the best chunk inside it.`,
    no_match: `No chunks match "${input.path}".`,
    no_quizzable_chunk: `No chunk under "${input.path ?? '.'}" has enough questions yet${d.have !== undefined ? ` (best candidate: ${d.have} of ${d.need})` : ''}. Generate questions first: run "gotchea generate", or use the get_generation_tasks and save_questions tools.`,
    not_enough_questions: `${d.chunkId ?? input.chunkId} has ${d.have ?? 0} usable questions and needs ${d.need ?? 'more'}. Generate more first (see get_generation_tasks).`,
    lang_invalid: `"${input.lang}" is not a valid language code.`,
    not_scanned: r.message,
  };
  return `gotchea: no quiz started (${r.reason}). ${msg[r.reason]}`;
}

export function submitRefusal(reason: SubmitRefusal, message: string, ttlMinutes: number): string {
  const msg: Record<SubmitRefusal, string> = {
    unknown_session: `${message} Start one with start_quiz.`,
    session_expired: `This quiz session expired after ${ttlMinutes} minutes without an answer. Nothing was scored. Call start_quiz again.`,
    session_completed: 'This quiz is already complete. Call start_quiz for a new one.',
    chunk_changed: `${message} Nothing was scored. Call start_quiz again.`,
    unknown_question: 'That question is not part of this session.',
    out_of_order: 'Answer the questions in order, starting with the first unanswered one.',
    already_answered: 'That question was already answered; answers are final.',
    invalid_index: 'displayIndex must be 0-3.',
    question_unavailable: 'A question of this session is no longer available. Call start_quiz again.',
  };
  return `gotchea: answer not recorded (${reason}). ${msg[reason]}`;
}
