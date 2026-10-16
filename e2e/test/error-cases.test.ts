import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { GenerationTaskOut, StartQuizOut } from '../../packages/mcp/src/schemas.js';
import { createHarness } from '../src/harness.js';
import { fakeQuestions, generateQuestions } from '../src/scenarios.js';

function text(result: CallToolResult): string {
  return result.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n');
}

describe('F: invalid requests and repository preconditions', () => {
  it.each([
    ['three options', (question: Record<string, unknown>) => ({ ...question, options: (question['options'] as string[]).slice(0, 3) })],
    ['a missing required question field', (question: Record<string, unknown>) => {
      const { explanation: _explanation, ...incomplete } = question;
      return incomplete;
    }],
    ['an out-of-range correctIndex', (question: Record<string, unknown>) => ({ ...question, correctIndex: 4 })],
  ])('rejects save_questions with %s and keeps serving tools', async (_label, invalidate) => {
    const harness = await createHarness();
    const call = harness.callTool.bind(harness);
    try {
      await call('scan');
      const tasks = (await call('get_generation_tasks', { limit: 1, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
      const task = tasks.tasks[0]!;
      const question = fakeQuestions(task)[0]!;
      // Question validation is per item: a rejected batch need not be a protocol error.
      const result = await call('save_questions', {
        chunkId: task.chunkId, chunkHash: task.chunkHash, lang: 'en', questions: [invalidate(question)],
      });
      expect(result.structuredContent).toMatchObject({
        savedCount: 0, accepted: [], rejected: [{ index: 0, reason: 'schema_invalid', detail: expect.any(String) }],
      });
      expect(text(result as CallToolResult)).toMatch(/schema_invalid|invalid|validation/i);
      expect(text(result as CallToolResult)).toMatch(/fix|resubmit/i);
      const status = await call('get_status');
      expect(status.structuredContent).toMatchObject({ initialized: true, scanned: true, questions: 0 });
      // The same server can still accept a valid submission after rejecting the bad item.
      expect((await call('save_questions', {
        chunkId: task.chunkId, chunkHash: task.chunkHash, lang: 'en', questions: [question],
      })).structuredContent).toMatchObject({ savedCount: 1, rejected: [] });
    } finally {
      await harness.dispose();
    }
  });

  it('rejects a missing required save_questions argument without terminating the server', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.client.callTool({
        name: 'save_questions', arguments: { chunkId: 'src/math.ts', questions: [{ invalid: true }] },
      }) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/invalid|validation/i);
      expect(text(result)).toMatch(/chunkHash/i);
      expect((await harness.callTool('get_status')).structuredContent).toMatchObject({ initialized: true });
    } finally {
      await harness.dispose();
    }
  });

  it('explains invalid session and question ids and preserves the active quiz', async () => {
    const harness = await createHarness();
    const call = harness.callTool.bind(harness);
    try {
      await call('scan');
      const [task] = await generateQuestions(call);
      const start = (await call('start_quiz', { chunkId: task!.chunkId, lang: 'en' })).structuredContent as StartQuizOut;
      expect(start.status).toBe('started');
      for (const [args, reason, message] of [
        [{ sessionId: 'qs_0000000000000000', questionId: start.question!.questionId, displayIndex: 0 }, 'unknown_session', /start_quiz/i],
        [{ sessionId: start.session!.id, questionId: 'nonexistent-question', displayIndex: 0 }, 'unknown_question', /not part of this session/i],
      ] as const) {
        const result = await harness.client.callTool({ name: 'submit_answer', arguments: args }) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 'refused', reason, reveal: null, result: null });
        expect(text(result)).toMatch(message);
        expect((await call('get_status')).structuredContent).toMatchObject({ initialized: true, scanned: true });
      }
      const valid = await call('submit_answer', {
        sessionId: start.session!.id, questionId: start.question!.questionId, displayIndex: 0,
      });
      expect(valid.structuredContent).toMatchObject({ status: 'answered', progress: { answered: 1 } });
    } finally {
      await harness.dispose();
    }
  });

  it.each([undefined, 1])('returns an empty lookup for a nonexistent file (line=%s)', async (line) => {
    const harness = await createHarness();
    try {
      await harness.callTool('scan');
      const result = await harness.callTool('get_chunk_for_file', {
        path: 'src/does-not-exist.ts', ...(line === undefined ? {} : { line }),
      });
      expect(result.structuredContent).toMatchObject({ initialized: true, scanned: true, chunks: [] });
      expect(text(result as CallToolResult)).toMatch(/no chunk|not found/i);
      expect((await harness.callTool('get_status')).structuredContent).toMatchObject({ scanned: true });
    } finally {
      await harness.dispose();
    }
  });

  it.each([false, true])('gives actionable setup instructions when initialized=%s but no scan exists', async (initialize) => {
    const harness = await createHarness({ initialize });
    try {
      for (const [name, args] of [
        ['get_status', {}],
        ['get_map', {}],
        ['get_chunk_for_file', { path: 'src/math.ts' }],
        ['get_generation_tasks', { lang: 'en' }],
        ['start_quiz', { chunkId: 'src/math.ts', lang: 'en' }],
      ] as const) {
        const result = await harness.callTool(name, args);
        expect(result.structuredContent, name).toMatchObject({ initialized: initialize, scanned: false });
        expect(text(result as CallToolResult), name).toMatch(/scan/i);
        if (!initialize) expect(text(result as CallToolResult), name).toMatch(/gotchea init/i);
      }
      if (!initialize) await harness.runCli(['init']);
      expect((await harness.callTool('scan')).structuredContent).toMatchObject({ scanned: true });
      expect((await harness.callTool('get_status')).structuredContent).toMatchObject({ initialized: true, scanned: true });
    } finally {
      await harness.dispose();
    }
  });
});
