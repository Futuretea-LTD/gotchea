import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller } from '../src/api.js';
import { CELL_GAP, mountApp, type App } from '../src/app.js';
import { COLORS, RETENTION_SCALE, colorCounts, findNode } from '../src/model.js';
import { fakeServer, node, sampleMap, sampleStatus, type FakeServer } from './helpers.js';

const shell = readFileSync(resolve('packages/web/index.html'), 'utf8');
const theme = readFileSync(resolve('packages/web/src/style.css'), 'utf8');

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
  vi.restoreAllMocks();
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
    expect(cell('src/util.ts').getAttribute('aria-label')).toBe('util.ts, file, – grey, R –, 20 LOC, 0 of 3 questions');
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

  it('a selected grey leaf retains both Copy command buttons while hovering preserves selection', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/util.ts');
    const commands = [...host.querySelectorAll<HTMLButtonElement>('.panel .copy')].map((b) => b.dataset['command']);
    expect(commands).toEqual(['gotchea quiz src/util.ts', 'gotchea generate --chunk src/util.ts']);
    cell('src/math.ts').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(host.querySelector('.panel')?.getAttribute('data-id')).toBe('src/util.ts');
    expect(panelText()).toContain('gotchea generate --chunk src/util.ts');
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

describe('retention card', () => {
  it('fills cells with the five retention tiers and marks no-question cells as none', async () => {
    const map = sampleMap();
    map.root = node({
      id: '.', title: 'repo', children: [
        ...[0.1, 0.3, 0.5, 0.7, 0.9].map((R, i) => node({ id: `tier${i}.ts`, loc: 10, color: 'yellow', R })),
        node({ id: 'none.ts', loc: 10, color: 'grey', R: 0.9 }),
      ],
    });
    await mount(fakeServer(map));
    for (const [tier, color] of RETENTION_SCALE.entries()) {
      const c = cell(`tier${tier}.ts`);
      const expected = document.createElement('span');
      expected.style.backgroundColor = color;
      expect(c.style.backgroundColor).toBe(expected.style.backgroundColor);
      expect(c.dataset['tier']).toBe(String(tier));
      expect(c.classList.contains('none')).toBe(false);
    }
    expect(cell('none.ts').classList.contains('none')).toBe(true);
    expect(cell('none.ts').dataset['tier']).toBeUndefined();
  });

  it('uses borderless scale cells and a layout gutter of six pixels', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/math.ts');
    const first = cell('src/math.ts#mean');
    const second = cell('src/math.ts#clamp');
    // happy-dom does not resolve border shorthands reliably, so check the actual rule.
    const cellRule = theme.match(/\.cell\s*\{([^}]+)\}/)?.[1];
    expect(cellRule).toMatch(/border:\s*0\s*;/);
    const right = Number.parseFloat(first.style.left) + Number.parseFloat(first.style.width);
    const gapPx = (Number.parseFloat(second.style.left) - right) * 960 / 100;
    expect(gapPx).toBeCloseTo(6);
    expect(CELL_GAP).toBeGreaterThanOrEqual(6);
    expect(CELL_GAP).toBeLessThanOrEqual(8);
    await navigate('#/src');
    expect(cell('src/util.ts').classList.contains('none')).toBe(true);
    expect(theme.match(/\.cell\.none\s*\{([^}]+)\}/)?.[1]).toMatch(/border:[^;]*dashed/);
  });

  it('hides names that cannot fit while retaining their accessible labels', async () => {
    const map = sampleMap();
    map.root = node({ id: '.', title: 'repo', children: [
      node({ id: 'large.ts', loc: 100000, color: 'red' }),
      node({ id: 'tiny.ts', loc: 1, color: 'grey' }),
    ] });
    await mount(fakeServer(map));
    expect(cell('large.ts').querySelector('.name')?.textContent).toBe('large.ts');
    expect(cell('tiny.ts').querySelector('.name')).toBeNull();
    expect(cell('tiny.ts').classList.contains('no-label')).toBe(true);
    expect(cell('tiny.ts').getAttribute('aria-label')).toContain('tiny.ts');
    expect(cell('large.ts').children).toHaveLength(1);
  });

  it('hides a long name even when the cell could fit its first few characters', async () => {
    const map = sampleMap();
    map.root = node({ id: '.', children: [
      node({ id: 'a.ts', loc: 10, color: 'red' }),
      node({ id: 'b.ts', title: 'a'.repeat(100), loc: 10, color: 'red' }),
    ] });
    await mount(fakeServer(map));
    expect(cell('a.ts').querySelector('.name')).not.toBeNull();
    expect(cell('b.ts').querySelector('.name')).toBeNull();
    expect(cell('b.ts').getAttribute('aria-label')).toContain('a'.repeat(100));
  });

  it('carries every state marker in cell aria-labels', async () => {
    const map = sampleMap();
    map.root = node({ id: '.', children: [
      node({ id: 'red.ts', loc: 10, color: 'red' }),
      node({ id: 'yellow.ts', loc: 10, color: 'yellow', R: 0.5 }),
      node({ id: 'green.ts', loc: 10, color: 'green', R: 0.9 }),
      node({ id: 'grey.ts', loc: 10, color: 'grey' }),
    ] });
    await mount(fakeServer(map));
    for (const [color, marker] of [['red', '!'], ['yellow', '~'], ['green', '✓'], ['grey', '–']]) {
      expect(cell(`${color}.ts`).getAttribute('aria-label')).toContain(`${marker} ${color}`);
    }
  });

  it('shows name, marker, LOC, retention, question ratio and due on hover and keyboard focus', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/math.ts');
    const target = cell('src/math.ts#clamp');
    const tip = host.querySelector<HTMLElement>('.tooltip')!;
    expect(tip.hidden).toBe(true);
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip.hidden).toBe(false);
    expect(tip.querySelector('.tip-title')?.textContent).toBe('✓ clamp');
    expect([...tip.querySelectorAll('.tip-row')].map((row) => [...row.children].map((n) => n.textContent))).toEqual([
      ['State', '✓ green'], ['LOC', '12'], ['R', '95%'], ['Questions', '6/3'], ['Due', '2026-11-01'],
    ]);
    expect(tip.style.left).toMatch(/%$/);
    host.dispatchEvent(new MouseEvent('mouseleave'));
    expect(tip.hidden).toBe(true);
    target.focus();
    expect(tip.hidden).toBe(false);
    expect(tip.dataset['id']).toBe('src/math.ts#clamp');
    target.blur();
    expect(tip.hidden).toBe(true);
  });

  it('aligns the tooltip to the cell when centring it would overflow the treemap edge', async () => {
    const map = sampleMap();
    map.root = node({ id: '.', title: 'repo', children: Array.from({ length: 40 }, (_, i) => node({ id: `f${i}.ts`, loc: 5 + i * 7 })) });
    await mount(fakeServer(map));
    const tip = host.querySelector<HTMLElement>('.tooltip')!;
    // No layout in happy-dom: the 960px fallback treemap and the 260px fallback tooltip width.
    const seen = new Set<string>();
    for (const c of host.querySelectorAll<HTMLElement>('.cell')) {
      c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const cx = ((Number.parseFloat(c.style.left) + Number.parseFloat(c.style.width) / 2) / 100) * 960;
      const expected = cx < 130 ? 'align-start' : cx > 960 - 130 ? 'align-end' : 'centred';
      expect(tip.classList.contains('align-start')).toBe(expected === 'align-start');
      expect(tip.classList.contains('align-end')).toBe(expected === 'align-end');
      seen.add(expected);
    }
    expect([...seen].sort()).toEqual(['align-end', 'align-start', 'centred']);
  });

  it('renders five labeled swatches, no questions and visible state counts', async () => {
    await mount(fakeServer(sampleMap()));
    const swatches = [...host.querySelectorAll<HTMLElement>('.swatches .swatch')];
    expect(swatches).toHaveLength(5);
    expect(swatches.map((s) => s.dataset['tier'])).toEqual(['0', '1', '2', '3', '4']);
    expect(host.querySelector('.scale')?.getAttribute('aria-label')).toContain('Retention');
    expect([...host.querySelectorAll('.scale-end')].map((s) => s.textContent)).toEqual(['Low', 'High']);
    expect(host.querySelector('.legend-none')?.textContent).toBe('– no questions (3)');
    for (const [color, count] of [['red', '1'], ['yellow', '0'], ['green', '1']]) {
      expect(host.querySelector(`.counts [data-color="${color}"] .count`)?.textContent).toBe(count);
    }
  });

  it('renders repository stats from status, independently of map counters', async () => {
    const server = fakeServer(sampleMap(), sampleStatus());
    await mount(server);
    expect(server.requests.some((r) => r.url === '/api/status')).toBe(true);
    for (const [key, value] of [['leaves', '8'], ['green', '38%'], ['due', '2'], ['questions', '24']]) {
      expect(host.querySelector(`[data-stat="${key}"] .stat-value`)?.textContent).toBe(value);
    }
    expect(host.querySelector('[data-stat="green"] .badge')?.textContent).toBe('✓ 3 of 8');
  });

  it('navigates the breadcrumb levels through the scope selector and updates the hash', async () => {
    window.location.hash = '#/src/math.ts%23clamp';
    await mount(fakeServer(sampleMap()));
    const select = host.querySelector<HTMLSelectElement>('.scope-select')!;
    expect(select.getAttribute('aria-label')).toBe('Scope');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['.', 'repo'], ['src', 'src/'], ['src/math.ts', 'math.ts'], ['src/math.ts#clamp', 'clamp'],
    ]);
    expect(select.value).toBe('src/math.ts#clamp');
    await hashChange(() => {
      select.value = 'src';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(window.location.hash).toBe('#/src');
    expect(crumbs()).toEqual(['repo', 'src/']);
    expect(host.querySelector<HTMLSelectElement>('.scope-select')?.value).toBe('src');
  });

  it('keeps the shell and DOM construction free of markup and setAttribute style writes', async () => {
    expect(shell).not.toMatch(/\sstyle\s*=/i);
    const writes: string[] = [];
    const original = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
      if (name.toLowerCase() === 'style') writes.push(new Error().stack ?? '');
      original.call(this, name, value);
    });
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/math.ts');
    cell('src/math.ts#clamp').focus();
    host.querySelector<HTMLButtonElement>('.menu-btn')!.click();
    // happy-dom implements CSSOM writes through setAttribute internally; direct callers must never do so.
    expect(writes.filter((stack) => !stack.includes('CSSStyleDeclaration'))).toEqual([]);
    // CSSOM geometry and fills remain allowed and produce browser-managed style attributes.
    expect(cell('src/math.ts#clamp').style.width).not.toBe('');
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

  it('Backspace goes up from the surviving ancestor when the hash names a removed chunk', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/math.ts%23gone');
    const focused = cell('src/math.ts#mean');
    focused.focus();
    await hashChange(() => focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
    expect(window.location.hash).toBe('#/src');
  });
});

