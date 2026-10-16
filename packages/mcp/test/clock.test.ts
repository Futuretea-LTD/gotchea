import { expect, it } from 'vitest';
import { createToolContext } from '../src/context.js';

it('uses the supplied server environment for time and preserves explicit clock injection', () => {
  const env = { GOTCHEA_NOW: '2026-10-16T12:00:00Z' };
  expect(createToolContext({ env }).now().toISOString()).toBe('2026-10-16T12:00:00.000Z');
  expect(createToolContext({ env, now: () => new Date(0) }).now().getTime()).toBe(0);
});
