// Turns a user-given target (relative to the working directory) into a repo-relative chunk filter.
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { toPosixPath } from 'gotchea-core';
import { CliError } from './context.js';

/** A path relative to the working directory (optionally `#symbol`) as a repo-relative chunk-id prefix. */
export async function toFilter(arg: string, dir: string, root: string): Promise<string> {
  const hash = arg.indexOf('#');
  const pathPart = hash < 0 ? arg : arg.slice(0, hash);
  // Compare real paths so a symlinked checkout (macOS /tmp → /private/tmp) is still "inside".
  const rel = relative(await realpathOrSelf(root), await realpathOrSelf(resolve(dir, pathPart)));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CliError(`path is outside the repository: ${arg}`);
  const base = toPosixPath(rel);
  return hash < 0 ? base : `${base}${arg.slice(hash)}`;
}

/** Real path of `p`, resolving the nearest existing ancestor when `p` itself does not exist. */
async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : resolve(await realpathOrSelf(parent), basename(p));
  }
}
