// The read-only treemap UI: one dark card with the title, breadcrumb, scope selector and
// ⋮ menu, the treemap with a hover/focus tooltip, a Low→High retention legend with the
// per-state counters, the selected node's details and the repo stats row; the plain list
// of the children (0-LOC chunks included) follows below the card. State lives in the URL
// hash, so drill-down is ordinary navigation and the back button works.
import { POLL_MS, createPoller, fetchStatus, type FetchLike, type MapUpdate, type Poller } from './api.js';
import { squarifyWithGap } from './layout/gap.js';
import type { Rect } from './layout/squarify.js';
import {
  COLOR_INFO,
  RETENTION_SCALE,
  cellTone,
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
  statusStats,
  tierRange,
  upFrom,
  type ChunkColor,
  type MapJson,
  type MapNode,
  type RetentionTier,
  type StatusJson,
} from './model.js';

export interface AppOptions {
  fetch: FetchLike;
  window: Window;
  now?: () => Date;
  /** Poll interval; 0 disables the timer (tests drive `refresh()`). */
  pollMs?: number;
}

export interface App {
  /** Polls once and re-renders if the map changed (the stats row follows a changed map). */
  refresh(): Promise<void>;
  /** Renders the current map for the current hash. */
  render(): void;
  destroy(): void;
}

/** Fallback layout size when the container has no box yet (first paint, or a DOM without layout). */
const FALLBACK: Rect = { x: 0, y: 0, w: 960, h: 540 };
/** Gutter between treemap cells, in layout pixels. */
export const CELL_GAP = 6;
// Label fit estimate (no text measuring: it must also work without layout, e.g. in tests).
// Matches `.cell` in style.css: 13px semibold (~7.5px per character), 10px side padding.
const LABEL_CHAR_PX = 7.5;
const LABEL_PAD_X = 10;
const LABEL_MIN_H = 30;
/** Space the tooltip needs above or below its cell before it flips. */
const TIP_ROOM = 180;
/** Tooltip width when it has no box to measure (`.tooltip` max-width in style.css). */
const TIP_WIDTH = 260;
const TIERS: readonly RetentionTier[] = [0, 1, 2, 3, 4];

type Props = Partial<Record<string, string>>;

