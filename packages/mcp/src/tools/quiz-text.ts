// All user-facing quiz text (M3_DESIGN.md §7). Everything before an answer is recorded is built from
// the public view only; the reveal text is built only from a `RevealView`. Question text and chunk
// names come from hand-editable files and end up in agent context and on the client's screen, so
// they are sanitized here, like in the CLI; structuredContent keeps them as stored.
import {
  HEAT,
  LABELS,
  renderMiniHeatmapText,
  sanitizeTerminalText,
  type PublicQuestionView,
  type RevealView,
  type SessionHeader,
  type SessionResultView,
  type StartQuizResult,
  type SubmitRefusal,
} from 'gotchea-core';
import { type Messages, messagesFor } from '../i18n.js';

/** Required in both tool descriptions: the agent must not answer for the user. */
export const ASK_USER = 'Ask the question to the user, do not guess the answer yourself.';
export const RELAY_START = '<<<SHOW TO USER VERBATIM';
export const RELAY_END = 'SHOW TO USER VERBATIM>>>';
export const RELAY_VERBATIM = `Show the user everything between the markers verbatim, exactly as written: the code block with its header, the question and all four options in full. Do not shorten, paraphrase or drop any of it. ${ASK_USER} If you also offer a multiple-choice selection UI, label its choices only "A", "B", "C", "D" (the full text is already in your message).`;
export const ELICIT_TITLE_MAX = 60;

/** Short widget titles are navigation; the full options remain in the prompt. */
export function clip(text: string, max = ELICIT_TITLE_MAX): string {
  const points = Array.from(sanitizeTerminalText(text).replace(/\s+/gu, ' ').trim());
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('');
}

export const START_QUIZ_DESCRIPTION = `Start a comprehension quiz on one chunk of this repository. Pass \`path\` (a directory, file or symbol: the chunk that most needs review under it is picked) or \`chunkId\`; with neither, the whole repo is considered. Optional \`count\` shortens the quiz (default: the chunk's size, 3–7). Returns the first multiple-choice question with the code it is about, between verbatim relay markers. ${RELAY_VERBATIM} Then call \`submit_answer\` with the option the user picked. The correct answer and explanation are revealed only after you submit.`;

export const SUBMIT_ANSWER_DESCRIPTION = `Submit the user's answer to the current quiz question. \`displayIndex\` is the position of the option the user picked, as shown by \`start_quiz\` or the previous \`submit_answer\` (A=0, B=1, C=2, D=3). Answers are final and must be given in order. Returns whether it was correct, the correct option, the explanation and the line references, then the next question with its code, between verbatim relay markers. ${RELAY_VERBATIM} After the last question this returns the result: pass/fail, the chunk's new colour and an updated mini heatmap.`;

const pct = (R: number | null): string => (R === null ? '–' : `${Math.round(R * 100)}%`);
const day = (iso: string): string => iso.slice(0, 10);

export function optionLines(q: PublicQuestionView): string {
  return q.options.map((o) => `${o.label}) ${sanitizeTerminalText(o.text)}`).join('\n');
}

