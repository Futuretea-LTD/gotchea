import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import type { GotcheaConfig } from '../../../src/config/schema.js';
import { AnthropicProvider, type AnthropicClientLike } from '../../../src/generate/providers/anthropic.js';
import { createProvider } from '../../../src/generate/providers/factory.js';
import type { FetchLike } from '../../../src/generate/providers/openai-chat.js';
import { OpenAIChatProvider } from '../../../src/generate/providers/openai-chat.js';
import { ProviderError } from '../../../src/generate/providers/provider.js';

const anthropicClient: AnthropicClientLike = {
  beta: { messages: { create: () => Promise.reject(new Error('not called')) } },
};

function config(models: Partial<GotcheaConfig['provider']['models']> = {}, baseUrl?: string): GotcheaConfig {
  const c = defaultConfig();
  c.provider.models = { ...c.provider.models, ...models };
  if (baseUrl) c.provider.baseUrl = baseUrl;
  return c;
}

function recordingFetch() {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }) };
  };
  return { fetch, urls };
}

const req = { system: 's', user: 'u', schema: {}, schemaName: 'n' };

async function errOf(p: Promise<unknown>): Promise<ProviderError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createProvider: anthropic', () => {
  it('requires ANTHROPIC_API_KEY when no client is injected', async () => {
    const e = await errOf(createProvider('anthropic', { config: config(), env: {} }));
    expect(e.code).toBe('missing_api_key');
    expect(e.message).toContain('ANTHROPIC_API_KEY');
    expect((await errOf(createProvider('anthropic', { config: config(), env: { ANTHROPIC_API_KEY: '  ' } }))).code).toBe('missing_api_key');
  });

  it('builds an AnthropicProvider with the configured or overriding model', async () => {
    const p = await createProvider('anthropic', { config: config(), env: {}, anthropicClient });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.name).toBe('anthropic');

    const o = await createProvider('anthropic', { config: config(), env: {}, anthropicClient, model: 'claude-other' });
    expect(o.model).toBe('claude-other');
  });

  it('default config resolves exactly claude-sonnet-5-5; precedence is --model > config', async () => {
    expect(defaultConfig().provider.models.anthropic).toBe('claude-sonnet-5-5');
    const calls: { model: string; max_tokens: number }[] = [];
    const recording: AnthropicClientLike = {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] };
          },
        },
      },
    };
    const def = await createProvider('anthropic', { config: defaultConfig(), env: {}, anthropicClient: recording });
    await def.completeJson(req);
    expect(calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16000 });

    const cfg = await createProvider('anthropic', { config: config({ anthropic: 'claude-cfg' }), env: {}, anthropicClient: recording });
    expect(cfg.model).toBe('claude-cfg');
    const flag = await createProvider('anthropic', { config: config({ anthropic: 'claude-cfg' }), env: {}, anthropicClient: recording, model: 'claude-flag' });
    expect(flag.model).toBe('claude-flag');
    const blankFlag = await createProvider('anthropic', { config: config({ anthropic: 'claude-cfg' }), env: {}, anthropicClient: recording, model: '  ' });
    expect(blankFlag.model).toBe('claude-cfg');
  });

  it('empty-string ANTHROPIC_API_KEY counts as missing', async () => {
    expect((await errOf(createProvider('anthropic', { config: config(), env: { ANTHROPIC_API_KEY: '' } }))).code).toBe('missing_api_key');
  });

  it('falls back to the default model when config has none', async () => {
    const p = await createProvider('anthropic', { config: config({ anthropic: null }), env: {}, anthropicClient });
    expect(p.model).toBe('claude-sonnet-5-5');
  });
});

