import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPoller } from '../src/api.js';
import { mountApp, type App } from '../src/app.js';
import { fakeServer, sampleMap, type FakeServer } from './helpers.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
let host: HTMLElement;
let app: App | null;

beforeEach(() => {
  window.location.hash = '';
  host = document.createElement('div');
  document.body.replaceChildren(host);
  app = null;
});

afterEach(() => {
  app?.destroy();
});

async function mount(server: FakeServer): Promise<App> {
  app = mountApp(host, { fetch: server.fetch, window, now: () => NOW, pollMs: 0 });
  await app.refresh();
  return app;
}

/** Sets the hash and waits for the hashchange event to re-render. */
async function navigate(hash: string): Promise<void> {
  const changed = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
  window.location.hash = hash;
  await changed;
}

async function hashChange(action: () => void): Promise<void> {
  const changed = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
  action();
  await changed;
}

const crumbs = () => [...host.querySelectorAll('.crumbs li')].map((li) => li.textContent);
const cellIds = () => [...host.querySelectorAll<HTMLElement>('.cell')].map((c) => c.dataset['id']);
const rowIds = () => [...host.querySelectorAll<HTMLElement>('.children tbody tr')].map((r) => r.dataset['id']);
const cell = (id: string) => host.querySelector<HTMLElement>(`.cell[data-id="${id}"]`)!;
const panelText = () => host.querySelector('.panel')!.textContent!;

describe('empty states', () => {
  it('shows the "run gotchea scan" screen when chunks.json is missing', async () => {
    await mount(fakeServer('not_scanned'));
    expect(host.querySelector('.empty')?.textContent).toContain('gotchea scan');
    expect(host.querySelector('.treemap')).toBeNull();
  });

  it('shows it for a scanned but empty repo, then the map once a scan lands', async () => {
    const empty = sampleMap();
    empty.root.children = [];
    empty.root.loc = 0;
    const server = fakeServer(empty);
    const a = await mount(server);
    expect(host.querySelector('.empty')?.textContent).toContain('gotchea scan');
    server.set(sampleMap());
    await a.refresh();
    expect(host.querySelector('.empty')).toBeNull();
    expect(cellIds()).toEqual(['src', 'app.py']);
  });
});

