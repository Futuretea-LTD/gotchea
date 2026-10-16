// MCP map copy only: messages receive counts and fixed hints, never question data.
const en = {
  generateQuestions: 'generate questions',
  takeQuiz: 'take a quiz',
  reviewYellow: 'review yellow chunks',
  allGreen: 'all green',
  mapSummary: (chunks: number, questions: number, next: string): string =>
    `${chunks} ${chunks === 1 ? 'chunk' : 'chunks'} · ${questions} ${questions === 1 ? 'question' : 'questions'} · next step: ${next}`,
  questionCount: (count: number): string => `${count} ${count === 1 ? 'question' : 'questions'}`,
};

type Messages = typeof en;

export const messages: Record<'en' | 'tr', Messages> = {
  en,
  tr: {
    generateQuestions: 'soru üret',
    takeQuiz: 'quiz çöz',
    reviewYellow: 'sarıları tekrar et',
    allGreen: 'hepsi yeşil',
    mapSummary: (chunks, questions, next) => `${chunks} chunk · ${questions} soru · sonraki adım: ${next}`,
    questionCount: (count) => `${count} soru`,
  },
};

/** Other question languages use English tool copy; Turkish also accepts its regional code. */
export function messagesFor(lang?: string): Messages {
  return lang?.toLowerCase() === 'tr' || lang?.toLowerCase() === 'tr-tr' ? messages.tr : messages.en;
}
