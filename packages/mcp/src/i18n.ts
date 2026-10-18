// MCP map and code-preview copy only: messages receive counts, paths and fixed hints, never question data.
const span = (start: number, end: number): string => `${start}-${end}`;

const en = {
  generateQuestions: 'generate questions',
  takeQuiz: 'take a quiz',
  reviewYellow: 'review yellow chunks',
  allGreen: 'all green',
  mapSummary: (chunks: number, questions: number, next: string): string =>
    `${chunks} ${chunks === 1 ? 'chunk' : 'chunks'} · ${questions} ${questions === 1 ? 'question' : 'questions'} · next step: ${next}`,
  questionCount: (count: number): string => `${count} ${count === 1 ? 'question' : 'questions'}`,
  codeHeader: (path: string, start: number, end: number, truncated: boolean): string =>
    `Code: ${path}:${span(start, end)}${truncated ? ' (truncated)' : ''}`,
};

export type Messages = typeof en;

export const messages: Record<'en' | 'tr', Messages> = {
  en,
  tr: {
    generateQuestions: 'soru üret',
    takeQuiz: 'quiz çöz',
    reviewYellow: 'sarıları tekrar et',
    allGreen: 'hepsi yeşil',
    mapSummary: (chunks, questions, next) => `${chunks} chunk · ${questions} soru · sonraki adım: ${next}`,
    questionCount: (count) => `${count} soru`,
    codeHeader: (path, start, end, truncated) => `Kod: ${path}:${span(start, end)}${truncated ? ' (kısaltıldı)' : ''}`,
  },
};

/** Other question languages use English tool copy; Turkish also accepts its regional code. */
export function messagesFor(lang?: string): Messages {
  return lang?.toLowerCase() === 'tr' || lang?.toLowerCase() === 'tr-tr' ? messages.tr : messages.en;
}
