import { FORBIDDEN_KEYS as ANSWER_KEYS } from 'gotchea-core';
import { describe, expect, it } from 'vitest';
import { createPoller, fetchStatus, parseStatus } from '../src/api.js';
import { fakeServer, sampleMap, sampleStatus } from './helpers.js';

describe('status counters', () => {
  it('loads the existing status endpoint and copies only its known fields', async () => {
    const server = fakeServer(sampleMap());
    expect(await fetchStatus(server.fetch)).toEqual(sampleStatus());
    expect(server.requests.map((r) => r.url)).toEqual(['/api/status']);
    expect(parseStatus({ ...sampleStatus(), extra: 'ignored', colors: { ...sampleStatus().colors, extra: 20 } })).toEqual(sampleStatus());
  });

  it.each([null, [], {}, { ...sampleStatus(), leaves: -1 }, { ...sampleStatus(), due: Number.NaN },
    { ...sampleStatus(), colors: null }, { ...sampleStatus(), colors: { grey: 0 } },
    { ...sampleStatus(), version: 2 }, { ...sampleStatus(), generatedAt: 2 }, { ...sampleStatus(), scanned: 'yes' },
  ])('rejects invalid counters (%j)', (value) => {
    expect(parseStatus(value)).toBeNull();
  });

  it('returns no update on network or HTTP failure, or invalid JSON', async () => {
    const server = fakeServer(sampleMap(), 'error');
    expect(await fetchStatus(server.fetch)).toBeNull();
    server.set('offline');
    expect(await fetchStatus(server.fetch)).toBeNull();
    expect(await fetchStatus(async () => new Response('{'))).toBeNull();
  });
});

const FORBIDDEN_KEYS = [...ANSWER_KEYS, 'options', 'stem'];

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

describe('fetch answer-key isolation', () => {
  it.each(FORBIDDEN_KEYS)('drops %s from status responses at every depth', async (key) => {
    const body = {
      ...sampleStatus(),
      [key]: 'PRIVATE-QUESTION-DATA',
      colors: { ...sampleStatus().colors, nested: [{ [key]: 'PRIVATE-QUESTION-DATA' }] },
    };
    const result = await fetchStatus(async () => Response.json(body));
    expect(result).toEqual(sampleStatus());
    expect(keysOf(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-QUESTION-DATA');
  });

  it.each(FORBIDDEN_KEYS)('rejects map responses containing %s at any depth', async (key) => {
    const map = sampleMap();
    const payloads = [
      { ...map, [key]: 'PRIVATE-QUESTION-DATA' },
      { ...map, root: { ...map.root, [key]: 'PRIVATE-QUESTION-DATA' } },
      { ...map, extra: [{ metadata: { [key]: 'PRIVATE-QUESTION-DATA' } }] },
      { ...map, root: { ...map.root, state: { ...map.root.state, [key]: 'PRIVATE-QUESTION-DATA' } } },
    ];
    for (const body of payloads) {
      const poller = createPoller(async () => Response.json(body), 3000, globalThis as never);
      const result = await poller.poll();
      expect(result).toEqual({ kind: 'offline', message: 'Server returned an unsafe map.' });
      expect(keysOf(result)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain('PRIVATE-QUESTION-DATA');
    }
  });

  it('keeps the last safe ETag when rejecting a map and recovers on a safe response', async () => {
    const headers: Record<string, string>[] = [];
    const bodies = [sampleMap(), { ...sampleMap(), explanation: 'PRIVATE-QUESTION-DATA' }, sampleMap()];
    const poller = createPoller(async (_url, init) => {
      headers.push(init.headers);
      return Response.json(bodies.shift(), { headers: { ETag: `"v${headers.length}"` } });
    }, 3000, globalThis as never);
    expect(await poller.poll()).toEqual({ kind: 'map', map: sampleMap() });
    expect(await poller.poll()).toEqual({ kind: 'offline', message: 'Server returned an unsafe map.' });
    expect(await poller.poll()).toEqual({ kind: 'map', map: sampleMap() });
    expect(headers).toEqual([{}, { 'If-None-Match': '"v1"' }, { 'If-None-Match': '"v1"' }]);
  });

  it('does not forward arbitrary error bodies or rejected fetch messages', async () => {
    for (const status of [404, 500]) {
      const poller = createPoller(async () => Response.json({ options: ['PRIVATE-QUESTION-DATA'], stem: 'private', correctIndex: 0, explanation: 'private' }, { status }), 3000, globalThis as never);
      expect(await poller.poll()).toEqual({ kind: 'offline', message: `Server answered ${status}.` });
    }
    const poller = createPoller(async () => { throw new Error('PRIVATE-QUESTION-DATA'); }, 3000, globalThis as never);
    expect(await poller.poll()).toEqual({ kind: 'offline', message: 'Lost connection to `gotchea serve`.' });
  });
});
