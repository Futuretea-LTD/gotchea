// The read-only treemap UI: breadcrumb, legend with counters, treemap, details panel and
// a plain list of the children (0-LOC chunks included). State lives in the URL hash, so
// drill-down is ordinary navigation and the back button works.
import { POLL_MS, createPoller, type FetchLike, type MapUpdate, type Poller } from './api.js';
import { squarify, type Rect } from './layout/squarify.js';
import {
  COLOR_INFO,
  COLORS,
  closestExisting,
  colorCounts,
  commandsFor,
  displayName,
  findNode,
  formatDue,
  formatR,
  hashFor,
  idFromHash,
  isEmptyMap,
  pathTo,
  type MapJson,
  type MapNode,
} from './model.js';

export interface AppOptions {
  fetch: FetchLike;
  window: Window;
  now?: () => Date;
  /** Poll interval; 0 disables the timer (tests drive `refresh()`). */
  pollMs?: number;
}

export interface App {
  /** Polls once and re-renders if the map changed. */
  refresh(): Promise<void>;
  /** Renders the current map for the current hash. */
  render(): void;
  destroy(): void;
}

/** Fallback layout size when the container has no box yet (first paint, or a DOM without layout). */
const FALLBACK: Rect = { x: 0, y: 0, w: 960, h: 540 };

