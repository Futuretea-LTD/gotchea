import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_SCALE } from '../src/model.js';

const css = readFileSync(resolve(process.cwd(), 'packages/web/src/style.css'), 'utf8');
const variables = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
const dark = variables(css.slice(css.indexOf(':root'), css.indexOf('@media')));
const light = { ...dark, ...variables(css.slice(css.indexOf('@media'), css.indexOf('\n* {'))) };

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe.each([['dark', dark], ['light', light]] as const)('%s theme contrast', (_theme, theme) => {
  it('meets WCAG AA for scale cell and badge text', () => {
    for (const fill of RETENTION_SCALE) expect(contrast(theme['cell-fg']!, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA for page, card, panel, tooltip, controls and neutral text', () => {
    const pairs = [
      ['fg', 'page'], ['fg', 'card'], ['fg', 'surface'], ['fg', 'code-bg'], ['fg', 'row-selected'],
      ['muted', 'card'], ['muted', 'surface'], ['none-fg', 'none-bg'], ['btn-fg', 'btn-bg'],
      ['tip-fg', 'tip-bg'], ['tip-muted', 'tip-bg'], ['tip-fg', 'tip-hover'], ['tip-disabled', 'tip-bg'],
    ];
    for (const [fg, bg] of pairs) expect(contrast(theme[fg!]!, theme[bg!]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});


describe('UI color bindings', () => {
  it('uses the tested foreground/background tokens for scale, none and tooltip text', () => {
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0]!;
    expect(rule('.cell')).toMatch(/color:\s*var\(--cell-fg\)/);
    expect(rule('.cell.none')).toMatch(/color:\s*var\(--none-fg\)/);
    expect(rule('.cell.none')).toMatch(/background:\s*var\(--none-bg\)/);
    expect(dark['none-bg']).toBe('#4a4a4a');
    expect(rule('.tooltip')).toMatch(/color:\s*var\(--tip-fg\)/);
    expect(rule('.tooltip')).toMatch(/background:\s*var\(--tip-bg\)/);
    expect(dark['tip-bg']).toBe('#ffffff');
    expect(light['tip-bg']).toBe('#ffffff');
  });

  it('provides a visible outline and raises focused cells above their neighbours', () => {
    expect(css.match(/:focus-visible\s*\{([^}]+)\}/)?.[1]).toMatch(/outline:\s*3px solid var\(--focus\)/);
    expect(css.match(/\.cell:focus-visible\s*\{([^}]+)\}/)?.[1]).toMatch(/z-index:\s*2/);
    expect(css).not.toMatch(/outline:\s*(?:none|0)\s*;/);
  });
});

describe('accessibility media queries', () => {
  const block = (query: string): string => {
    const start = css.indexOf(`@media (${query})`);
    expect(start, query).toBeGreaterThanOrEqual(0);
    // The block ends at the first closing brace on a line of its own.
    return css.slice(start, css.indexOf('\n}', start));
  };

  it('keeps tones distinguishable in forced-colors mode with system colours', () => {
    const forced = block('forced-colors: active');
    expect(forced).toMatch(/\.cell,\s*\.swatch,\s*\.badge,\s*\.dot\s*\{[^}]*border:\s*1px solid CanvasText/);
    expect(forced).toMatch(/forced-color-adjust:\s*none/);
    expect(forced).toMatch(/\.cell\.selected\s*\{[^}]*outline:\s*3px solid Highlight/);
  });

  it('drops cell transitions for reduced motion', () => {
    expect(block('prefers-reduced-motion: reduce')).toMatch(/\.cell\s*\{[^}]*transition:\s*none/);
  });

  it('edges the pale scale fills on the light card, but not the dashed no-question tone', () => {
    const edges = css.slice(css.lastIndexOf('@media (prefers-color-scheme: light)'));
    expect(edges).toMatch(/\.cell:not\(\.none\),\s*\.swatch:not\(\.none\),\s*\.badge:not\(\.none\),\s*\.dot:not\(\.none\)\s*\{[^}]*box-shadow:\s*inset/);
  });
});

describe('CSP-compatible static assets', () => {
  function assertHtml(html: string): void {
    // A template is inert: inspecting built links must not try to load their CSS.
    const template = document.createElement('template');
    template.innerHTML = html;
    const doc = template.content;
    expect(doc.querySelectorAll('[style], style')).toHaveLength(0);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<style\b/i);
    // Every resource must be local, including font preloads and script/module URLs.
    for (const element of doc.querySelectorAll('[src], [href]')) {
      for (const attribute of ['src', 'href']) {
        expect(element.getAttribute(attribute) ?? '').not.toMatch(/^(?:https?:)?\/\//i);
      }
    }
  }

  it('keeps the source shell free of inline CSS and external resources', () => {
    assertHtml(readFileSync(resolve('packages/web/index.html'), 'utf8'));
    expect(css).not.toMatch(/@import\b|url\(\s*["']?(?:https?:)?\/\//i);
  });

  it.skipIf(!existsSync(resolve('packages/web/dist/index.html')))('keeps built HTML and CSS compatible with the serve CSP', () => {
    assertHtml(readFileSync(resolve('packages/web/dist/index.html'), 'utf8'));
    const assets = resolve('packages/web/dist/assets');
    const styles = readdirSync(assets).filter((name) => name.endsWith('.css'));
    expect(styles.length).toBeGreaterThan(0);
    for (const name of styles) {
      expect(readFileSync(resolve(assets, name), 'utf8')).not.toMatch(/@import\b|url\(\s*["']?(?:https?:)?\/\//i);
    }
  });
});
