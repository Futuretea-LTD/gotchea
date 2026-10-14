import { describe, expect, it } from 'vitest';
import { OpenAIChatProvider, type FetchLike } from '../../../src/generate/providers/openai-chat.js';
import { createOpenAICompatibleProvider } from '../../../src/generate/providers/openai-compatible.js';
import { OPENAI_BASE_URL, createOpenAIProvider } from '../../../src/generate/providers/openai.js';
import { ProviderError, type JsonRequest } from '../../../src/generate/providers/provider.js';

const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
const req: JsonRequest = { system: 'sys', user: 'usr', schema, schemaName: 'thing' };

interface Reply {
  status?: number;
  body: string;
}
type Call = Parameters<FetchLike>[1] & { url: string; json: Record<string, unknown> };

const ok = (content: string | null, extra: Record<string, unknown> = {}): Reply => ({
  body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, ...extra } }] }),
});

/** Replies are consumed in order; the last one repeats. */
function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...init, json: JSON.parse(init.body) as Record<string, unknown> });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.body };
  };
  return { fetch, calls };
}

async function errOf(p: Promise<unknown>): Promise<ProviderError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

const rejectFormat: Reply = { status: 400, body: '{"error":{"message":"response_format json_schema is not supported"}}' };

describe('OpenAIChatProvider request', () => {
  it('openai: posts to /chat/completions with bearer auth and strict json_schema', async () => {
    const { fetch, calls } = fakeFetch(ok('{"a":1}'));
    const p = createOpenAIProvider({ apiKey: 'sk-test', model: 'gpt-x', fetch });
    expect(await p.completeJson(req)).toEqual({ a: 1 });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`${OPENAI_BASE_URL}/chat/completions`);
    expect(c.method).toBe('POST');
    expect(c.headers['authorization']).toBe('Bearer sk-test');
    expect(c.headers['content-type']).toBe('application/json');
    expect(c.signal).toBeInstanceOf(AbortSignal);
    expect(c.json).toMatchObject({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'thing', schema, strict: true } },
    });
    expect(c.json['max_completion_tokens']).toBe(16000);
    expect(c.json).not.toHaveProperty('max_tokens');
    for (const k of ['temperature', 'tools', 'tool_choice']) expect(c.json).not.toHaveProperty(k);
  });

  it('openai-compatible: normalises trailing slashes, no auth without a key, uses max_tokens', async () => {
    const { fetch, calls } = fakeFetch(ok('{"a":1}'));
    const p = createOpenAICompatibleProvider({ baseURL: 'http://localhost:11434/v1//', model: 'llama', fetch });
    expect(p.baseURL).toBe('http://localhost:11434/v1');
    await p.completeJson({ ...req, maxTokens: 99 });
    const c = calls[0]!;
    expect(c.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(c.headers).not.toHaveProperty('authorization');
    expect(c.json['max_tokens']).toBe(99);
    expect(c.json).not.toHaveProperty('max_completion_tokens');
  });

  it('openai-compatible: sends bearer auth when a key is set', async () => {
    const { fetch, calls } = fakeFetch(ok('{"a":1}'));
    await createOpenAICompatibleProvider({ baseURL: 'http://h/v1', apiKey: 'k', model: 'm', fetch }).completeJson(req);
    expect(calls[0]!.headers['authorization']).toBe('Bearer k');
  });

  it('treats an empty-string apiKey as no key (no authorization header)', async () => {
    const { fetch, calls } = fakeFetch(ok('{"a":1}'));
    await new OpenAIChatProvider({ name: 'openai-compatible', baseURL: 'http://h/v1/', apiKey: '', model: 'm', fetch }).completeJson(req);
    expect(calls[0]!.url).toBe('http://h/v1/chat/completions');
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
  });

  it('openai-compatible json_schema request has the same shape as openai', async () => {
    const { fetch, calls } = fakeFetch(ok('{"a":1}'));
    await createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'llama', fetch }).completeJson(req);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.json).toMatchObject({
      model: 'llama',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'thing', schema, strict: true } },
      max_tokens: 16000,
    });
  });

  it('passes the caller signal through', async () => {
    const { fetch, calls } = fakeFetch(ok('{}'));
    const signal = new AbortController().signal;
    await createOpenAIProvider({ apiKey: 'k', model: 'm', fetch }).completeJson({ ...req, signal });
    expect(calls[0]!.signal).toBe(signal);
  });
});