export function mountApp(host: HTMLElement, opts: AppOptions): App {
  const win = opts.window;
  const doc = host.ownerDocument;
  const now = opts.now ?? (() => new Date());
  const pollMs = opts.pollMs ?? POLL_MS;
  const poller: Poller = createPoller(opts.fetch, pollMs, win);
  let map: MapJson | null = null;
  let screen: 'loading' | 'map' | 'empty' = 'loading';
  let notice = '';
  /** Node shown in the details panel while a cell is hovered or focused. */
  let peekId: string | null = null;
  let lastSize: Rect | null = null;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...kids: (Node | string)[]) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (v !== undefined) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };

  const apply = (u: MapUpdate): void => {
    if (u.kind === 'map') {
      map = u.map;
      notice = '';
      screen = isEmptyMap(u.map.root) ? 'empty' : 'map';
    } else if (u.kind === 'not_scanned') {
      map = null;
      notice = '';
      screen = 'empty';
    } else if (u.kind === 'reconnected') {
      notice = '';
    } else {
      notice = u.message;
    }
    render();
  };

  const go = (id: string): void => {
    const hash = hashFor(id);
    if (win.location.hash === hash) render();
    else win.location.hash = hash;
  };

  // ---- rendering ----

  function render(): void {
    const focusedId = (doc.activeElement as HTMLElement | null)?.dataset?.['id'] ?? null;
    const header = el('header', { class: 'top' }, el('h1', {}, 'gotchea'));
    const live = el('p', { class: 'live', role: 'status', 'aria-live': 'polite' }, notice);
    host.replaceChildren();

    if (screen === 'loading') {
      host.append(header, live, el('main', { class: 'loading' }, el('p', {}, 'Loading the map…')));
      return;
    }
    if (screen === 'empty' || !map) {
      host.append(header, live, emptyScreen());
      return;
    }

    const root = map.root;
    const wanted = idFromHash(win.location.hash);
    const node = findNode(root, wanted) ?? closestExisting(root, wanted);
    const trail = pathTo(root, node.id);
    // A leaf is shown selected inside its parent's treemap.
    const container = node.children.length > 0 ? node : (trail[trail.length - 2] ?? node);
    const peek = (peekId && findNode(root, peekId)) || node;

    header.append(breadcrumb(trail));
    host.append(
      header,
      live,
      el(
        'main',
        {},
        legend(container),
        el('div', { class: 'body' }, treemap(container, node), details(peek, node)),
        childList(container, node),
      ),
    );
    if (focusedId) host.querySelector<HTMLElement>(`.cell[data-id="${cssEscape(focusedId)}"]`)?.focus();
  }

  function emptyScreen(): HTMLElement {
    return el(
      'main',
      { class: 'empty' },
      el('h2', {}, 'Nothing to show yet'),
      el('p', {}, 'This repository has no scanned chunks. Run this in the repository root, then keep this page open:'),
      el('pre', {}, el('code', {}, 'gotchea scan')),
      el('p', {}, 'The map refreshes by itself. To color it, generate questions and take a quiz in your terminal:'),
      el('pre', {}, el('code', {}, 'gotchea generate\ngotchea quiz')),
    );
  }

  function breadcrumb(trail: MapNode[]): HTMLElement {
    const list = el('ol', { class: 'crumbs' });
    trail.forEach((n, i) => {
      const last = i === trail.length - 1;
      const label = displayName(n);
      list.append(el('li', {}, last ? el('span', { 'aria-current': 'page' }, label) : el('a', { href: hashFor(n.id) }, label)));
    });
    return el('nav', { 'aria-label': 'Breadcrumb' }, list);
  }

  function legend(container: MapNode): HTMLElement {
    const counts = colorCounts(container);
    const list = el('ul', { class: 'legend' });
    for (const c of COLORS) {
      const info = COLOR_INFO[c];
      list.append(
        el(
          'li',
          { class: `legend-item c-${c}`, 'data-color': c },
          el('span', { class: 'swatch', 'aria-hidden': 'true' }, info.mark),
          el('strong', {}, info.label),
          ` ${info.meaning} `,
          el('span', { class: 'count' }, `(${counts[c]})`),
        ),
      );
    }
    return el('section', { 'aria-label': `Legend: leaf chunks per color under ${displayName(container)}` }, list);
  }

  function treemap(container: MapNode, selected: MapNode): HTMLElement {
    const box = el('div', {
      class: 'treemap',
      role: 'group',
      'aria-label': `Treemap of ${displayName(container)}: area is lines of code. Arrow keys move, Enter opens, Backspace goes up.`,
    });
    // The size measured on the previous box (this render replaces it), so cells keep the screen's aspect ratio.
    const size = lastSize ?? FALLBACK;
    const cells = squarify(container.children, size, (c) => c.loc);
    const focusId = cells.some((c) => c.item.id === selected.id) ? selected.id : cells[0]?.item.id;
    for (const { item, rect } of cells) {
      const b = el(
        'button',
        {
          type: 'button',
          class: `cell c-${item.state.color}${item.id === selected.id ? ' selected' : ''}`,
          'data-id': item.id,
          'data-color': item.state.color,
          tabindex: item.id === focusId ? '0' : '-1',
          'aria-label': cellLabel(item),
          ...(item.id === selected.id ? { 'aria-pressed': 'true' } : {}),
        },
        el('span', { class: 'mark', 'aria-hidden': 'true' }, COLOR_INFO[item.state.color].mark),
        el('span', { class: 'name' }, displayName(item)),
        el('span', { class: 'meta' }, `${item.loc} LOC · R ${formatR(item.state.R)}`),
      );
      // CSSOM writes are allowed under `style-src 'self'` (no inline style attributes).
      b.style.left = `${(rect.x / size.w) * 100}%`;
      b.style.top = `${(rect.y / size.h) * 100}%`;
      b.style.width = `${(rect.w / size.w) * 100}%`;
      b.style.height = `${(rect.h / size.h) * 100}%`;
      box.append(b);
    }
    if (cells.length === 0) box.append(el('p', { class: 'no-area' }, 'No lines of code here; see the list below.'));
    return box;
  }

  function cellLabel(n: MapNode): string {
    const q = n.isLeaf ? `, ${n.okQuestions} of ${n.questionCount} questions` : '';
    return `${displayName(n)}, ${n.kind}, ${COLOR_INFO[n.state.color].label}, R ${formatR(n.state.R)}, ${n.loc} LOC${q}`;
  }

  function details(n: MapNode, selected: MapNode): HTMLElement {
    const rows: [string, string][] = [
      ['id', n.id],
      ['kind', n.kind],
      ['state', `${COLOR_INFO[n.state.color].mark} ${COLOR_INFO[n.state.color].label}`],
      ['LOC', String(n.loc)],
      ['complexity', String(n.complexity)],
      ['fanIn', String(n.fanIn)],
      ['R', formatR(n.state.R)],
      ['due', formatDue(n.state.dueAt, now())],
    ];
    if (n.isLeaf) rows.push(['questions', `${n.okQuestions}/${n.questionCount}`]);
    const dl = el('dl', {});
    for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
    const panel = el(
      'aside',
      { class: `panel c-${n.state.color}`, 'aria-label': 'Details', 'data-id': n.id },
      el('h2', {}, displayName(n)),
      dl,
    );
    const cmds = commandsFor(n);
    if (cmds.length > 0) {
      const list = el('div', { class: 'commands' }, el('h3', {}, 'In your terminal'));
      for (const c of cmds) {
        const code = el('code', {}, c.command);
        const copy = el('button', { type: 'button', class: 'copy', 'data-command': c.command, 'aria-label': `Copy: ${c.command}` }, 'Copy');
        list.append(el('p', {}, el('span', { class: 'cmd-label' }, `${c.label}: `), code, ' ', copy));
      }
      panel.append(list);
    }
    if (n.id !== selected.id) panel.append(el('p', { class: 'hint' }, `Selected: ${displayName(selected)}`));
    return panel;
  }

  function childList(container: MapNode, selected: MapNode): HTMLElement {
    const body = el('tbody');
    for (const c of container.children) {
      body.append(
        el(
          'tr',
          { class: `c-${c.state.color}${c.id === selected.id ? ' selected' : ''}`, 'data-id': c.id },
          el('td', {}, el('a', { href: hashFor(c.id) }, displayName(c))),
          el('td', {}, `${COLOR_INFO[c.state.color].mark} ${COLOR_INFO[c.state.color].label}`),
          el('td', { class: 'num' }, String(c.loc)),
          el('td', { class: 'num' }, formatR(c.state.R)),
          el('td', { class: 'num' }, c.isLeaf ? `${c.okQuestions}/${c.questionCount}` : ''),
        ),
      );
    }
    const cols: [string, string][] = [['Name', ''], ['State', ''], ['LOC', 'num'], ['R', 'num'], ['Questions', 'num']];
    const head = el('thead', {}, el('tr', {}, ...cols.map(([h, cls]) => el('th', { scope: 'col', ...(cls ? { class: cls } : {}) }, h))));
    const count = container.children.length;
    return el(
      'section',
      { class: 'children', 'aria-label': `Contents of ${displayName(container)}` },
      el('table', {}, el('caption', {}, `${displayName(container)}: ${count} ${count === 1 ? 'item' : 'items'}`), head, body),
    );
  }

  // ---- events ----

  const measure = (): void => {
    const box = host.querySelector<HTMLElement>('.treemap');
    const w = box?.clientWidth ?? 0;
    const h = box?.clientHeight ?? 0;
    if (w > 0 && h > 0 && (!lastSize || Math.abs(lastSize.w - w) > 1 || Math.abs(lastSize.h - h) > 1)) {
      lastSize = { x: 0, y: 0, w, h };
      render();
    }
  };

  const onClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLElement>('button.copy');
    if (copy) {
      void copyText(copy.dataset['command'] ?? '', copy);
      return;
    }
    const cell = target.closest<HTMLElement>('.cell');
    if (cell?.dataset['id']) go(cell.dataset['id']);
  };

  const onKey = (e: KeyboardEvent): void => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
    if (!cell) return;
    if (e.key === 'Backspace' || e.key === 'Escape') {
      e.preventDefault();
      const trail = map ? pathTo(map.root, idFromHash(win.location.hash)) : [];
      const current = trail[trail.length - 1];
      // Up one level from the container on screen (a selected leaf's container is its parent).
      const up = current && current.children.length === 0 ? trail[trail.length - 3] : trail[trail.length - 2];
      if (up) go(up.id);
      return;
    }
    const cells = [...host.querySelectorAll<HTMLElement>('.cell')];
    let next: HTMLElement | undefined;
    if (e.key === 'Home') next = cells[0];
    else if (e.key === 'End') next = cells[cells.length - 1];
    else if (e.key.startsWith('Arrow')) next = neighbour(cells, cell, e.key);
    if (!next) return;
    e.preventDefault();
    for (const c of cells) c.tabIndex = c === next ? 0 : -1;
    next.focus();
  };

  const onPeek = (e: Event): void => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
    const id = cell?.dataset['id'] ?? null;
    if (id === peekId) return;
    peekId = id;
    // Only the panel changes, so focus and hover stay put.
    if (!map) return;
    const panel = host.querySelector('.panel');
    const root = map.root;
    const selected = findNode(root, idFromHash(win.location.hash)) ?? closestExisting(root, idFromHash(win.location.hash));
    const shown = (id && findNode(root, id)) || selected;
    panel?.replaceWith(details(shown, selected));
  };

  async function copyText(text: string, button: HTMLElement): Promise<void> {
    try {
      await win.navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      // No clipboard access (http on some browsers): select the command so ⌘C / Ctrl+C works.
      const code = button.parentElement?.querySelector('code');
      const sel = win.getSelection();
      if (code && sel) {
        const range = doc.createRange();
        range.selectNodeContents(code);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      button.textContent = 'Press Ctrl+C';
    }
  }

  const onHash = (): void => {
    peekId = null;
    render();
  };
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKey);
  host.addEventListener('mouseover', onPeek);
  host.addEventListener('focusin', onPeek);
  win.addEventListener('hashchange', onHash);
  win.addEventListener('resize', measure);

  render();
  if (pollMs > 0) poller.start(apply);

  return {
    async refresh() {
      const u = await poller.poll();
      if (u) apply(u);
    },
    render() {
      render();
      measure();
    },
    destroy() {
      poller.stop();
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKey);
      host.removeEventListener('mouseover', onPeek);
      host.removeEventListener('focusin', onPeek);
      win.removeEventListener('hashchange', onHash);
      win.removeEventListener('resize', measure);
    },
  };
}

/** The closest cell in the arrow's direction, by cell centres (percent units). */
function neighbour(cells: HTMLElement[], from: HTMLElement, key: string): HTMLElement | undefined {
  const centre = (c: HTMLElement) => ({
    x: Number.parseFloat(c.style.left) + Number.parseFloat(c.style.width) / 2,
    y: Number.parseFloat(c.style.top) + Number.parseFloat(c.style.height) / 2,
  });
  const a = centre(from);
  let best: HTMLElement | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of cells) {
    if (c === from) continue;
    const b = centre(c);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ahead = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
    if (ahead <= 0.01) continue;
    const across = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
    const score = ahead + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
