// Text helpers shared by the validator and dedupe (M2_DESIGN.md §4).
import type { QuestionRef } from '../model/question.js';

/** NFKC → lowercase → strip quotes/backticks → collapse whitespace → trim → strip trailing `.,;:!?`. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .trimEnd();
}

const STOPWORD_LIST = [
  // en
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'may', 'me', 'might', 'more', 'most', 'must', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will',
  'with', 'would', 'you', 'your',
  // tr
  'acaba', 'ama', 'ancak', 'bazı', 'belki', 'ben', 'bir', 'biri', 'birkaç', 'bu', 'bunu', 'buna', 'bunun', 'çok',
  'çünkü', 'da', 'daha', 'de', 'diye', 'en', 'gibi', 'hangi', 'hem', 'hep', 'her', 'için', 'ile', 'ise', 'kadar',
  'ki', 'mi', 'mı', 'mu', 'mü', 'nasıl', 'ne', 'neden', 'nerede', 'o', 'olan', 'olarak', 'oldu', 'olur', 'ona',
  'onu', 'onun', 'sonra', 'şu', 'şey', 'tüm', 've', 'veya', 'ya', 'yani', 'zaten',
];

export const STOPWORDS: ReadonlySet<string> = new Set(STOPWORD_LIST);

/** Content tokens of the normalised text: words/identifiers minus stopwords. Identifiers of any length are kept. */
export function contentTokens(s: string): string[] {
  return (normalizeText(s).match(/[\p{L}\p{N}_$]+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

/** Share of `option`'s distinct content tokens that also appear in `stem`; 0 when it has none. */
export function overlap(option: string, stem: string): number {
  const o = new Set(contentTokens(option));
  if (o.size === 0) return 0;
  const s = new Set(contentTokens(stem));
  let shared = 0;
  for (const t of o) if (s.has(t)) shared++;
  return shared / o.size;
}

/** Line citations `L<n>` / `L<n>-L<m>` (also `L<n>-<m>`, en dash) in an explanation. */
export function citations(explanation: string): QuestionRef[] {
  const out: QuestionRef[] = [];
  for (const m of explanation.matchAll(/\bL(\d+)(?:\s*[-–]\s*L?(\d+))?\b/g)) {
    const start = Number(m[1]);
    out.push({ start, end: m[2] === undefined ? start : Number(m[2]) });
  }
  return out;
}
