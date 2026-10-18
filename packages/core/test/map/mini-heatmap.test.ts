import { describe, expect, it } from 'vitest';
import { type MiniHeatmap, renderMiniHeatmapText } from '../../src/map/mini-heatmap.js';

describe('renderMiniHeatmapText', () => {
  it('shows control and bidi characters in hand-edited titles as stand-ins, in every mode', () => {
    const evil = 'f\u001b]0;pwn\u0007\u202E';
    const leaf = { id: 'a.ts#f', title: evil, color: 'green' as const, R: 0.9 };
    const h: MiniHeatmap = {
      focus: { ...leaf, path: 'a.ts' },
      fileLeaves: [{ ...leaf, isFocus: true }],
      omitted: 0,
      ancestors: [{ id: 'a.ts', title: `file ${evil}`, color: 'grey', R: null, kind: 'file' }],
    };
    for (const mode of ['emoji', 'plain', 'ansi'] as const) {
      const out = renderMiniHeatmapText(h, mode, () => (s) => s);
      expect(out).toContain('f␛]0;pwn␇\\u{202E}');
      expect(out).toContain('file f␛]0;pwn␇\\u{202E}');
      for (const ch of ['\u0007', '\u202E']) expect(out).not.toContain(ch);
    }
  });
});