export function mountApp(host: HTMLElement, opts: AppOptions): App {
  const win = opts.window;
  const doc = host.ownerDocument;
  const now = opts.now ?? (() => new Date());
  const pollMs = opts.pollMs ?? POLL_MS;
  const poller: Poller = createPoller(opts.fetch, pollMs, win);
  let map: MapJson | null = null;
  let status: StatusJson | null = null;
  let statusSeq = 0;
  let screen: 'loading' | 'map' | 'empty' = 'loading';
  let notice = '';
  let lastSize: Rect | null = null;
  /** Layout size of the cells on screen, for placing the tooltip. */
  let layoutSize: Rect = FALLBACK;
  // Tooltip sources: the hovered cell wins over the keyboard-focused one.
  let hoverId: string | null = null;
  let focusTipId: string | null = null;
  let menuOpen = false;

  // Attributes only: `style` is never set through markup or setAttribute (CSP `style-src 'self'`);
  // geometry and fills are CSSOM property writes, which that CSP allows.
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string)[]) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') throw new Error('inline style attributes are blocked by the CSP; use CSSOM or a class');
      if (v !== undefined) e.setAttribute(k, v);
    }
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

  /** Renders the update right away; a changed map also reloads the stats row. */
  const onUpdate = async (u: MapUpdate): Promise<void> => {
    apply(u);
    if (u.kind === 'map') await loadStatus();
  };

  const loadStatus = async (): Promise<void> => {
    const seq = ++statusSeq;
    const s = await fetchStatus(opts.fetch);
    // A newer request owns the row; a failed one keeps the last counters.
    if (seq !== statusSeq || !s) return;
    status = s;
    host.querySelector('.stats')?.replaceWith(stats());
  };

  const refresh = async (): Promise<void> => {
    const u = await poller.poll();
    if (u) await onUpdate(u);
  };

  const go = (id: string): void => {
    const hash = hashFor(id);
    if (win.location.hash === hash) render();
    else win.location.hash = hash;
  };

  /** The node the hash names (or its closest surviving ancestor) and the trail down to it. */
  const current = (root: MapNode): { node: MapNode; trail: MapNode[] } => {
    const wanted = idFromHash(win.location.hash);
    const node = findNode(root, wanted) ?? closestExisting(root, wanted);
    return { node, trail: pathTo(root, node.id) };
  };

  // ---- rendering ----

  function render(): void {
    const focusKey = (doc.activeElement as HTMLElement | null)?.dataset?.['focusKey'] ?? null;
    const title = el('div', { class: 'title' }, el('h1', {}, 'gotchea'));
    const head = el('header', { class: 'card-head' }, title);
    const live = el('p', { class: 'live', role: 'status', 'aria-live': 'polite' }, notice);
    const card = el('section', { class: 'card', 'aria-label': 'gotchea map' }, head, live);
    const shell = el('main', { class: 'shell' }, card);
    host.replaceChildren(shell);

    if (screen === 'loading') {
      card.append(el('div', { class: 'loading' }, el('p', {}, 'Loading the map…')));
      return;
    }
    if (screen === 'empty' || !map) {
      card.append(emptyScreen());
      return;
    }

    const { node, trail } = current(map.root);
    // A leaf is shown selected inside its parent's treemap.
    const container = node.children.length > 0 ? node : (trail[trail.length - 2] ?? node);

    title.append(breadcrumb(trail));
    head.append(el('div', { class: 'tools' }, scope(trail), menu(trail)));
    card.append(
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'map-col' }, el('div', { class: 'treemap-wrap' }, treemap(container, node), tooltipShell()), legend(container)),
        details(node),
      ),
      stats(),
    );
    shell.append(childList(container, node));

    if (focusKey) {
      // Drilling into another level removes the old cell; keep the keyboard in the treemap.
      const target = [...host.querySelectorAll<HTMLElement>('[data-focus-key]')].find((e) => e.dataset['focusKey'] === focusKey)
        ?? (focusKey.startsWith('cell:') ? host.querySelector<HTMLElement>('.cell[tabindex="0"]') : null);
      if (target?.classList.contains('cell')) for (const c of host.querySelectorAll<HTMLElement>('.cell')) c.tabIndex = c === target ? 0 : -1;
      target?.focus();
    }
    // A replaced cell does not reliably fire focusout; only a cell that holds focus keeps its tooltip.
    if (!(doc.activeElement as HTMLElement | null)?.classList?.contains('cell')) focusTipId = null;
    updateTip();
    measure();
  }

  function emptyScreen(): HTMLElement {
    return el(
      'div',
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
      list.append(
        el('li', {}, last ? el('span', { 'aria-current': 'page' }, label) : el('a', { href: hashFor(n.id), 'data-focus-key': `crumb:${n.id}` }, label)),
      );
    });
    return el('nav', { 'aria-label': 'Breadcrumb' }, list);
  }

  /** A dropdown over the breadcrumb levels; choosing one navigates there. */
  function scope(trail: MapNode[]): HTMLElement {
    const select = el('select', { class: 'scope-select', 'aria-label': 'Scope', 'data-focus-key': 'scope' });
    for (const n of trail) select.append(el('option', { value: n.id }, displayName(n)));
    select.value = trail[trail.length - 1]?.id ?? '.';
    return el('div', { class: 'scope' }, select);
  }

  function menu(trail: MapNode[]): HTMLElement {
    const up = upFrom(trail);
    const atRoot = trail.length <= 1;
    const items: [action: string, label: string, enabled: boolean][] = [
      ['up', up ? `Up to ${displayName(up)}` : 'Up one level', up !== undefined],
      ['root', 'Repository root', !atRoot],
      ['refresh', 'Refresh now', true],
    ];
    const list = el('ul', { id: 'gotchea-menu', class: 'menu', role: 'menu', 'aria-label': 'More actions' });
    for (const [action, label, enabled] of items) {
      list.append(
        el(
          'li',
          { role: 'none' },
          el(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              tabindex: '-1',
              'data-action': action,
              'data-focus-key': `menu:${action}`,
              ...(enabled ? {} : { 'aria-disabled': 'true' }),
            },
            label,
          ),
        ),
      );
    }
    list.hidden = !menuOpen;
    const button = el(
      'button',
      {
        type: 'button',
        class: 'menu-btn',
        'aria-label': 'More actions',
        'aria-haspopup': 'menu',
        'aria-controls': 'gotchea-menu',
        'aria-expanded': String(menuOpen),
        'data-focus-key': 'menu',
      },
      el('span', { 'aria-hidden': 'true' }, '⋮'),
    );
    return el('div', { class: 'menu-wrap' }, button, list);
  }

  function legend(container: MapNode): HTMLElement {
    const counts = colorCounts(container);
    const swatches = el('ol', { class: 'swatches' });
    for (const tier of TIERS) {
      const s = el('li', { class: 'swatch', 'data-tier': String(tier) }, el('span', { class: 'visually-hidden' }, `R ${tierRange(tier)}`));
      s.style.backgroundColor = RETENTION_SCALE[tier];
      swatches.append(s);
    }
    const scale = el(
      'div',
      { class: 'scale', role: 'group', 'aria-label': 'Retention level (R), low to high' },
      el('span', { class: 'scale-title' }, 'Recall'),
      el('span', { class: 'scale-end', 'aria-hidden': 'true' }, 'Low'),
      swatches,
      el('span', { class: 'scale-end', 'aria-hidden': 'true' }, 'High'),
    );
    const none = el(
      'p',
      { class: 'legend-none', 'data-color': 'grey' },
      el('span', { class: 'swatch none', 'aria-hidden': 'true' }),
      `${COLOR_INFO.grey.mark} no questions `,
      el('span', { class: 'count' }, `(${counts.grey})`),
    );
    const states = el('ul', { class: 'counts' });
    for (const c of ['red', 'yellow', 'green'] as const satisfies readonly ChunkColor[]) {
      const info = COLOR_INFO[c];
      states.append(
        el(
          'li',
          { class: 'count-item', 'data-color': c },
          el('span', { class: 'mark', 'aria-hidden': 'true' }, info.mark),
          ` ${info.label} `,
          el('span', { class: 'count' }, String(counts[c])),
          el('span', { class: 'visually-hidden' }, `: ${info.meaning}`),
        ),
      );
    }
    return el(
      'section',
      { class: 'legend', 'aria-label': `Legend: retention scale, and leaf chunks per state under ${displayName(container)}` },
      el('div', { class: 'legend-row' }, scale, none),
      states,
    );
  }

  function treemap(container: MapNode, selected: MapNode): HTMLElement {
    const box = el('div', {
      class: 'treemap',
      role: 'group',
      'aria-label': `Treemap of ${displayName(container)}: area is lines of code. Arrow keys move, Enter opens, Backspace goes up.`,
    });
    // The size measured on the previous box (this render replaces it), so cells keep the screen's aspect ratio.
    const size = lastSize ?? FALLBACK;
    layoutSize = size;
    const cells = squarifyWithGap(container.children, size, (c) => c.loc, CELL_GAP);
    const focusId = cells.some((c) => c.item.id === selected.id) ? selected.id : cells[0]?.item.id;
    for (const { item, rect } of cells) {
      const tone = cellTone(item);
      const isSelected = item.id === selected.id;
      const name = displayName(item);
      const fits = labelFits(name, rect);
      const b = el(
        'button',
        {
          type: 'button',
          class: `cell ${tone.kind === 'none' ? 'none' : `tier-${tone.tier}`}${isSelected ? ' selected' : ''}${fits ? '' : ' no-label'}`,
          'data-id': item.id,
          'data-color': item.state.color,
          'data-focus-key': `cell:${item.id}`,
          ...(tone.kind === 'scale' ? { 'data-tier': String(tone.tier) } : {}),
          tabindex: item.id === focusId ? '0' : '-1',
          'aria-label': cellLabel(item),
          ...(isSelected ? { 'aria-pressed': 'true' } : {}),
        },
      );
      if (fits) b.append(el('span', { class: 'name', 'aria-hidden': 'true' }, name));
      // CSSOM writes are allowed under `style-src 'self'` (no inline style attributes).
      if (tone.kind === 'scale') b.style.backgroundColor = RETENTION_SCALE[tone.tier];
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
    const info = COLOR_INFO[n.state.color];
    const q = n.isLeaf ? `, ${n.okQuestions} of ${n.questionCount} questions` : '';
    const due = n.state.dueAt === null ? '' : `, due ${formatDue(n.state.dueAt, now())}`;
    return `${displayName(n)}, ${n.kind}, ${info.mark} ${info.label}, R ${formatR(n.state.R)}, ${n.loc} LOC${q}${due}`;
  }

  // ---- tooltip ----

  /** Visual only: every cell's aria-label already carries the same facts. */
  function tooltipShell(): HTMLElement {
    const tip = el('div', { class: 'tooltip', 'aria-hidden': 'true' });
    tip.hidden = true;
    return tip;
  }

  function tooltipContent(n: MapNode): HTMLElement[] {
    const info = COLOR_INFO[n.state.color];
    const rows: [string, string][] = [
      ['State', `${info.mark} ${info.label}`],
      ['LOC', String(n.loc)],
      ['R', formatR(n.state.R)],
      ['Questions', n.isLeaf ? `${n.okQuestions}/${n.questionCount}` : '–'],
      ['Due', formatDue(n.state.dueAt, now())],
    ];
    const dl = el('dl', { class: 'tip-rows' });
    for (const [k, v] of rows) dl.append(el('div', { class: 'tip-row' }, el('dt', {}, k), el('dd', {}, v)));
    return [el('p', { class: 'tip-title' }, el('span', { class: 'tip-mark' }, info.mark), ' ', el('strong', {}, displayName(n))), dl];
  }

  function updateTip(): void {
    const tip = host.querySelector<HTMLElement>('.tooltip');
    if (!tip) return;
    const id = hoverId ?? focusTipId;
    const cellEl = id ? cellById(id) : null;
    const n = id && map && cellEl ? findNode(map.root, id) : null;
    if (!n || !cellEl) {
      tip.hidden = true;
      tip.replaceChildren();
      delete tip.dataset['id'];
      return;
    }
    tip.replaceChildren(...tooltipContent(n));
    tip.dataset['id'] = n.id;
    tip.hidden = false;
    const tipRoom = (tip.offsetHeight || TIP_ROOM) + 12;
    const left = Number.parseFloat(cellEl.style.left);
    const top = Number.parseFloat(cellEl.style.top);
    const width = Number.parseFloat(cellEl.style.width);
    const height = Number.parseFloat(cellEl.style.height);
    const cx = left + width / 2;
    const roomAbove = (top / 100) * layoutSize.h;
    const roomBelow = ((100 - top - height) / 100) * layoutSize.h;
    let place = roomAbove >= tipRoom ? 'above' : roomBelow >= tipRoom ? 'below' : 'inside';
    let anchorY = place === 'above' ? top : place === 'below' ? top + height : top + height / 2;
    // Tall cells can hold the bubble above an interior anchor, keeping its arrow visible.
    if (place === 'inside' && roomAbove + height / 100 * layoutSize.h >= tipRoom + 12) {
      place = 'above';
      anchorY = Math.max(anchorY, tipRoom / layoutSize.h * 100);
    }
    tip.classList.remove('above', 'below', 'inside', 'align-start', 'align-end');
    tip.classList.add(place);
    // In pixels, not percent: on a narrow treemap a centred bubble overflows well inside any fixed % zone.
    const cxPx = (cx / 100) * layoutSize.w;
    const halfTip = (tip.offsetWidth || TIP_WIDTH) / 2;
    if (cxPx < halfTip) tip.classList.add('align-start');
    else if (cxPx > layoutSize.w - halfTip) tip.classList.add('align-end');
    tip.style.left = `${cx}%`;
    tip.style.top = `${anchorY}%`;
  }

  function cellById(id: string): HTMLElement | null {
    return host.querySelector<HTMLElement>(`.cell[data-id="${cssEscape(id)}"]`);
  }

  // ---- details, stats, children ----

  function details(n: MapNode): HTMLElement {
    const info = COLOR_INFO[n.state.color];
    const rows: [string, string][] = [
      ['id', n.id],
      ['kind', n.kind],
      ['state', `${info.mark} ${info.label}`],
      ['LOC', String(n.loc)],
      ['complexity', String(n.complexity)],
      ['fanIn', String(n.fanIn)],
      ['R', formatR(n.state.R)],
      ['due', formatDue(n.state.dueAt, now())],
    ];
    if (n.isLeaf) rows.push(['questions', `${n.okQuestions}/${n.questionCount}`]);
    const dl = el('dl', {});
    for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
    const panel = el('aside', { class: 'panel', 'aria-label': 'Details', 'data-id': n.id }, el('h2', {}, dot(n), displayName(n)), dl);
    const cmds = commandsFor(n);
    if (cmds.length > 0) {
      const list = el('div', { class: 'commands' }, el('h3', {}, 'In your terminal'));
      for (const c of cmds) {
        const code = el('code', {}, c.command);
        const copy = el(
          'button',
          { type: 'button', class: 'copy', 'data-command': c.command, 'data-focus-key': `copy:${c.command}`, 'aria-label': `Copy: ${c.command}` },
          'Copy',
        );
        list.append(el('p', {}, el('span', { class: 'cmd-label' }, `${c.label}: `), code, ' ', copy));
      }
      panel.append(list);
    }
    return panel;
  }

  /** A small tone dot next to a name (the text beside it carries the state). */
  function dot(n: MapNode): HTMLElement {
    const tone = cellTone(n);
    const d = el('span', { class: `dot${tone.kind === 'none' ? ' none' : ''}`, 'aria-hidden': 'true' });
    if (tone.kind === 'scale') d.style.backgroundColor = RETENTION_SCALE[tone.tier];
    return d;
  }

  function stats(): HTMLElement {
    const s = status ? statusStats(status) : null;
    const items: { key: string; label: string; value: string; badge?: { text: string; tier: RetentionTier | 'none' } }[] = [
      {
        key: 'leaves',
        label: 'Leaves',
        value: s ? count(s.leaves) : '–',
        ...(status ? { badge: { text: `${COLOR_INFO.grey.mark} ${count(status.colors.grey)} no questions`, tier: 'none' as const } } : {}),
      },
      {
        key: 'green',
        label: 'Green',
        value: s ? `${Math.round(s.greenPercent)}%` : '–',
        ...(status ? { badge: { text: `${COLOR_INFO.green.mark} ${count(status.colors.green)} of ${count(status.leaves)}`, tier: 3 as const } } : {}),
      },
      {
        key: 'due',
        label: 'Due now',
        value: s ? count(s.dueNow) : '–',
        ...(s ? { badge: s.dueNow > 0 ? { text: `${COLOR_INFO.red.mark} review`, tier: 0 as const } : { text: `${COLOR_INFO.green.mark} none`, tier: 4 as const } } : {}),
      },
      { key: 'questions', label: 'Questions', value: s ? count(s.questions) : '–' },
    ];
    const list = el('dl', { class: 'stats-list' });
    for (const it of items) {
      const dd = el('dd', {}, el('span', { class: 'stat-value' }, it.value));
      if (it.badge) {
        const badge = el('span', { class: `badge${it.badge.tier === 'none' ? ' none' : ''}` }, it.badge.text);
        if (it.badge.tier !== 'none') badge.style.backgroundColor = RETENTION_SCALE[it.badge.tier];
        dd.append(badge);
      }
      list.append(el('div', { class: 'stat', 'data-stat': it.key }, el('dt', {}, it.label), dd));
    }
    return el('section', { class: 'stats', 'aria-label': 'Whole repository' }, list);
  }

  function childList(container: MapNode, selected: MapNode): HTMLElement {
    const body = el('tbody');
    for (const c of container.children) {
      body.append(
        el(
          'tr',
          { class: `c-${c.state.color}${c.id === selected.id ? ' selected' : ''}`, 'data-id': c.id },
          el('td', {}, dot(c), el('a', { href: hashFor(c.id), 'data-focus-key': `row:${c.id}` }, displayName(c))),
          el('td', {}, `${COLOR_INFO[c.state.color].mark} ${COLOR_INFO[c.state.color].label}`),
          el('td', { class: 'num' }, String(c.loc)),
          el('td', { class: 'num' }, formatR(c.state.R)),
          el('td', { class: 'num' }, c.isLeaf ? `${c.okQuestions}/${c.questionCount}` : ''),
        ),
      );
    }
    const cols: [string, string][] = [
      ['Name', ''],
      ['State', ''],
      ['LOC', 'num'],
      ['R', 'num'],
      ['Questions', 'num'],
    ];
    const head = el('thead', {}, el('tr', {}, ...cols.map(([h, cls]) => el('th', { scope: 'col', ...(cls ? { class: cls } : {}) }, h))));
    const n = container.children.length;
    return el(
      'section',
      { class: 'children card card-sub', 'aria-label': `Contents of ${displayName(container)}` },
      el('table', {}, el('caption', {}, `${displayName(container)}: ${n} ${n === 1 ? 'item' : 'items'}`), head, body),
    );
  }

  // ---- menu ----

  const menuItems = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.menu [role="menuitem"]')];

  function setMenu(open: boolean, focus: 'first' | 'button' | null): void {
    menuOpen = open;
    const list = host.querySelector<HTMLElement>('.menu');
    const button = host.querySelector<HTMLElement>('.menu-btn');
    if (list) list.hidden = !open;
    button?.setAttribute('aria-expanded', String(open));
    if (focus === 'first') menuItems()[0]?.focus();
    else if (focus === 'button') button?.focus();
  }

  function runAction(action: string | undefined): void {
    if (!map) return;
    if (action === 'up') {
      const up = upFrom(current(map.root).trail);
      if (up) go(up.id);
    } else if (action === 'root') go('.');
    else if (action === 'refresh') void refresh();
  }

  function onMenuKey(e: KeyboardEvent, target: HTMLElement): void {
    const items = menuItems();
    if (target.classList.contains('menu-btn')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenu(true, null);
        (e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
      } else if (e.key === 'Escape' && menuOpen) {
        e.preventDefault();
        setMenu(false, 'button');
      }
      return;
    }
    const i = items.indexOf(target);
    if (i < 0) return;
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      setMenu(false, 'button');
      return;
    } else if (e.key === 'Tab') setMenu(false, null);
    if (!next) return;
    e.preventDefault();
    next.focus();
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
    if (target.closest('.menu-btn')) {
      setMenu(!menuOpen, menuOpen ? null : 'first');
      return;
    }
    const item = target.closest<HTMLElement>('.menu [role="menuitem"]');
    if (item) {
      if (item.getAttribute('aria-disabled') === 'true') return;
      setMenu(false, 'button');
      runAction(item.dataset['action']);
      return;
    }
    if (menuOpen && !target.closest('.menu')) setMenu(false, null);
    const copy = target.closest<HTMLElement>('button.copy');
    if (copy) {
      void copyText(copy.dataset['command'] ?? '', copy);
      return;
    }
    const cell = target.closest<HTMLElement>('.cell');
    if (cell?.dataset['id']) go(cell.dataset['id']);
  };

  const onChange = (e: Event): void => {
    const target = e.target as HTMLSelectElement;
    if (target.classList?.contains('scope-select')) go(target.value);
  };

  const onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (target.closest('.menu-wrap')) {
      onMenuKey(e, target);
      return;
    }
    const cell = target.closest<HTMLElement>('.cell');
    if (!cell) return;
    // Escape first dismisses an open tooltip (WCAG 1.4.13); with none open it goes up like Backspace.
    if (e.key === 'Escape' && (hoverId ?? focusTipId) !== null) {
      e.preventDefault();
      hoverId = null;
      focusTipId = null;
      updateTip();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Escape') {
      e.preventDefault();
      // Resolve like render(): a hash naming a removed chunk still has a surviving ancestor on screen.
      const up = map ? upFrom(current(map.root).trail) : undefined;
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

  const onOver = (e: Event): void => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.cell')?.dataset['id'] ?? null;
    if (id === hoverId) return;
    hoverId = id;
    updateTip();
  };

  const onLeave = (): void => {
    if (hoverId === null) return;
    hoverId = null;
    updateTip();
  };

  const onFocusIn = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (menuOpen && !target.closest('.menu-wrap')) setMenu(false, null);
    const id = target.closest<HTMLElement>('.cell')?.dataset['id'] ?? null;
    if (id === focusTipId) return;
    focusTipId = id;
    updateTip();
  };

  const onFocusOut = (): void => {
    if (focusTipId === null) return;
    focusTipId = null;
    updateTip();
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
    hoverId = null;
    render();
  };
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('keydown', onKey);
  host.addEventListener('mouseover', onOver);
  host.addEventListener('mouseleave', onLeave);
  host.addEventListener('focusin', onFocusIn);
  host.addEventListener('focusout', onFocusOut);
  win.addEventListener('hashchange', onHash);
  win.addEventListener('resize', measure);

  render();
  if (pollMs > 0) poller.start((u) => void onUpdate(u));

  return {
    refresh,
    render() {
      render();
      measure();
    },
    destroy() {
      poller.stop();
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
      host.removeEventListener('keydown', onKey);
      host.removeEventListener('mouseover', onOver);
      host.removeEventListener('mouseleave', onLeave);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      win.removeEventListener('hashchange', onHash);
      win.removeEventListener('resize', measure);
    },
  };
}

/** Whether a cell of `rect` (layout pixels) can show all of `name`. */
function labelFits(name: string, rect: Rect): boolean {
  if (rect.h < LABEL_MIN_H) return false;
  return rect.w >= 2 * LABEL_PAD_X + name.length * LABEL_CHAR_PX;
}

function count(n: number): string {
  return n.toLocaleString('en-US');
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
