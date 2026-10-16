// What the user sees on stderr when provider setup fails: one clean message, exit 2, no stack,
// no secret. Companion to generate.test.ts (which covers the happy paths and the key hint).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, type Sandbox } from './helpers.js';

let s: Sandbox;
const SECRET = 'sk-SECRET-do-not-print-0123456789';

beforeEach(async () => {
  s = await createSandbox();
  expect((await s.gotchea(['init'])).code).toBe(0);
  expect((await s.gotchea(['scan'])).code).toBe(0);
});
afterEach(async () => {
  await s.cleanup();
});

const expectClean = (stderr: string) => {
  expect(stderr).not.toMatch(/\n\s+at /); // no stack frames
  expect(stderr).not.toContain(SECRET);
  expect(stderr).not.toMatch(/ProviderError|CliError|\[object/);
};

describe('gotchea generate: provider setup errors', () => {
  it('missing key: names the env var, offers the alternatives, leaks nothing, exits 2', async () => {
    // A key for a *different* provider is in the environment and must not be echoed.
    const r = await s.gotchea(['generate', '--provider', 'openai'], { env: { ANTHROPIC_API_KEY: SECRET } });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('OPENAI_API_KEY is not set.');
    expect(r.stderr).toContain('--provider');
    expect(r.stderr).toContain('get_generation_tasks/save_questions');
    expectClean(r.stderr);
  });

  it('missing model: names the provider and both ways to set it, even when a key is present', async () => {
    const r = await s.gotchea(['generate', '--provider', 'openai'], { env: { OPENAI_API_KEY: SECRET } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('No model set for openai');
    expect(r.stderr).toContain('--model');
    expect(r.stderr).toContain('provider.models["openai"]');
    expectClean(r.stderr);
  });

  it('--json keeps stdout empty on a setup error', async () => {
    const r = await s.gotchea(['generate', '--json'], { env: {} });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not set');
  });

  it('--dry-run needs no provider and so no key', async () => {
    const r = await s.gotchea(['generate', '--dry-run'], { env: {} });
    expect(r.code, r.stderr).toBe(0);
  });

  it('an unknown --provider lists the valid ones', async () => {
    const r = await s.gotchea(['generate', '--provider', 'bogus'], { env: { ANTHROPIC_API_KEY: SECRET } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--provider: expected one of anthropic, openai, openai-compatible, got "bogus"');
    expectClean(r.stderr);
  });

  it('an unknown provider.default in config.json is rejected before any provider is built', async () => {
    const path = join(s.root, '.gotchea', 'config.json');
    const cfg = JSON.parse(await readFile(path, 'utf8')) as { provider?: Record<string, unknown> };
    cfg.provider = { ...cfg.provider, default: 'bogus' };
    await writeFile(path, JSON.stringify(cfg));
    const r = await s.gotchea(['generate'], { env: { ANTHROPIC_API_KEY: SECRET } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('provider.default'); // names the field (not the bad value; see report)
    expect(r.stderr).toContain('anthropic');
    expectClean(r.stderr);
  });
});
