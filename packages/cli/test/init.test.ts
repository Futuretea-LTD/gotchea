import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRepoId, defaultConfig, userPaths } from 'gotchea-core';
import { createSandbox, type Sandbox } from './helpers.js';

let s: Sandbox;
const configPath = () => join(s.root, '.gotchea', 'config.json');

beforeEach(async () => {
  s = await createSandbox();
});

afterEach(async () => {
  await s.cleanup();
});

describe('gotchea init', () => {
  it('writes the default config and the questions directory', async () => {
    const r = await s.gotchea(['init']);
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual(defaultConfig());
    await access(join(s.root, '.gotchea', 'questions', '.gitkeep'));
    expect(r.stdout).toContain('Wrote .gotchea/config.json');
    expect(r.stdout).toContain('is not git-ignored');
    expect(r.stderr).toBe('');
  });

  it('prints where personal progress will live', async () => {
    const r = await s.gotchea(['init']);
    const repoId = await computeRepoId(s.root);
    expect(r.stdout).toContain(userPaths(repoId, s.env).repoDir);
    expect(userPaths(repoId, s.env).repoDir.startsWith(s.home)).toBe(true);
  });

  it('is idempotent and keeps an existing config unless --force', async () => {
    await s.gotchea(['init']);
    await writeFile(configPath(), '{ "includeTests": true }\n');

    const again = await s.gotchea(['init']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Kept existing .gotchea/config.json');
    expect(await readFile(configPath(), 'utf8')).toBe('{ "includeTests": true }\n');

    const forced = await s.gotchea(['init', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('overwritten by --force');
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual(defaultConfig());
  });

  it('warns when .gotchea/ is git-ignored, naming the rule', async () => {
    await writeFile(join(s.root, '.gitignore'), 'node_modules/\n.gotchea/\n');
    const r = await s.gotchea(['init']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('warning: .gotchea/ is ignored by git');
    expect(r.stderr).toContain('.gotchea/config.json is ignored (.gitignore:2: .gotchea/)');
    expect(r.stdout).not.toContain('is not git-ignored');
  });

  it('does not warn when the rule is negated', async () => {
    await writeFile(join(s.root, '.gitignore'), '.gotchea/*\n!.gotchea/config.json\n!.gotchea/chunks.json\n!.gotchea/questions/\n');
    const r = await s.gotchea(['init']);
    expect(r.stderr).toBe('');
  });
});
