import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  isConfigError,
  parseJsonText,
  providerLabel,
  requestQuestionBatch,
  type JsonRequest,
  type LLMProvider,
} from '../../../src/generate/providers/provider.js';
import { RAW_BATCH_JSON_SCHEMA } from '../../../src/generate/schema.js';

function fakeProvider(output: unknown) {
  const requests: JsonRequest[] = [];
  const provider: LLMProvider = {
    name: 'openai',
    model: 'fake',
    completeJson: async (req) => {
      requests.push(req);
      return output;
    },
  };
  return { provider, requests };
}

const prompt = { system: 'SYSTEM', user: 'USER' };

describe('requestQuestionBatch', () => {
  it('sends the batch schema and returns items untouched', async () => {
    const items = [{ anything: true }, 'not even an object', 3];
    const { provider, requests } = fakeProvider({ questions: items });
    const batch = await requestQuestionBatch(provider, prompt, { maxTokens: 123 });
    expect(batch).toEqual({ questions: items });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ system: 'SYSTEM', user: 'USER', schemaName: 'question_batch', effort: 'medium', maxTokens: 123 });
    expect(requests[0]!.schema).toBe(RAW_BATCH_JSON_SCHEMA);
  });

  it.each([[{ foo: 1 }], [{ questions: [] }], [null], ['{"questions":[1]}'], [{ questions: [1], extra: true }]])(
    'rejects %j as invalid_json',
    async (output) => {
      const { provider } = fakeProvider(output);
      const err = await requestQuestionBatch(provider, prompt).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe('invalid_json');
      expect((err as ProviderError).message).toContain('openai:fake');
    },
  );

  it('propagates provider errors', async () => {
    const provider: LLMProvider = { name: 'anthropic', model: 'm', completeJson: () => Promise.reject(new ProviderError('refusal', 'no')) };
    await expect(requestQuestionBatch(provider, prompt)).rejects.toMatchObject({ code: 'refusal' });
  });
});

describe('helpers', () => {
  it('isConfigError is true only for provider configuration errors', () => {
    expect(isConfigError(new ProviderError('unknown_provider', 'x'))).toBe(true);
    expect(isConfigError(new ProviderError('missing_api_key', 'x'))).toBe(true);
    expect(isConfigError(new ProviderError('missing_model', 'x'))).toBe(true);
    for (const code of ['http', 'refusal', 'truncated', 'invalid_json', 'network'] as const) {
      expect(isConfigError(new ProviderError(code, 'x'))).toBe(false);
    }
    expect(isConfigError(Object.assign(new Error('x'), { code: 'missing_api_key' }))).toBe(false);
    expect(isConfigError(undefined)).toBe(false);
  });

  it('parseJsonText parses or throws invalid_json with a cause', () => {
    expect(parseJsonText('{"a":[1]}', 'p')).toEqual({ a: [1] });
    try {
      parseJsonText('nope', 'p:m');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'invalid_json', name: 'ProviderError' });
      expect((err as Error).message).toContain('p:m');
      expect((err as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('ProviderError carries code and optional status; providerLabel joins name and model', () => {
    const e = new ProviderError('http', 'boom', { status: 503 });
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ code: 'http', status: 503, message: 'boom' });
    expect(new ProviderError('network', 'x').status).toBeUndefined();
    expect(providerLabel({ name: 'anthropic', model: 'claude-sonnet-5-5' })).toBe('anthropic:claude-sonnet-5-5');
  });
});
