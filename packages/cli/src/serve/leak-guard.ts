// Defence in depth for the serve API (PLAN §6): the documents are copied field by field in
// core, but every body is still scanned for answer-bearing keys before it leaves the process.
import { FORBIDDEN_KEYS } from 'gotchea-core';

/** Keys no API response may carry, at any depth: the answer keys plus question text. */
export const SERVE_FORBIDDEN_KEYS: readonly string[] = [...FORBIDDEN_KEYS, 'options', 'stem'];

const FORBIDDEN = new Set(SERVE_FORBIDDEN_KEYS);

/** The first forbidden key found anywhere in `value`, or null when it is clean. */
export function forbiddenKeyIn(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = forbiddenKeyIn(v);
      if (hit !== null) return hit;
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.has(k)) return k;
      const hit = forbiddenKeyIn(v);
      if (hit !== null) return hit;
    }
  }
  return null;
}
