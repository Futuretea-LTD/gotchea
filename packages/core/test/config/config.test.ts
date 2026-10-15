import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, loadConfig, mergeConfig, resolveConfig } from '../../src/config/load.js';
import { DEFAULT_EXCLUDE } from '../../src/config/defaults.js';
import { initConfig, saveConfig } from '../../src/store/config-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gotchea-config-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function writeRawConfig(text: string): Promise<void> {
  await mkdir(join(root, '.gotchea'), { recursive: true });
  await writeFile(join(root, '.gotchea', 'config.json'), text);
}

describe('defaultConfig', () => {
  it('has the PLAN.md defaults', () => {
    const c = defaultConfig();
    expect(c.version).toBe(1);
    expect(c.include).toEqual(['**/*']);
    expect(c.exclude).toEqual([...DEFAULT_EXCLUDE]);
    expect(c.ignore).toEqual([]);
    expect(c.respectGitignore).toBe(true);
    expect(c.includeTests).toBe(false);
    expect(c.maxFileBytes).toBe(524288);
    expect(c.chunking).toEqual({ leafMinLoc: 40, leafMaxLoc: 200, mergeBelowLoc: 15, splitAboveLoc: 300 });
    expect(c.questions.bands).toEqual([
      { maxLoc: 60, maxComplexity: 8, count: 3 },
      { maxLoc: 150, maxComplexity: 20, count: 5 },
      { count: 7 },
    ]);
    expect(c.questions.poolMultiplier).toBe(2);
    expect(c.questions.lang).toBe('en');
    expect(c.quiz.passRatio).toBe(0.75);
    expect(c.score).toMatchObject({
      initialStability: 3,
      passMultiplier: 2.5,
      failMultiplier: 0.3,
      minStability: 1,
      forgettingFactor: 9,
      greenAt: 0.85,
      yellowAt: 0.5,
      changeDecayFloor: 0.1,
      redOnChangeRatio: 0.5,
    });
    expect(c.provider.default).toBe('anthropic');
  });

  it('returns a fresh object each call', () => {
    const a = defaultConfig();
    a.include.push('x');
    a.chunking.leafMinLoc = 1;
    const b = defaultConfig();
    expect(b.include).toEqual(['**/*']);
    expect(b.chunking.leafMinLoc).toBe(40);
  });
});

describe('loadConfig', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await loadConfig(root)).toEqual(defaultConfig());
  });

  it('deep-merges nested objects and replaces arrays', async () => {
    await writeRawConfig(
      JSON.stringify({ chunking: { leafMinLoc: 50 }, exclude: ['**/gen/**'], score: { greenAt: 0.9 }, questions: { lang: 'tr' } }),
    );
    const c = await loadConfig(root);
    expect(c.chunking).toEqual({ leafMinLoc: 50, leafMaxLoc: 200, mergeBelowLoc: 15, splitAboveLoc: 300 });
    expect(c.exclude).toEqual(['**/gen/**']);
    expect(c.score.greenAt).toBe(0.9);
    expect(c.score.yellowAt).toBe(0.5);
    expect(c.questions.lang).toBe('tr');
    expect(c.questions.poolMultiplier).toBe(2);
    expect(c.testPatterns).toEqual(defaultConfig().testPatterns);
  });

  it('accepts a config file saved with a UTF-8 BOM', async () => {
    await writeRawConfig(`\uFEFF${JSON.stringify({ chunking: { leafMinLoc: 50 } })}`);
    expect((await loadConfig(root)).chunking.leafMinLoc).toBe(50);
  });

  it('throws ConfigError on invalid JSON', async () => {
    await writeRawConfig('{ "include": [ ');
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    ['invalid lang code', { questions: { lang: 'English' } }],
    ['leafMinLoc > leafMaxLoc', { chunking: { leafMinLoc: 300, leafMaxLoc: 100 } }],
    ['negative maxFileBytes', { maxFileBytes: -1 }],
    ['ratio out of range', { quiz: { passRatio: 1.5 } }],
    ['wrong version', { version: 2 }],
    ['wrong type', { include: 'src/**' }],
  ])('throws ConfigError for %s', async (_name, value) => {
    await writeRawConfig(JSON.stringify(value));
    await expect(loadConfig(root)).rejects.toThrow(ConfigError);
  });
});

describe('mergeConfig / resolveConfig', () => {
  it('merges overrides over a base and fills defaults', () => {
    const c = mergeConfig({ chunking: { leafMinLoc: 30 }, include: ['src/**'] }, { chunking: { leafMaxLoc: 120 }, includeTests: true });
    expect(c.chunking).toEqual({ leafMinLoc: 30, leafMaxLoc: 120, mergeBelowLoc: 15, splitAboveLoc: 300 });
    expect(c.include).toEqual(['src/**']);
    expect(c.includeTests).toBe(true);
  });

  it('arrays in the override replace the base', () => {
    expect(mergeConfig({ ignore: ['a/**'] }, { ignore: ['b/**'] }).ignore).toEqual(['b/**']);
  });

  it('validates the merged result', () => {
    expect(() => mergeConfig({ chunking: { leafMaxLoc: 50 } }, { chunking: { leafMinLoc: 60 } })).toThrow(ConfigError);
    expect(() => resolveConfig({ score: { yellowAt: 0.9, greenAt: 0.8 } })).toThrow(ConfigError);
  });
});

describe('saveConfig / initConfig', () => {
  it('initConfig writes the defaults once, pretty-printed', async () => {
    expect(await initConfig(root)).toBe(true);
    const raw = await readFile(join(root, '.gotchea', 'config.json'), 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "version": 1,');
    expect(await loadConfig(root)).toEqual(defaultConfig());
    expect(await initConfig(root)).toBe(false);
  });

  it('initConfig does not overwrite an existing config', async () => {
    await saveConfig(root, { includeTests: true });
    expect(await initConfig(root)).toBe(false);
    expect((await loadConfig(root)).includeTests).toBe(true);
  });

  it('saveConfig round-trips through loadConfig', async () => {
    await saveConfig(root, { chunking: { leafMinLoc: 25 }, ignore: ['legacy/**'], questions: { lang: 'tr' } });
    const c = await loadConfig(root);
    expect(c.chunking.leafMinLoc).toBe(25);
    expect(c.ignore).toEqual(['legacy/**']);
    expect(c.questions.lang).toBe('tr');
    expect(await readFile(join(root, '.gotchea', 'config.json'), 'utf8')).toBe(
      `${JSON.stringify({ chunking: { leafMinLoc: 25 }, ignore: ['legacy/**'], questions: { lang: 'tr' } }, null, 2)}\n`,
    );
  });
});
