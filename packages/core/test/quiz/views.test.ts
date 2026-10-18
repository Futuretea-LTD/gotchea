// Code previews on the public question view: strict shape, truncation, and a key-only
// forbidden scan, so source that mentions `explanation` passes while a smuggled key does not.
import { describe, expect, it } from 'vitest';
import {
  CODE_PREVIEW_MAX_LINES,
  FORBIDDEN_KEYS,
  type PublicCodePreview,
  PublicCodePreviewSchema,
  PublicQuestionViewSchema,
  assertPublicView,
  codePreview,
  toPublicView,
} from '../../src/quiz/views.js';

const question = { id: 'q_000000000001', stem: 'What does clamp return for n > hi?', options: ['a', 'b', 'c', 'd'] as [string, string, string, string] };
const perm: [number, number, number, number] = [0, 1, 2, 3];
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const preview: PublicCodePreview = { path: 'src/math.ts', startLine: 3, endLine: 5, language: 'typescript', text: 'a\nb\nc' };

describe('code preview', () => {
  it('rides on the public view and passes the strict parse and the key scan', () => {
    const v = toPublicView(question, perm, 1, 3, preview);
    expect(v.code).toEqual(preview);
    expect(Object.keys(v.code!)).not.toContain('truncated');
    expect(assertPublicView(v)).toEqual(v);
    expect(PublicCodePreviewSchema.parse(preview)).toEqual(preview);
  });

  it('is absent when no preview is passed', () => {
    expect(toPublicView(question, perm, 1, 3)).not.toHaveProperty('code');
    expect(toPublicView(question, perm, 1, 3, null)).not.toHaveProperty('code');
  });

  it('copies only the preview fields', () => {
    const smuggled = { ...preview, explanation: 'leak', correctIndex: 1 } as PublicCodePreview;
    const v = toPublicView(question, perm, 1, 3, smuggled);
    expect(Object.keys(v.code!).sort()).toEqual(['endLine', 'language', 'path', 'startLine', 'text']);
    expect(assertPublicView(v)).toEqual(v);
  });

  it('strict schema rejects extra keys inside code', () => {
    const v = toPublicView(question, perm, 1, 3, preview);
    expect(() => PublicQuestionViewSchema.parse({ ...v, code: { ...preview, extra: 1 } })).toThrow();
    expect(() => PublicCodePreviewSchema.parse({ ...preview, source: 'x' })).toThrow();
  });

  it('rejects inconsistent line spans', () => {
    expect(() => PublicCodePreviewSchema.parse({ ...preview, startLine: 0, endLine: 2 })).toThrow();
    expect(() => PublicCodePreviewSchema.parse({ ...preview, startLine: 5, endLine: 4 })).toThrow();
    expect(() => PublicCodePreviewSchema.parse({ ...preview, endLine: 6 })).toThrow();
    expect(() => PublicCodePreviewSchema.parse({ ...preview, truncated: false })).toThrow();
    const long = codePreview('a.ts', 1, 'typescript', lines(CODE_PREVIEW_MAX_LINES))!;
    expect(() => PublicCodePreviewSchema.parse({ ...long, endLine: long.endLine + 1, text: `${long.text}\nx` })).toThrow();
  });

  it('keeps exactly 60 lines untruncated and cuts 61 to 60', () => {
    expect(CODE_PREVIEW_MAX_LINES).toBe(60);
    const exact = codePreview('a.ts', 10, 'typescript', lines(60))!;
    expect(exact).toEqual({ path: 'a.ts', startLine: 10, endLine: 69, language: 'typescript', text: lines(60).join('\n') });
    expect(exact).not.toHaveProperty('truncated');
    const over = codePreview('a.ts', 10, 'typescript', lines(61))!;
    expect(over).toEqual({ path: 'a.ts', startLine: 10, endLine: 69, language: 'typescript', text: lines(60).join('\n'), truncated: true });
    expect(assertPublicView(toPublicView(question, perm, 1, 1, over)).code).toEqual(over);
  });

  it('builds a one-line preview and refuses an empty or bad slice', () => {
    expect(codePreview('a.ts', 7, 'python', [''])).toEqual({ path: 'a.ts', startLine: 7, endLine: 7, language: 'python', text: '' });
    expect(codePreview('a.ts', 1, 'python', [])).toBeNull();
    expect(codePreview('a.ts', 0, 'python', ['x'])).toBeNull();
  });

  it('passes when the snippet text contains forbidden key names', () => {
    const text = ['const correctIndex = 1;', 'const explanation = "refs";', 'return { answer, key, correctDisplayIndex };'].join('\n');
    const v = toPublicView(question, perm, 1, 1, { ...preview, endLine: 5, text });
    expect(assertPublicView(v).code?.text).toBe(text);
  });

  it('still rejects a forbidden key injected into code', () => {
    const v = toPublicView(question, perm, 1, 1, preview);
    for (const key of FORBIDDEN_KEYS) {
      expect(() => assertPublicView({ ...v, code: { ...v.code, nested: [{ [key]: 'x' }] } })).toThrow(new RegExp(`Forbidden key "${key}" in public view at code.nested`));
      expect(() => assertPublicView({ ...v, code: { ...v.code, [key]: 'x' } })).toThrow(new RegExp(`Forbidden key "${key}" in public view at code`));
    }
  });
});
