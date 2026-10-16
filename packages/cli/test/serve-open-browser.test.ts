// The default browser launcher of `gotchea serve` (openBrowser in commands/serve.ts): per-platform
// command, detached + unref'd, and "best effort" (a missing opener or a throwing spawn is not an error).
// The other serve tests inject `openUrl`; here `child_process.spawn` is mocked so nothing is launched.
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandbox, type Sandbox } from './helpers.js';
import { makeWebRoot, type WebRoot } from './serve-helpers.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: spawnMock }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { ...platform, value });

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

let s: Sandbox;
let web: WebRoot;

beforeEach(async () => {
  spawnMock.mockReset();
  s = await createSandbox();
  web = await makeWebRoot();
  await s.gotchea(['init']);
  await writeFile(join(s.root, '.gotchea', 'config.json'), '{}');
  expect((await s.gotchea(['scan'])).code).toBe(0);
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  await web.cleanup();
  await s.cleanup();
});

/** Runs `gotchea serve` with the real launcher; returns the served URL once it has been stopped. */
async function serveOpening(args: string[] = []): Promise<{ code: number; stderr: string; url: string }> {
  const ac = new AbortController();
  let url = '';
  const r = await s.gotchea(['serve', '--port', '0', ...args], {
    deps: {
      serve: {
        webRoot: web.dir,
        signal: ac.signal,
        onListening: (server) => {
          url = server.url;
          queueMicrotask(() => ac.abort()); // openBrowser runs right after this callback
        },
      },
    },
  });
  return { code: r.code, stderr: r.stderr, url };
}

describe('gotchea serve: default browser launcher', () => {
  it.each([
    ['darwin', 'open', (u: string) => [u]],
    ['linux', 'xdg-open', (u: string) => [u]],
    ['win32', 'cmd', (u: string) => ['/c', 'start', '""', u]],
  ])('on %s runs %s detached with the server URL', async (plat, cmd, args) => {
    spawnMock.mockImplementation(() => new FakeChild());
    setPlatform(plat);
    const r = await serveOpening();
    expect(r.code, r.stderr).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [c, a, o] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(c).toBe(cmd);
    expect(a).toEqual(args(r.url));
    expect(o).toMatchObject({ detached: true, stdio: 'ignore', windowsVerbatimArguments: plat === 'win32' });
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/); // loopback only: nothing else is ever handed to the opener
    const child = spawnMock.mock.results[0]!.value as FakeChild;
    expect(child.unref).toHaveBeenCalled(); // the browser must not keep gotchea alive
  });

  it('a missing opener (async "error" event, e.g. no xdg-open on a headless box) is swallowed', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    setPlatform('linux');
    const r = await serveOpening();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(child.listenerCount('error')).toBeGreaterThan(0); // else Node would crash on the unhandled 'error'
  });

  it('a synchronously throwing spawn is swallowed too', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const r = await serveOpening();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('--no-open never spawns', async () => {
    const r = await serveOpening(['--no-open']);
    expect(r.code, r.stderr).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
