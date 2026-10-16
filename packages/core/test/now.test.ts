import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore, QuizSessions, now } from '../src/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('application clock', () => {
  it('uses wall time when the override is absent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    expect(now({}).toISOString()).toBe('2026-10-16T12:00:00.000Z');
  });

  it.each([
    ['2026-10-16T12:00:00Z', '2026-10-16T12:00:00.000Z'],
    ['2026-10-16T15:00:00+03:00', '2026-10-16T12:00:00.000Z'],
    ['2026-10-16', '2026-10-16T00:00:00.000Z'],
    ['0', '1970-01-01T00:00:00.000Z'],
    ['-1', '1969-12-31T23:59:59.999Z'],
    [' 1792152000000 ', '2026-10-16T12:00:00.000Z'],
  ])('accepts %s', (input, expected) => {
    expect(now({ GOTCHEA_NOW: input }).toISOString()).toBe(expected);
  });

  it.each(['', 'tomorrow', '10/16/2026', '2026-10-16T12:00:00', 'Infinity', '99999999999999999999'])('rejects invalid or ambiguous time %j', (input) => {
    expect(() => now({ GOTCHEA_NOW: input })).toThrow('GOTCHEA_NOW');
  });

  it('reads the environment on each call and returns independent dates', () => {
    vi.stubEnv('GOTCHEA_NOW', '0');
    now().setUTCFullYear(2000);
    expect(now().getTime()).toBe(0);
    vi.stubEnv('GOTCHEA_NOW', '1000');
    expect(now().getTime()).toBe(1000);
  });

  it('uses the central default for session creation and expiry, while injected clocks win', async () => {
    vi.stubEnv('GOTCHEA_NOW', '2026-10-16T12:00:00Z');
    const opts = { store: new InMemorySessionStore(), ttlMs: 60_000, retentionMs: 3_600_000 };
    const sessions = new QuizSessions(opts);
    const input = { origin: 'mcp' as const, chunkId: 'src/math.ts', chunkHash: 'h', lang: 'en', questionIds: ['q1'] };
    const session = await sessions.create(input);
    expect(session.startedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(session.expiresAt).toBe('2026-10-16T12:01:00.000Z');
    const injected = new QuizSessions({ ...opts, now: () => new Date(0) });
    expect((await injected.create(input)).startedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