describe('treemap and drill-down', () => {
  it('lays out the root children by LOC; 0-LOC chunks are listed but get no cell', async () => {
    await mount(fakeServer(sampleMap()));
    expect(crumbs()).toEqual(['repo']);
    expect(cellIds()).toEqual(['src', 'app.py']);
    await navigate('#/src');
    expect(cellIds()).toEqual(['src/math.ts', 'src/util.ts']);
    expect(rowIds()).toEqual(['src/math.ts', 'src/util.ts', 'src/empty.ts']);
    // Text next to colour: every cell carries its state mark and an accessible label.
    expect(cell('src/util.ts').querySelector('.mark')?.textContent).toBe('–');
    expect(cell('src/util.ts').getAttribute('aria-label')).toBe('util.ts, file, grey, R –, 20 LOC, 0 of 3 questions');
    const style = cell('src/math.ts').style;
    expect(Number.parseFloat(style.width) * Number.parseFloat(style.height)).toBeGreaterThan(0);
  });

  it('clicking a module drills in, the breadcrumb follows, and back returns', async () => {
    await mount(fakeServer(sampleMap()));
    await hashChange(() => cell('src').click());
    expect(window.location.hash).toBe('#/src');
    expect(crumbs()).toEqual(['repo', 'src/']);
    await hashChange(() => cell('src/math.ts').click());
    expect(window.location.hash).toBe('#/src/math.ts');
    expect(crumbs()).toEqual(['repo', 'src/', 'math.ts']);
    expect(cellIds()).toEqual(['src/math.ts#mean', 'src/math.ts#clamp']);

    await hashChange(() => window.history.back());
    expect(crumbs()).toEqual(['repo', 'src/']);
    // Breadcrumb links are plain hash links.
    expect(host.querySelector<HTMLAnchorElement>('.crumbs a')!.getAttribute('href')).toBe('#/');
  });

  it('a leaf in the hash is shown selected inside its parent, with its details and commands', async () => {
    window.location.hash = '#/src/math.ts%23clamp';
    await mount(fakeServer(sampleMap()));
    expect(crumbs()).toEqual(['repo', 'src/', 'math.ts', 'clamp']);
    expect(cellIds()).toEqual(['src/math.ts#mean', 'src/math.ts#clamp']);
    expect(cell('src/math.ts#clamp').classList.contains('selected')).toBe(true);
    expect(cell('src/math.ts#clamp').tabIndex).toBe(0);
    const text = panelText();
    for (const s of ['src/math.ts#clamp', 'symbol', '12', '95%', '2026-11-01', '6/3', "gotchea quiz 'src/math.ts#clamp'"]) expect(text).toContain(s);
    expect(text).not.toContain('gotchea generate');
  });

  it('a grey leaf offers generate; the panel follows the hovered/focused cell', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src');
    cell('src/util.ts').dispatchEvent(new Event('focusin', { bubbles: true }));
    expect(panelText()).toContain('gotchea generate --chunk src/util.ts');
    expect(panelText()).toContain('Selected: src/');
  });

  it('falls back to the closest ancestor when the hashed chunk no longer exists', async () => {
    window.location.hash = '#/src/math.ts%23gone';
    await mount(fakeServer(sampleMap()));
    expect(crumbs()).toEqual(['repo', 'src/', 'math.ts']);
  });

  it('copies a command to the clipboard', async () => {
    const copied: string[] = [];
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    window.location.hash = '#/app.py';
    await mount(fakeServer(sampleMap()));
    const button = host.querySelector<HTMLButtonElement>('button.copy')!;
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toEqual(['gotchea quiz app.py']);
    expect(button.textContent).toBe('Copied');
  });
});

describe('keyboard', () => {
  it('arrow keys move a roving focus between cells, Backspace goes up a level', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/math.ts');
    const first = cell('src/math.ts#mean');
    expect(first.tabIndex).toBe(0);
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const second = cell('src/math.ts#clamp');
    expect(document.activeElement).toBe(second);
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(second);

    await hashChange(() => second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
    expect(window.location.hash).toBe('#/src');
  });
});

describe('live refresh', () => {
  it('sends If-None-Match, keeps the DOM on 304 and re-renders on change', async () => {
    const server = fakeServer(sampleMap());
    const a = await mount(server);
    const before = host.querySelector('.treemap');
    await a.refresh();
    expect(server.requests[1]!.headers['If-None-Match']).toBe('"v0"');
    expect(host.querySelector('.treemap')).toBe(before);

    const next = sampleMap();
    next.root.children[1]!.state = { color: 'green', R: 0.9, dueAt: null };
    server.set(next);
    await a.refresh();
    expect(host.querySelector('.treemap')).not.toBe(before);
    expect(cell('app.py').dataset['color']).toBe('green');
  });

  it('keeps the last map while offline and clears the notice when the server is back', async () => {
    const server = fakeServer(sampleMap());
    const a = await mount(server);
    server.set('offline');
    await a.refresh();
    expect(host.querySelector('.live')?.textContent).toContain('Lost connection');
    expect(cellIds()).toEqual(['src', 'app.py']);
    server.set(sampleMap());
    await a.refresh();
    expect(host.querySelector('.live')?.textContent).toBe('');
  });

  it('polls on a timer until stopped', async () => {
    const server = fakeServer(sampleMap());
    const updates: string[] = [];
    const poller = createPoller(server.fetch, 5, globalThis as never);
    poller.start((u) => updates.push(u.kind));
    await new Promise((r) => setTimeout(r, 40));
    poller.stop();
    const seen = server.requests.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBeGreaterThan(2);
    expect(server.requests.length).toBe(seen);
    expect(updates).toEqual(['map']);
  });
});
