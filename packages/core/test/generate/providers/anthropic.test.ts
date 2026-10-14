import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  mapAnthropicError,
  type AnthropicClientLike,
  type AnthropicCreateParams,
  type AnthropicMessage,
} from '../../../src/generate/providers/anthropic.js';
import { ProviderError, type JsonRequest } from '../../../src/generate/providers/provider.js';

const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
const req: JsonRequest = { system: 'sys', user: 'usr', schema, schemaName: 'thing', effort: 'medium' };

function fakeClient(respond: () => Promise<AnthropicMessage> | AnthropicMessage) {
  const calls: { params: AnthropicCreateParams; options?: { signal?: AbortSignal } }[] = [];
  const client: AnthropicClientLike = {
    beta: {
      messages: {
        create: async (params, options) => {
          calls.push({ params, ...(options ? { options } : {}) });
          return respond();
        },
      },
    },
  };
  return { client, calls };
}

const text = (t: string, stop_reason: string | null = 'end_turn'): AnthropicMessage => ({ stop_reason, content: [{ type: 'text', text: t }] });

async function codeOf(p: Promise<unknown>): Promise<ProviderError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe('AnthropicProvider', () => {
  it('sends structured-output params with fallback on and no sampling/tool keys', async () => {
    const { client, calls } = fakeClient(() => text('{"a":1}'));
    const p = new AnthropicProvider({ client });
    expect(p.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(await p.completeJson(req)).toEqual({ a: 1 });

    expect(calls).toHaveLength(1);
    const { params, options } = calls[0]!;
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.system).toBe('sys');
    expect(params.messages).toEqual([{ role: 'user', content: 'usr' }]);
    expect(params.output_config.format).toEqual({ type: 'json_schema', schema });
    expect(params.output_config.effort).toBe('medium');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    expect(params.max_tokens).toBe(16000);
    for (const k of ['tool_choice', 'tools', 'temperature', 'top_p', 'top_k', 'thinking']) expect(params).not.toHaveProperty(k);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours model, maxTokens, signal and omits effort when unset', async () => {
    const { client, calls } = fakeClient(() => text('[]'));
    const signal = new AbortController().signal;
    const p = new AnthropicProvider({ client, model: 'claude-x' });
    await p.completeJson({ system: 's', user: 'u', schema, schemaName: 'n', maxTokens: 42, signal });
    const { params, options } = calls[0]!;
    expect(params.model).toBe('claude-x');
    expect(params.max_tokens).toBe(42);
    expect(params.output_config).not.toHaveProperty('effort');
    expect(options?.signal).toBe(signal);
  });

  it('parses the first text block', async () => {
    const { client } = fakeClient(() => ({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking' }, { type: 'text', text: '{"a":2}' }, { type: 'text', text: '{"a":3}' }],
    }));
    expect(await new AnthropicProvider({ client }).completeJson(req)).toEqual({ a: 2 });
  });

  it.each([
    ['refusal', text('', 'refusal'), 'refusal'],
    ['max_tokens', text('{"a":', 'max_tokens'), 'truncated'],
    ['non-JSON text', text('sure! {"a":1}'), 'invalid_json'],
    ['no text block', { stop_reason: 'end_turn', content: [{ type: 'tool_use' }] }, 'invalid_json'],
    ['empty content', { stop_reason: 'end_turn', content: [] }, 'invalid_json'],
    ['empty text', text(''), 'invalid_json'],
    ['truncated JSON with end_turn', text('{"a":'), 'invalid_json'],
    ['max_tokens even with parseable text', text('{"a":1}', 'max_tokens'), 'truncated'],
  ] as const)('%s → %s', async (_label, msg, code) => {
    const { client } = fakeClient(() => msg);
    expect((await codeOf(new AnthropicProvider({ client }).completeJson(req))).code).toBe(code);
  });

  it('maps thrown errors with a numeric status to http, others to network', async () => {
    const http = fakeClient(() => Promise.reject(Object.assign(new Error('rate'), { status: 429 })));
    const e1 = await codeOf(new AnthropicProvider({ client: http.client }).completeJson(req));
    expect(e1.code).toBe('http');
    expect(e1.status).toBe(429);
    expect(e1.message).toContain('rate');

    const net = fakeClient(() => Promise.reject(new Error('ECONNRESET')));
    const e2 = await codeOf(new AnthropicProvider({ client: net.client }).completeJson(req));
    expect(e2.code).toBe('network');
    expect(e2.status).toBeUndefined();
  });
});

describe('mapAnthropicError', () => {
  it('passes ProviderError through and tolerates non-Error values', () => {
    const pe = new ProviderError('refusal', 'x');
    expect(mapAnthropicError(pe)).toBe(pe);
    expect(mapAnthropicError(null).code).toBe('network');
    expect(mapAnthropicError('boom').message).toContain('boom');
    expect(mapAnthropicError({ status: '500' }).code).toBe('network');
    expect(mapAnthropicError({ status: 500 })).toMatchObject({ code: 'http', status: 500 });
  });
});
