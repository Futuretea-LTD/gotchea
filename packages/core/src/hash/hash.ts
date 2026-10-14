// Content hashes and line fingerprints (PLAN.md §4, §5).
import { createHash } from 'node:crypto';
import { NORMALIZATION_VERSION } from './normalize.js';

/** sha256("n1\n" + lines.join("\n")) truncated to 16 hex chars. */
export function contentHash(normalizedLines: readonly string[]): string {
  return sha256Hex(`${NORMALIZATION_VERSION}\n${normalizedLines.join('\n')}`).slice(0, 16);
}

/** Module hash: sha256 of the sorted `id:hash` pairs of its children. */
export function moduleHash(children: readonly { id: string; contentHash: string }[]): string {
  const pairs = children.map((c) => `${c.id}:${c.contentHash}`).sort(compareCodeUnits);
  return sha256Hex(`${NORMALIZATION_VERSION}\n${pairs.join('\n')}`).slice(0, 16);
}

/** FNV-1a 32-bit over UTF-16 code units, as 8 hex chars. */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function lineFingerprints(normalizedLines: readonly string[]): string[] {
  return normalizedLines.map(fnv1a32);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Locale-independent ordering used everywhere determinism matters. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
