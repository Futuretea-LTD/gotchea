// String helpers: many tiny functions (each well under 15 LOC) so the chunker
// has to merge them into group chunks once the file exceeds leafMaxLoc.
import { clamp } from './math.js';

export function slugify(input: string): string {
  const lowered = input.trim().toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = dashed.replace(/^-+|-+$/g, '');
  if (trimmed.length === 0) {
    return 'untitled';
  }
  return trimmed;
}

export function capitalize(input: string): string {
  if (input.length === 0) {
    return input;
  }
  const head = input.charAt(0).toUpperCase();
  const tail = input.slice(1);
  return head + tail;
}

export function camelCase(input: string): string {
  const parts = input.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  const [first, ...rest] = parts;
  const head = first!.toLowerCase();
  return head + rest.map((p) => capitalize(p.toLowerCase())).join('');
}

export function kebabCase(input: string): string {
  const spaced = input.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = spaced.split(/[\s_]+/).filter(Boolean);
  const lowered = words.map((w) => w.toLowerCase());
  const joined = lowered.join('-');
  return joined;
}

export function snakeCase(input: string): string {
  const kebab = kebabCase(input);
  const snake = kebab.replace(/-/g, '_');
  if (snake.startsWith('_')) {
    return snake.slice(1);
  }
  return snake;
}

export function truncate(input: string, max: number): string {
  const limit = clamp(max, 1, 10_000);
  if (input.length <= limit) {
    return input;
  }
  const cut = input.slice(0, limit - 1);
  return `${cut}…`;
}

export function padLeft(input: string, width: number, fill = ' '): string {
  if (fill.length !== 1) {
    throw new Error('fill must be a single character');
  }
  const missing = width - input.length;
  if (missing <= 0) {
    return input;
  }
  return fill.repeat(missing) + input;
}

export function padRight(input: string, width: number, fill = ' '): string {
  if (fill.length !== 1) {
    throw new Error('fill must be a single character');
  }
  const missing = width - input.length;
  if (missing <= 0) {
    return input;
  }
  return input + fill.repeat(missing);
}

export function reverse(input: string): string {
  const chars = Array.from(input);
  chars.reverse();
  const joined = chars.join('');
  return joined;
}

export function isBlank(input: string | null | undefined): boolean {
  if (input === null || input === undefined) {
    return true;
  }
  const trimmed = input.trim();
  return trimmed.length === 0;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// wordWrap is deliberately longer than mergeBelowLoc so it breaks the run of
// tiny helpers and stays a symbol of its own.
export function wordWrap(input: string, width: number): string[] {
  const limit = Math.max(1, width);
  const words = input.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

export function stripTags(input: string): string {
  const withoutTags = input.replace(/<[^>]*>/g, '');
  const collapsed = withoutTags.replace(/\s+/g, ' ');
  const trimmed = collapsed.trim();
  return trimmed;
}

export function escapeHtml(input: string): string {
  const amp = input.replace(/&/g, '&amp;');
  const lt = amp.replace(/</g, '&lt;');
  const gt = lt.replace(/>/g, '&gt;');
  const quot = gt.replace(/"/g, '&quot;');
  return quot.replace(/'/g, '&#39;');
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  const letters = parts.map((p) => p.charAt(0).toUpperCase());
  return letters.slice(0, 3).join('');
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) {
    return email;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.charAt(0)}${'*'.repeat(local.length - 1)}${domain}`;
}

export function pluralize(word: string, count: number): string {
  if (count === 1) {
    return word;
  }
  if (word.endsWith('y') && !/[aeiou]y$/.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function compareIgnoreCase(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export function startsWithAny(input: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (input.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function ensureSuffix(input: string, suffix: string): string {
  if (suffix.length === 0) {
    return input;
  }
  const has = input.endsWith(suffix);
  return has ? input : input + suffix;
}

export function removePrefix(input: string, prefix: string): string {
  if (prefix.length === 0) {
    return input;
  }
  const has = input.startsWith(prefix);
  return has ? input.slice(prefix.length) : input;
}

export function squish(input: string): string {
  const lines = input.split('\n');
  const trimmed = lines.map((l) => l.trim());
  const nonEmpty = trimmed.filter((l) => l.length > 0);
  return nonEmpty.join(' ');
}

export function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function randomId(length: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet.charAt(state % alphabet.length);
  }
  return out;
}

export function lines(input: string): string[] {
  const normalized = input.replace(/\r\n?/g, '\n');
  const split = normalized.split('\n');
  if (split[split.length - 1] === '') {
    split.pop();
  }
  return split;
}

export function indent(input: string, spaces: number): string {
  const pad = ' '.repeat(Math.max(0, spaces));
  const out = lines(input).map((l) => (l.length > 0 ? pad + l : l));
  return out.join('\n');
}