describe('json_object fallback', () => {
  it('openai-compatible retries once with json_object and remembers the mode', async () => {
    const { fetch, calls } = fakeFetch(rejectFormat, ok('{"a":1}'));
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect(p.mode).toBe('json_schema');
    expect(await p.completeJson(req)).toEqual({ a: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.json['response_format']).toMatchObject({ type: 'json_schema' });
    const retry = calls[1]!.json;
    expect(retry['response_format']).toEqual({ type: 'json_object' });
    const system = (retry['messages'] as { content: string }[])[0]!.content;
    expect(system.startsWith('sys')).toBe(true);
    expect(system).toContain(JSON.stringify(schema));
    expect(p.mode).toBe('json_object');

    await p.completeJson(req);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.json['response_format']).toEqual({ type: 'json_object' });
  });

  it('openai-compatible does not retry on an unrelated 400', async () => {
    const { fetch, calls } = fakeFetch({ status: 400, body: 'bad model' });
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect(await errOf(p.completeJson(req))).toMatchObject({ code: 'http', status: 400 });
    expect(calls).toHaveLength(1);
    expect(p.mode).toBe('json_schema');
  });

  it('keeps json_schema when the json_object retry also fails', async () => {
    const { fetch, calls } = fakeFetch(rejectFormat, { status: 400, body: 'nope' });
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect(await errOf(p.completeJson(req))).toMatchObject({ code: 'http', status: 400 });
    expect(calls).toHaveLength(2);
    expect(p.mode).toBe('json_schema');
  });

  it('falls back on a 400 that mentions only json_schema', async () => {
    const { fetch, calls } = fakeFetch({ status: 400, body: 'unsupported: json_schema' }, ok('{"a":1}'));
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect(await p.completeJson(req)).toEqual({ a: 1 });
    expect(calls).toHaveLength(2);
    expect(p.mode).toBe('json_object');
  });

  it('does not fall back on a non-400 status that mentions response_format', async () => {
    const { fetch, calls } = fakeFetch({ status: 500, body: 'response_format crashed' });
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect(await errOf(p.completeJson(req))).toMatchObject({ code: 'http', status: 500 });
    expect(calls).toHaveLength(1);
    expect(p.mode).toBe('json_schema');
  });

  it('a json_object retry that returns non-JSON content → invalid_json, mode still remembered', async () => {
    const { fetch } = fakeFetch(rejectFormat, ok('not json'));
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect((await errOf(p.completeJson(req))).code).toBe('invalid_json');
    expect(p.mode).toBe('json_object');
  });

  it('openai does not fall back', async () => {
    const { fetch, calls } = fakeFetch(rejectFormat);
    const p = createOpenAIProvider({ apiKey: 'k', model: 'm', fetch });
    expect(await errOf(p.completeJson(req))).toMatchObject({ code: 'http', status: 400 });
    expect(calls).toHaveLength(1);
    expect(p.mode).toBe('json_schema');
  });
});

describe('response mapping', () => {
  const run = (...replies: Reply[]) => {
    const { fetch } = fakeFetch(...replies);
    return new OpenAIChatProvider({ name: 'openai', baseURL: 'http://h', apiKey: 'k', model: 'm', fetch }).completeJson(req);
  };

  it.each([
    ['finish_reason length', { body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] }) }, 'truncated'],
    ['message.refusal', ok(null, { refusal: 'I cannot' }), 'refusal'],
    ['non-JSON content', ok('here you go'), 'invalid_json'],
    ['null content', ok(null), 'invalid_json'],
    ['non-JSON body', { body: '<html>oops</html>' }, 'invalid_json'],
    ['no choices', { body: '{"choices":[]}' }, 'invalid_json'],
    ['missing choices key', { body: '{"id":"x"}' }, 'invalid_json'],
    ['JSON null body', { body: 'null' }, 'invalid_json'],
    ['JSON string body', { body: '"hello"' }, 'invalid_json'],
    ['empty body', { body: '' }, 'invalid_json'],
    ['choice without message', { body: '{"choices":[{"finish_reason":"stop"}]}' }, 'invalid_json'],
    ['null choice', { body: '{"choices":[null]}' }, 'invalid_json'],
  ] as const)('%s → %s', async (_label, reply, code) => {
    expect((await errOf(run(reply))).code).toBe(code);
  });

  it('openai-compatible: non-JSON content → invalid_json', async () => {
    const { fetch } = fakeFetch(ok('```json\n{"a":1}\n```'));
    const p = createOpenAICompatibleProvider({ baseURL: 'http://h/v1', model: 'm', fetch });
    expect((await errOf(p.completeJson(req))).code).toBe('invalid_json');
  });

  it.each([401, 404, 429, 503])('%i → http with that status', async (status) => {
    expect(await errOf(run({ status, body: 'err' }))).toMatchObject({ code: 'http', status });
  });

  it('500 → http with status', async () => {
    expect(await errOf(run({ status: 500, body: 'internal' }))).toMatchObject({ code: 'http', status: 500 });
  });

  it('fetch rejection → network', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const p = createOpenAIProvider({ apiKey: 'k', model: 'm', fetch });
    const e = await errOf(p.completeJson(req));
    expect(e.code).toBe('network');
    expect(e.message).toContain('fetch failed');
  });

  it('never quotes the API key from an error body', async () => {
    const { fetch } = fakeFetch({ status: 401, body: '{"error":"bad key sk-secret-123 in Authorization: Bearer sk-secret-123"}' });
    const p = createOpenAIProvider({ apiKey: 'sk-secret-123', model: 'm', fetch });
    const e = await errOf(p.completeJson(req));
    expect(e).toMatchObject({ code: 'http', status: 401 });
    expect(e.message).not.toContain('sk-secret-123');
    expect(e.message).toContain('[redacted]');
  });

  it('network errors drop credentials and query from the base URL', async () => {
    const baseURL = 'https://user:tok3n@gw.example/v1?api-key=tok3n';
    const fetch: FetchLike = (url) => Promise.reject(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`));
    const p = createOpenAICompatibleProvider({ baseURL, model: 'm', fetch });
    const e = await errOf(p.completeJson(req));
    expect(e.code).toBe('network');
    expect(e.message).not.toContain('tok3n');
    expect(e.message).toContain('https://gw.example/v1');
  });
});