describe('keyboard focus regressions', () => {
  function press(target: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function expectFocused(id: string): void {
    const focused = cell(id);
    expect(document.activeElement).toBe(focused);
    expect(focused.isConnected).toBe(true);
    expect(focused.hidden).toBe(false);
    expect(focused.tabIndex).toBe(0);
    expect([...host.querySelectorAll<HTMLElement>('.cell')].filter((c) => c.tabIndex === 0)).toEqual([focused]);
    expect(host.querySelector<HTMLElement>('.tooltip')?.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('.tooltip')?.dataset['id']).toBe(id);
  }

  it('moves in all four directions and keeps focus at an outer edge', async () => {
    const map = sampleMap();
    map.root = node({ id: '.', children: ['a', 'b', 'c', 'd'].map((id) => node({ id: `${id}.ts`, loc: 10 })) });
    await mount(fakeServer(map));
    cell('a.ts').focus();
    expectFocused('a.ts');
    for (const [key, from, to] of [
      ['ArrowRight', 'a.ts', 'c.ts'], ['ArrowDown', 'c.ts', 'd.ts'],
      ['ArrowLeft', 'd.ts', 'b.ts'], ['ArrowUp', 'b.ts', 'a.ts'],
    ]) {
      expect(press(cell(from!), key!).defaultPrevented).toBe(true);
      expectFocused(to!);
    }
    press(cell('a.ts'), 'ArrowUp');
    expectFocused('a.ts');
    press(cell('a.ts'), 'ArrowLeft');
    expectFocused('a.ts');
  });

  it('keeps cell focus and tooltip through replacement on a changed map and resize', async () => {
    const server = fakeServer(sampleMap());
    const a = await mount(server);
    const original = cell('app.py');
    original.focus();
    server.set(sampleMap());
    await a.refresh();
    expect(cell('app.py')).not.toBe(original);
    expectFocused('app.py');
    const box = host.querySelector<HTMLElement>('.treemap')!;
    Object.defineProperties(box, { clientWidth: { value: 800 }, clientHeight: { value: 450 } });
    window.dispatchEvent(new Event('resize'));
    expectFocused('app.py');
  });

  it('Enter activation drills in and Backspace goes up without losing keyboard focus', async () => {
    await mount(fakeServer(sampleMap()));
    const source = cell('src');
    source.focus();
    expect(source.tagName).toBe('BUTTON');
    expect(source.getAttribute('type')).toBe('button');
    await hashChange(() => {
      const event = press(source, 'Enter');
      // happy-dom does not synthesize native button activation from keyboard events.
      if (!event.defaultPrevented) source.click();
    });
    expect(window.location.hash).toBe('#/src');
    expectFocused('src/math.ts');
    await hashChange(() => press(cell('src/math.ts'), 'Backspace'));
    expect(window.location.hash).toBe('#/');
    expectFocused('src');
  });
});

describe('live refresh', () => {
  it('sends If-None-Match, keeps the DOM on 304 and re-renders on change', async () => {
    const server = fakeServer(sampleMap());
    const a = await mount(server);
    const before = host.querySelector('.treemap');
    await a.refresh();
    expect(server.requests.filter((r) => r.url === '/api/map')[1]!.headers['If-None-Match']).toBe('"v0"');
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


describe('redesign regressions', () => {
  it('restores module scope at load and synchronizes the selector after hash and history navigation', async () => {
    window.location.hash = '#/src';
    await mount(fakeServer(sampleMap()));
    expect(cellIds()).toEqual(['src/math.ts', 'src/util.ts']);
    expect(host.querySelector<HTMLSelectElement>('.scope-select')?.value).toBe('src');
    await navigate('#/src/math.ts%23mean');
    expect(host.querySelector<HTMLSelectElement>('.scope-select')?.value).toBe('src/math.ts#mean');
    expect(cell('src/math.ts#mean').getAttribute('aria-pressed')).toBe('true');
    await hashChange(() => window.history.back());
    expect(window.location.hash).toBe('#/src');
    expect(host.querySelector<HTMLSelectElement>('.scope-select')?.value).toBe('src');
    expect(cellIds()).toEqual(['src/math.ts', 'src/util.ts']);
  });

  it('keeps legend leaf counts in sync with colorCounts at every scope, including selected leaves', async () => {
    const map = sampleMap();
    await mount(fakeServer(map));
    for (const [hash, containerId] of [['#/src', 'src'], ['#/src/math.ts', 'src/math.ts'], ['#/src/math.ts%23clamp', 'src/math.ts'], ['#/', '.']]) {
      await navigate(hash!);
      const counts = colorCounts(findNode(map.root, containerId!)!);
      for (const color of COLORS) {
        const text = host.querySelector(`.legend [data-color="${color}"] .count`)?.textContent;
        expect(text, `${hash}: ${color}`).toBe(color === 'grey' ? `(${counts[color]})` : String(counts[color]));
      }
    }
  });

  it('preserves LOC area ratios in rendered cells with bounded loss from gutters', async () => {
    const map = sampleMap();
    const leaves = [60, 30, 10].map((loc) => node({ id: `loc${loc}.ts`, loc }));
    map.root = node({ id: '.', children: leaves });
    await mount(fakeServer(map));
    const area = (id: string) => {
      const { width, height } = cell(id).style;
      return Number.parseFloat(width) * Number.parseFloat(height);
    };
    for (const a of leaves) for (const b of leaves) {
      const relativeError = Math.abs(area(a.id) / area(b.id) / (a.loc / b.loc) - 1);
      // Six-pixel gutters remove a small fraction of these reasonably sized cells.
      expect(relativeError).toBeLessThan(0.05);
    }
  });

  it('does not render unknown answer data as text, attributes or embedded JSON', async () => {
    const map = sampleMap();
    const secret = { options: ['PRIVATE-OPTION'], stem: 'PRIVATE-STEM', correctIndex: 2, explanation: 'PRIVATE-EXPLANATION' };
    Object.assign(map.root.children[0]!, { extra: secret });
    const status = Object.assign(sampleStatus(), secret);
    const server = fakeServer(sampleMap());
    const a = await mount(server);
    server.set(map);
    server.setStatus(status);
    await a.refresh();
    expect(host.querySelector('.treemap')).not.toBeNull();
    expect(cellIds()).toEqual(['src', 'app.py']);
    expect(host.innerHTML).not.toMatch(/PRIVATE-|(?:options|stem|correctIndex|explanation)["']?\s*[:=]/);
    // Also cover normal selection, focus tooltips and the next clean refresh.
    server.set(sampleMap());
    await a.refresh();
    await navigate('#/src/math.ts%23clamp');
    cell('src/math.ts#clamp').focus();
    expect(host.querySelector<HTMLElement>('.tooltip')?.hidden).toBe(false);
    expect(host.innerHTML).not.toMatch(/PRIVATE-|(?:options|stem|correctIndex|explanation)["']?\s*[:=]/);
    expect(server.requests.map((r) => r.url).every((url) => ['/api/map', '/api/status'].includes(url))).toBe(true);
    expect(JSON.stringify(server.requests)).not.toMatch(/"(?:options|stem|correctIndex|explanation)"\s*:/);
  });
});

describe('⋮ menu', () => {
  const menuBtn = () => host.querySelector<HTMLButtonElement>('.menu-btn')!;
  const menuList = () => host.querySelector<HTMLElement>('.menu')!;
  const item = (action: string) => host.querySelector<HTMLButtonElement>(`.menu [data-action="${action}"]`)!;
  const key = (target: HTMLElement, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('labels "up" with its target and disables up and root at the top', async () => {
    await mount(fakeServer(sampleMap()));
    expect(menuBtn().getAttribute('aria-expanded')).toBe('false');
    expect(menuList().hidden).toBe(true);
    expect(item('up').textContent).toBe('Up one level');
    expect(item('up').getAttribute('aria-disabled')).toBe('true');
    expect(item('root').getAttribute('aria-disabled')).toBe('true');
    expect(item('refresh').hasAttribute('aria-disabled')).toBe(false);
    await navigate('#/src/math.ts%23clamp');
    expect(item('up').textContent).toBe('Up to src/');
    expect(item('up').hasAttribute('aria-disabled')).toBe(false);
  });

  it('opens on click with focus on the first item, runs actions and ignores disabled ones', async () => {
    await mount(fakeServer(sampleMap()));
    menuBtn().click();
    expect(menuList().hidden).toBe(false);
    expect(menuBtn().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(item('up'));
    item('up').click();
    // Disabled: the menu stays open and nothing navigates.
    expect(menuList().hidden).toBe(false);
    expect(window.location.hash).toBe('');

    await navigate('#/src/math.ts');
    menuBtn().click();
    await hashChange(() => item('up').click());
    expect(window.location.hash).toBe('#/src');
    expect(menuList().hidden).toBe(true);
    menuBtn().click();
    await hashChange(() => item('root').click());
    expect(window.location.hash).toBe('#/');
    expect(crumbs()).toEqual(['repo']);
  });

  it('"Refresh now" polls the server right away', async () => {
    const server = fakeServer(sampleMap());
    await mount(server);
    const before = server.requests.length;
    menuBtn().click();
    item('refresh').click();
    await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(before));
    expect(server.requests[before]?.url).toBe('/api/map');
  });

  it('moves with the arrow keys, Home and End, closes on Escape, Tab and outside clicks', async () => {
    await mount(fakeServer(sampleMap()));
    key(menuBtn(), 'ArrowDown');
    expect(menuList().hidden).toBe(false);
    expect(document.activeElement).toBe(item('up'));
    key(item('up'), 'ArrowDown');
    expect(document.activeElement).toBe(item('root'));
    key(item('root'), 'End');
    expect(document.activeElement).toBe(item('refresh'));
    key(item('refresh'), 'ArrowDown');
    expect(document.activeElement).toBe(item('up'));
    key(item('up'), 'ArrowUp');
    expect(document.activeElement).toBe(item('refresh'));
    key(item('refresh'), 'Home');
    expect(document.activeElement).toBe(item('up'));
    key(item('up'), 'Escape');
    expect(menuList().hidden).toBe(true);
    expect(document.activeElement).toBe(menuBtn());

    key(menuBtn(), 'ArrowUp');
    expect(document.activeElement).toBe(item('refresh'));
    key(menuBtn(), 'Escape');
    expect(menuList().hidden).toBe(true);

    menuBtn().click();
    key(item('up'), 'Tab');
    expect(menuList().hidden).toBe(true);

    menuBtn().click();
    host.querySelector<HTMLElement>('.panel')!.click();
    expect(menuList().hidden).toBe(true);
    expect(menuBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when focus moves elsewhere and stays closed across re-renders', async () => {
    await mount(fakeServer(sampleMap()));
    menuBtn().click();
    cell('src').focus();
    expect(menuList().hidden).toBe(true);
    await navigate('#/src');
    expect(menuList().hidden).toBe(true);
  });
});

describe('tooltip and stats edge cases', () => {
  it('Escape on a cell first dismisses the tooltip, then goes up a level', async () => {
    await mount(fakeServer(sampleMap()));
    await navigate('#/src/math.ts');
    const target = cell('src/math.ts#clamp');
    target.focus();
    const tip = host.querySelector<HTMLElement>('.tooltip')!;
    expect(tip.hidden).toBe(false);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tip.hidden).toBe(true);
    expect(window.location.hash).toBe('#/src/math.ts');
    await hashChange(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(window.location.hash).toBe('#/src');
  });

  it('shows placeholders until status loads and keeps the last counters when it fails', async () => {
    const server = fakeServer(sampleMap(), 'error');
    const a = await mount(server);
    expect(host.querySelector('[data-stat="leaves"] .stat-value')?.textContent).toBe('–');
    expect(host.querySelector('[data-stat="leaves"] .badge')).toBeNull();
    server.setStatus(sampleStatus());
    server.set(sampleMap());
    await a.refresh();
    expect(host.querySelector('[data-stat="leaves"] .stat-value')?.textContent).toBe('8');
    expect(host.querySelector('[data-stat="due"] .badge')?.textContent).toBe('! review');
    server.setStatus('error');
    server.set(sampleMap());
    await a.refresh();
    expect(host.querySelector('[data-stat="leaves"] .stat-value')?.textContent).toBe('8');
  });

  it('shows "none" due when nothing is due', async () => {
    await mount(fakeServer(sampleMap(), { ...sampleStatus(), due: 0 }));
    expect(host.querySelector('[data-stat="due"] .badge')?.textContent).toBe('✓ none');
  });

  it('ignores a slow status answer that arrives after a newer one', async () => {
    const server = fakeServer(sampleMap());
    let releaseSlow: (() => void) | null = null;
    let statusCalls = 0;
    const fetch: typeof server.fetch = async (url, init) => {
      if (url === '/api/status' && ++statusCalls === 2) {
        const res = await server.fetch(url, init);
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        return res;
      }
      return server.fetch(url, init);
    };
    app = mountApp(host, { fetch, window, now: () => NOW, pollMs: 0 });
    await app.refresh();
    // Second refresh: its status request (old counters) hangs.
    server.setStatus({ ...sampleStatus(), leaves: 100 });
    server.set(sampleMap());
    const slow = app.refresh();
    await vi.waitFor(() => expect(releaseSlow).not.toBeNull());
    // Third refresh lands first with the newest counters.
    server.setStatus({ ...sampleStatus(), leaves: 200 });
    server.set(sampleMap());
    await app.refresh();
    expect(host.querySelector('[data-stat="leaves"] .stat-value')?.textContent).toBe('200');
    (releaseSlow as unknown as () => void)();
    await slow;
    expect(host.querySelector('[data-stat="leaves"] .stat-value')?.textContent).toBe('200');
  });
});
