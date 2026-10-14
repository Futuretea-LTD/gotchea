import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from 'gotchea-core';
import { STUB_COMMANDS } from '../src/commands/stubs.js';
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

  it('fails on unknown commands and options', async () => {
    const unknown = await s.gotchea(['nope']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("unknown command 'nope'");
    const badOpt = await s.gotchea(['map', '--bogus']);
    expect(badOpt.code).not.toBe(0);
    expect(badOpt.stderr).toContain('--bogus');
  });

  it('has no stub commands left', async () => {
    expect(STUB_COMMANDS).toEqual([]);
    expect((await s.gotchea(['--help'])).stdout).not.toContain('not implemented');
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
