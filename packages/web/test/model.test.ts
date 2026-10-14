import { describe, expect, it } from 'vitest';
import { closestExisting, colorCounts, commandsFor, findNode, formatDue, formatR, hashFor, idFromHash, isEmptyMap, pathTo, shellQuote } from '../src/model.js';
import { node, sampleMap } from './helpers.js';

describe('model', () => {
  const root = sampleMap().root;

  it('finds nodes and the breadcrumb trail', () => {
    expect(findNode(root, 'src/math.ts#mean')?.loc).toBe(18);
    expect(findNode(root, 'nope')).toBeNull();
    expect(pathTo(root, 'src/math.ts#mean').map((n) => n.id)).toEqual(['.', 'src', 'src/math.ts', 'src/math.ts#mean']);
    expect(pathTo(root, 'nope')).toEqual([]);
  });

  it('falls back to the closest surviving ancestor', () => {
    expect(closestExisting(root, 'src/math.ts#gone').id).toBe('src/math.ts');
    expect(closestExisting(root, 'src/deleted/x.ts').id).toBe('src');
    expect(closestExisting(root, 'elsewhere.ts').id).toBe('.');
  });

  it('counts leaves per colour like the CLI legend', () => {
    expect(colorCounts(root)).toEqual({ red: 1, yellow: 0, green: 1, grey: 3 });
    expect(colorCounts(findNode(root, 'src/math.ts')!)).toEqual({ red: 1, yellow: 0, green: 1, grey: 0 });
  });

  it('round-trips ids through the URL hash, including # and spaces', () => {
    expect(hashFor('.')).toBe('#/');
    expect(hashFor('src/auth/session.ts')).toBe('#/src/auth/session.ts');
    for (const id of ['.', 'src/auth/session.ts', 'src/a.ts#Store.refresh', 'src/my file.ts#~group:clamp', 'ü/ß.py']) {
      expect(idFromHash(hashFor(id))).toBe(id);
    }
    expect(idFromHash('')).toBe('.');
    expect(idFromHash('#/%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('formats R and due dates', () => {
    expect(formatR(null)).toBe('–');
    expect(formatR(0.854)).toBe('85%');
    const now = new Date('2026-10-14T12:00:00Z');
    expect(formatDue(null, now)).toBe('–');
    expect(formatDue('garbage', now)).toBe('–');
    expect(formatDue('2026-11-01T00:00:00.000Z', now)).toBe('2026-11-01');
    expect(formatDue('2026-10-01T00:00:00.000Z', now)).toBe('2026-10-01 (due now)');
  });

  it('builds copyable commands: quiz for leaves, generate for grey leaves, nothing for parents', () => {
    expect(commandsFor(findNode(root, 'src/math.ts#clamp')!).map((c) => c.command)).toEqual(["gotchea quiz 'src/math.ts#clamp'"]);
    expect(commandsFor(findNode(root, 'src/util.ts')!).map((c) => c.command)).toEqual([
      'gotchea quiz src/util.ts',
      'gotchea generate --chunk src/util.ts',
    ]);
    expect(commandsFor(findNode(root, 'src')!)).toEqual([]);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('treats a root without chunks or code as empty', () => {
    expect(isEmptyMap(root)).toBe(false);
    expect(isEmptyMap(node({ id: '.', children: [], isLeaf: false }))).toBe(true);
    expect(isEmptyMap(node({ id: '.', children: [node({ id: 'a.ts', loc: 0 })] }))).toBe(true);
  });
});
