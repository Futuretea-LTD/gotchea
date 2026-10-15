import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from 'gotchea-core';
import { createProgram } from '../src/program.js';
import { createSandbox, type Sandbox } from './helpers.js';

let s: Sandbox;

beforeEach(async () => {
  s = await createSandbox();
});

afterEach(async () => {
  await s.cleanup();
});

describe('gotchea program', () => {
  it('prints help listing every command', async () => {
    const r = await s.gotchea(['--help']);
    expect(r.code).toBe(0);
    for (const cmd of ['init', 'scan', 'map', 'mcp', 'generate', 'quiz', 'status', 'serve']) expect(r.stdout).toContain(cmd);
    expect(r.stdout).toContain('--cwd <dir>');
  });

  it('prints the version', async () => {
    const r = await s.gotchea(['--version']);
    expect(r).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
  });

  it('fails on unknown commands and options with the usage exit code', async () => {
    const unknown = await s.gotchea(['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'nope'");
    const badOpt = await s.gotchea(['map', '--bogus']);
    expect(badOpt.code).toBe(2);
    expect(badOpt.stderr).toContain('--bogus');
    expect((await s.gotchea(['map', 'a', 'b'])).code).toBe(2);
    expect((await s.gotchea(['quiz', '--count'])).code).toBe(2);
    expect((await s.gotchea([])).code).toBe(2);
  });

  it('registers exactly the implemented commands, with no stubs', async () => {
    const names = createProgram().commands.map((c) => c.name());
    expect(names.sort()).toEqual(['generate', 'init', 'map', 'mcp', 'quiz', 'scan', 'serve', 'status']);
    expect((await s.gotchea(['--help'])).stdout).not.toContain('not implemented');
    for (const name of names) expect((await s.gotchea([name, '--help'])).stdout).not.toContain('not implemented');
  });

  it('resolves --cwd against the working directory, before or after the command', async () => {
    const parent = join(s.root, '..');
    const name = s.root.slice(parent.length + 1);
    expect((await s.gotchea(['--cwd', name, 'init'], { cwd: parent })).code).toBe(0);
    expect((await s.gotchea(['scan', '--cwd', s.root], { cwd: '/' })).code).toBe(0);
  });

  it('rejects a --cwd that is not a directory', async () => {
    const r = await s.gotchea(['--cwd', join(s.root, 'missing'), 'init']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: --cwd: not a directory/);
  });

  it('finds the initialized root from a subdirectory', async () => {
    await s.gotchea(['init']);
    const sub = join(s.root, 'src', 'format');
    await mkdir(sub, { recursive: true });
    expect((await s.gotchea(['scan'], { cwd: sub })).code).toBe(0);
    // Paths are relative to the working directory.
    const map = await s.gotchea(['map', 'strings.ts', '--json'], { cwd: sub });
    expect(JSON.parse(map.stdout).filter).toBe('src/format/strings.ts');
  });

  it('reports invalid config as an error', async () => {
    await s.gotchea(['init']);
    await writeFile(join(s.root, '.gotchea', 'config.json'), '{ "chunking": { "leafMaxLoc": "big" } }');
    const r = await s.gotchea(['scan']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid gotchea config: chunking.leafMaxLoc');
  });
});
