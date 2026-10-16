// Error paths of createProvider, as a user meets them: which provider, which env var or option,
// how to fix it, no stack noise, and never a secret value. Companion to factory.test.ts.
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { AnthropicProvider } from '../../../src/generate/providers/anthropic.js';
import { API_KEY_ENV, PROVIDER_NAMES, createProvider } from '../../../src/generate/providers/factory.js';
import { ProviderError } from '../../../src/generate/providers/provider.js';

const SECRET = 'sk-SECRET-do-not-print-0123456789';
const config = () => defaultConfig();

const reject = async (p: Promise<unknown>): Promise<Error> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
};

describe('createProvider: unknown provider', () => {
  it('throws a plain Error naming the value (unreachable from the CLI, which validates --provider first)', async () => {
    const e = await reject(createProvider('bogus' as never, { config: config(), env: { ANTHROPIC_API_KEY: SECRET } }));
    expect(e).not.toBeInstanceOf(ProviderError); // so the CLI would print it as an unexpected error, not exit 2
    expect(e.message).toBe('unknown provider bogus');
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toMatch(/\n\s+at /);
  });
});

describe('createProvider: missing API key', () => {
  it.each(PROVIDER_NAMES.filter((n) => n !== 'openai-compatible'))('%s names the env var it reads', async (name) => {
    const e = (await reject(createProvider(name, { config: config(), env: { UNRELATED: SECRET } }))) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('missing_api_key');
    expect(e.message).toBe(`${API_KEY_ENV[name]} is not set.`);
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toMatch(/\n\s+at /);
  });

  it('openai-compatible never requires a key', async () => {
    const p = await createProvider('openai-compatible', { config: config(), env: {}, model: 'llama' });
    expect(p.name).toBe('openai-compatible');
  });

  it('checks the key before the model, so a key-less run fails on the key first', async () => {
    const e = (await reject(createProvider('openai', { config: config(), env: {} }))) as ProviderError;
    expect(e.code).toBe('missing_api_key');
  });
});

describe('createProvider: missing model never leaks the key', () => {
  it('names the provider and both ways to set the model, without the key value', async () => {
    for (const name of ['openai', 'openai-compatible'] as const) {
      const e = (await reject(createProvider(name, { config: config(), env: { OPENAI_API_KEY: SECRET, OPENAI_COMPAT_API_KEY: SECRET } }))) as ProviderError;
      expect(e.code).toBe('missing_model');
      expect(e.message).toContain(`No model set for ${name}`);
      expect(e.message).toContain('--model');
      expect(e.message).toContain(`provider.models["${name}"]`);
      expect(e.message).toContain('.gotchea/config.json');
      expect(e.message).not.toContain(SECRET);
    }
  });

  it('treats a blank --model and a blank configured model as unset', async () => {
    const c = config();
    c.provider.models.openai = '   ';
    const e = (await reject(createProvider('openai', { config: c, env: { OPENAI_API_KEY: SECRET }, model: ' ' }))) as ProviderError;
    expect(e.code).toBe('missing_model');
  });
});

describe('createProvider: anthropic with the real SDK', () => {
  it('builds lazily from the key (and an optional ANTHROPIC_BASE_URL) without any request', async () => {
    const p = await createProvider('anthropic', { config: config(), env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(p)).not.toContain(SECRET);
    const plain = await createProvider('anthropic', { config: config(), env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: '  ' } });
    expect(plain).toBeInstanceOf(AnthropicProvider);
  });
});