/** A fence longer than any backtick run in the source, so the snippet can't close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The question's code preview as a fenced block under a header; empty when the view has none. */
export function codeBlock(code: PublicQuestionView['code'], messages: Messages): string {
  if (!code) return '';
  const fence = fenceFor(code.text);
  // The info string is one word; anything else from chunks.json is dropped rather than echoed.
  const info = /^[\w+#.-]+$/.test(code.language) ? code.language : '';
  return `${messages.codeHeader(code.path, code.startLine, code.endLine, code.truncated === true)}\n${fence}${info}\n${code.text}\n${fence}`;
}

/** Code first, then the stem and options: the question is read against the code above it. */
export function questionBlock(q: PublicQuestionView, messages: Messages = messagesFor()): string {
  const code = codeBlock(q.code, messages);
  return `${code ? `${code}\n\n` : ''}${sanitizeTerminalText(q.stem)}\n\n${optionLines(q)}`;
}

/** Escape relay delimiters in hand-editable content so only our outer markers delimit it. */
export function relayBlock(q: PublicQuestionView, messages: Messages = messagesFor()): string {
  const body = questionBlock(q, messages).replaceAll('<<<', '‹‹‹').replaceAll('>>>', '›››');
  return `${RELAY_START}\n${body}\n${RELAY_END}`;
}

/** Form messages render as plain text in clients, so use numbered lines instead of Markdown. */
export function elicitCodeLines(code: PublicQuestionView['code'], messages: Messages): string {
  if (!code) return '';
  const width = String(code.endLine).length;
  const lines = code.text.split('\n').map((line, i) => `${String(code.startLine + i).padStart(width)} │ ${line}`);
  return [messages.codeHeader(code.path, code.startLine, code.endLine, code.truncated === true), ...lines].join('\n');
}

const callHint = (sessionId: string, questionId: string): string =>
  `Then call submit_answer with { "sessionId": "${sessionId}", "questionId": "${questionId}", "displayIndex": <0-3> } (A=0, B=1, C=2, D=3).`;

const where = (s: Pick<SessionHeader, 'path' | 'chunkTitle'>): string => sanitizeTerminalText(s.path ? `${s.path} › ${s.chunkTitle}` : s.chunkTitle);

export function startedText(status: 'started' | 'resumed', s: SessionHeader, q: PublicQuestionView, messages: Messages = messagesFor()): string {
  const lines = [`Quiz ${status}: ${where(s)}  (session ${s.id})`, `Question ${q.position} of ${q.total} · ${s.needed} correct to pass · expires ${s.expiresAt}`];
  if (status === 'resumed') lines.push(`Resumed an unfinished quiz: ${s.answered} of ${s.total} already answered. count and lang were ignored.`);
  lines.push(
    '',
    relayBlock(q, messages),
    '',
    RELAY_VERBATIM,
    callHint(s.id, q.questionId),
  );
  return lines.join('\n');
}

export function formatRefs(refs: RevealView['refs']): string {
  return refs
    .map((r) => {
      const span = r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}–L${r.endLine}`;
      return `${sanitizeTerminalText(r.path)} ${r.approximate ? '≈ ' : ''}${span}`;
    })
    .join(', ');
}

export function revealText(r: RevealView): string {
  const lines = [`${r.correct ? '✅ Correct.' : '❌ Incorrect.'} You chose ${LABELS[r.selectedDisplayIndex]}.`];
  if (!r.correct) lines.push(`Correct answer: ${LABELS[r.correctDisplayIndex]}) ${sanitizeTerminalText(r.correctText)}`);
  lines.push(`Explanation: ${sanitizeTerminalText(r.explanation)}`);
  if (r.refs.length > 0) lines.push(`Look at: ${formatRefs(r.refs)}`);
  return lines.join('\n');
}

export function answeredText(
  sessionId: string,
  r: RevealView,
  progress: { answered: number; total: number; correct: number },
  next: PublicQuestionView,
  messages: Messages = messagesFor(),
): string {
  return [
    revealText(r),
    '',
    `Score so far: ${progress.correct}/${progress.answered} · question ${progress.answered} of ${progress.total} done`,
    '',
    `Next — question ${next.position} of ${next.total}:`,
    '',
    relayBlock(next, messages),
    '',
    `${RELAY_VERBATIM} ${callHint(sessionId, next.questionId)}`,
  ].join('\n');
}

export function resultText(res: SessionResultView, greenAt: number): string {
  const { before, after, chunk } = res;
  const lines = [
    `Quiz complete: ${res.correct}/${res.total} correct (needed ${res.needed}) — ${res.passed ? 'PASSED' : 'NOT PASSED'}`,
    `${where({ path: chunk.path, chunkTitle: chunk.title })}: ${HEAT[before.color].emoji} → ${HEAT[after.color].emoji}  (R ${pct(before.R)} → ${pct(after.R)})${after.dueAt ? ` · green until ${day(after.dueAt)}` : ''}`,
    res.passed ? `Next review is due when retrievability falls below ${Math.round(greenAt * 100)}%.` : 'This chunk must be passed again; it stays red until then.',
    '',
    `Heatmap (${sanitizeTerminalText(chunk.path ?? chunk.title)}):`,
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
