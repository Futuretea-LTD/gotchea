// Chunk id helpers (PLAN.md §4). Ids are POSIX, NFC-normalized and never contain line numbers.
import { createHash } from 'node:crypto';

export const ROOT_MODULE_ID = '.';
export const TOP_SEGMENT = '~top';
export const BODY_SEGMENT = '~body';
export const GROUP_PREFIX = '~group:';

/** Repo-relative POSIX path: backslashes to slashes, NFC, no leading `./`, no trailing slash. */
export function toPosixPath(p: string): string {
  let out = p.normalize('NFC').replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  out = out.replace(/\/+/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out === '' ? ROOT_MODULE_ID : out;
}

/** Directory of a repo-relative path; `.` for top-level entries. */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? ROOT_MODULE_ID : path.slice(0, i);
}

/** `path#Outer.Inner`; an empty symbol path is the file id itself. */
export function symbolChunkId(path: string, symbolPath: readonly string[]): string {
  return symbolPath.length === 0 ? path : `${path}#${symbolPath.join('.')}`;
}

export function groupSegment(firstMember: string): string {
  return `${GROUP_PREFIX}${firstMember}`;
}

/** Strips the `@2` duplicate suffix from a symbol segment. */
export function baseSymbolName(segment: string): string {
  const at = segment.lastIndexOf('@');
  return at > 0 && /^\d+$/.test(segment.slice(at + 1)) ? segment.slice(0, at) : segment;
}

/**
 * `.gotchea/questions/<slug>--<sha1(id)[0..8]>.json`. The slug keeps only ASCII
 * `[A-Za-z0-9_-]`, so ids with `:`, `\`, `*`, `..` or non-ASCII names stay one
 * portable file inside the questions directory on every OS; the digest keeps it unique.
 */
export function questionFileName(chunkId: string): string {
  const slug = chunkId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const digest = createHash('sha1').update(chunkId).digest('hex').slice(0, 8);
  return `${slug}--${digest}.json`;
}
