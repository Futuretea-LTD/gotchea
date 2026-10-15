// Atomic file writes (tmp + rename) and tolerant JSON reads.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Creates parent dirs, writes `<path>.<pid>.<random>.tmp`, then renames over `path`. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await renameRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Windows refuses a rename over a file that another handle holds (antivirus, the search
// indexer, a concurrent writer replacing the same file) with EPERM/EACCES/EBUSY, briefly.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 7;

/** `rename` that retries those transient errors with backoff (about 1.3 s in total). */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || code === undefined || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

/** Parses a JSON file; `null` if it does not exist. Other errors (incl. bad JSON) throw. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`, { cause: err });
  }
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