describe('createProvider: openai', () => {
  it('requires OPENAI_API_KEY, then a model', async () => {
    const e = await errOf(createProvider('openai', { config: config({ openai: 'gpt-x' }), env: {} }));
    expect(e.code).toBe('missing_api_key');
    expect(e.message).toContain('OPENAI_API_KEY');
    const m = await errOf(createProvider('openai', { config: config(), env: { OPENAI_API_KEY: 'k' } }));
    expect(m.code).toBe('missing_model');
  });

  it('uses config.provider.models.openai, and --model overrides it', async () => {
    const p = await createProvider('openai', { config: config({ openai: 'gpt-x' }), env: { OPENAI_API_KEY: 'k' } });
    expect(p).toBeInstanceOf(OpenAIChatProvider);
    expect(p.name).toBe('openai');
    expect(p.model).toBe('gpt-x');
    const o = await createProvider('openai', { config: config({ openai: 'gpt-x' }), env: { OPENAI_API_KEY: 'k' }, model: 'gpt-y' });
    expect(o.model).toBe('gpt-y');
  });

  it('uses the default base URL, or OPENAI_BASE_URL from env', async () => {
    const def = recordingFetch();
    await (await createProvider('openai', { config: config({ openai: 'm' }), env: { OPENAI_API_KEY: 'k' }, fetch: def.fetch })).completeJson(req);
    expect(def.urls).toEqual(['https://api.openai.com/v1/chat/completions']);

    const custom = recordingFetch();
    const env = { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://proxy.example/v1/' };
    await (await createProvider('openai', { config: config({ openai: 'm' }), env, fetch: custom.fetch })).completeJson(req);
    expect(custom.urls).toEqual(['https://proxy.example/v1/chat/completions']);
  });

  it('empty or blank OPENAI_API_KEY counts as missing', async () => {
    for (const key of ['', '   ']) {
      expect((await errOf(createProvider('openai', { config: config({ openai: 'm' }), env: { OPENAI_API_KEY: key } }))).code).toBe('missing_api_key');
    }
  });

  it('--model works without config; empty OPENAI_BASE_URL falls back to the default', async () => {
    const { fetch, urls } = recordingFetch();
    const p = await createProvider('openai', { config: config(), env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: '' }, fetch, model: 'gpt-flag' });
    expect(p.model).toBe('gpt-flag');
    await p.completeJson(req);
    expect(urls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('ignores process.env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-process');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-process');
    expect((await errOf(createProvider('openai', { config: config({ openai: 'm' }), env: {} }))).code).toBe('missing_api_key');
    expect((await errOf(createProvider('anthropic', { config: config(), env: {} }))).code).toBe('missing_api_key');
  });
});

describe('createProvider: openai-compatible', () => {
  it('needs no key and uses config.provider.baseUrl', async () => {
    const { fetch, urls } = recordingFetch();
    const p = await createProvider('openai-compatible', { config: config({ 'openai-compatible': 'llama' }, 'http://gpu:8000/v1'), env: {}, fetch });
    expect(p.name).toBe('openai-compatible');
    expect(p.model).toBe('llama');
    await p.completeJson(req);
    expect(urls).toEqual(['http://gpu:8000/v1/chat/completions']);
  });

  it('OPENAI_COMPAT_BASE_URL overrides config', async () => {
    const { fetch, urls } = recordingFetch();
    const env = { OPENAI_COMPAT_BASE_URL: 'http://env:1/v1' };
    await (await createProvider('openai-compatible', { config: config({ 'openai-compatible': 'llama' }, 'http://gpu:8000/v1'), env, fetch })).completeJson(req);
    expect(urls).toEqual(['http://env:1/v1/chat/completions']);
  });

  it('defaults baseUrl from defaultConfig()', async () => {
    const p = await createProvider('openai-compatible', { config: config({ 'openai-compatible': 'llama' }), env: {} });
    expect((p as OpenAIChatProvider).baseURL).toBe(defaultConfig().provider.baseUrl);
    expect((p as OpenAIChatProvider).baseURL).toBe('http://localhost:11434/v1');
  });

  it('empty OPENAI_COMPAT_BASE_URL does not override config', async () => {
    const { fetch, urls } = recordingFetch();
    const env = { OPENAI_COMPAT_BASE_URL: '' };
    await (await createProvider('openai-compatible', { config: config({ 'openai-compatible': 'llama' }, 'http://gpu:8000/v1'), env, fetch })).completeJson(req);
    expect(urls).toEqual(['http://gpu:8000/v1/chat/completions']);
  });

  it('OPENAI_COMPAT_API_KEY becomes a bearer header; empty key sends none', async () => {
    const headers: Record<string, string>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      headers.push(init.headers);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }) };
    };
    const cfg = config({ 'openai-compatible': 'llama' });
    await (await createProvider('openai-compatible', { config: cfg, env: { OPENAI_COMPAT_API_KEY: 'ck' }, fetch })).completeJson(req);
    await (await createProvider('openai-compatible', { config: cfg, env: { OPENAI_COMPAT_API_KEY: '' }, fetch })).completeJson(req);
    await (await createProvider('openai-compatible', { config: cfg, env: {}, fetch })).completeJson(req);
    expect(headers[0]!['authorization']).toBe('Bearer ck');
    expect(headers[1]).not.toHaveProperty('authorization');
    expect(headers[2]).not.toHaveProperty('authorization');
  });

  it('--model overrides config for openai-compatible', async () => {
    const p = await createProvider('openai-compatible', { config: config({ 'openai-compatible': 'llama' }), env: {}, model: 'qwen' });
    expect(p.model).toBe('qwen');
  });

  it('missing model → missing_model', async () => {
    expect((await errOf(createProvider('openai-compatible', { config: config(), env: {} }))).code).toBe('missing_model');
  });
});
