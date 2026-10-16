import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, computeRepoId } from 'gotchea-core';
import { FsQuestionStore } from 'gotchea-core/internal';
import { messages, messagesFor } from '../src/i18n.js';
import { GetMapOutputSchema } from '../src/schemas.js';
import { EXPLANATION, NOW, SEED_OPTIONS, connect, createFixture, text } from './helpers.js';

describe('MCP map language', () => {
  it('selects Turkish case-insensitively and falls back to English', () => {
    for (const lang of ['tr', 'TR', 'tr-TR', 'Tr-tR']) expect(messagesFor(lang)).toBe(messages.tr);
    for (const lang of [undefined, '', 'en', 'pt-BR', 'tr-CY', 'invalid']) expect(messagesFor(lang)).toBe(messages.en);
  });

  it('uses config on each call, defaults to English and preserves structured output', async () => {
    const fx = await createFixture();
    const conn = await connect(fx.root, fx.env);
    try {
      const call = () => conn.client.callTool({ name: 'get_map', arguments: {} });
      const initial = await call();
      for (const lang of [undefined, 'en', 'tr', 'tr-TR', 'tr-tr', 'tr-Tr', 'pt-BR', 'tr-CY']) {
        await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ questions: lang ? { lang } : {} }));
        const res = await call();
        expect(res.isError).toBeFalsy();
        GetMapOutputSchema.parse(res.structuredContent);
        expect(res.structuredContent).toEqual(initial.structuredContent);
        const t = text(res);
        if (lang && ['tr', 'tr-tr'].includes(lang.toLowerCase())) {
          expect(t.split('\n')[0]).toMatch(/^\d+ chunk · 1 soru · sonraki adım: quiz çöz$/);
          expect(t).toMatch(/math\.ts · \d+ LOC · 1 soru/);
          expect(t).toMatch(/src\/ · \d+ LOC · Σ 1 soru/);
          expect(t).toMatch(/· 0 soru/);
        } else {
          expect(t.split('\n')[0]).toMatch(/^\d+ chunks · 1 question · next step: take a quiz$/);
          expect(t).toMatch(/math\.ts · \d+ LOC · 1 question/);
          expect(t).toMatch(/src\/ · \d+ LOC · Σ 1 question/);
          expect(t).toMatch(/· 0 questions/);
          expect(t).not.toMatch(/soru|sonraki adım|çöz|sarı|yeşil/);
        }
        for (const secret of [EXPLANATION, ...SEED_OPTIONS, 'correctIndex', 'explanation']) expect(t).not.toContain(secret);
      }
    } finally {
      await conn.close();
      await fx.cleanup();
    }
  });

  it.each(['en', 'tr'])('renders all map next-step states in %s', async (lang) => {
    const fx = await createFixture();
    const conn = await connect(fx.root, fx.env);
    try {
      await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ questions: { lang } }));
      // Keep one leaf and its ancestors so yellow and green are repository-wide states.
      const store = new FsChunkStore(fx.root);
      const file = (await store.load())!;
      file.chunks = file.chunks.filter((c) => ['.', 'src', fx.seededChunkId].includes(c.id));
      await store.save(file);
      const leaf = file.chunks.find((c) => c.id === fx.seededChunkId)!;
      const progress = new FsProgressStore(await computeRepoId(fx.root), fx.env);
      const data = await progress.load();
      for (const [daysAgo, color, en, tr] of [
        [0, 'green', 'all green', 'hepsi yeşil'],
        [9, 'yellow', 'review yellow chunks', 'sarıları tekrar et'],
        [30, 'red', 'take a quiz', 'quiz çöz'],
      ] as const) {
        data.chunks[leaf.id] = {
          stability: 3,
          lastReviewedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
          lastPassedHash: leaf.contentHash,
          lastSeenHash: leaf.contentHash,
          mustRepass: false,
          history: [],
        };
        await progress.save(data);
        const res = await conn.client.callTool({ name: 'get_map', arguments: {} });
        const out = GetMapOutputSchema.parse(res.structuredContent);
        expect(out.root!.state.color).toBe(color);
        expect(text(res).split('\n')[0]).toBe(lang === 'tr'
          ? `1 chunk · 1 soru · sonraki adım: ${tr}`
          : `1 chunk · 1 question · next step: ${en}`);
      }
      await new FsQuestionStore(fx.root).remove(leaf.id);
      const empty = await conn.client.callTool({ name: 'get_map', arguments: {} });
      expect(text(empty).split('\n')[0]).toBe(lang === 'tr'
        ? '1 chunk · 0 soru · sonraki adım: soru üret'
        : '1 chunk · 0 questions · next step: generate questions');
    } finally {
      await conn.close();
      await fx.cleanup();
    }
  });
});
