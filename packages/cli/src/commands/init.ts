// `gotchea init`: shared state in `.gotchea/` (committed), personal state in ~/.gotchea.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  GOTCHEA_DIR,
  computeRepoId,
  defaultConfig,
  findIgnoredPaths,
  initConfig,
  repoPaths,
  saveConfig,
  userPaths,
} from 'gotchea-core';
import type { CommandContext } from '../context.js';

export interface InitOptions {
  force?: boolean;
}

/** Shared files that must stay committable. */
const MUST_TRACK = [`${GOTCHEA_DIR}/config.json`, `${GOTCHEA_DIR}/chunks.json`, `${GOTCHEA_DIR}/questions/`];

export async function initCommand(ctx: CommandContext, opts: InitOptions): Promise<void> {
  const { pc, out, warn } = ctx;
  const root = ctx.dir;
  const paths = repoPaths(root);
  const rel = (p: string) => relative(root, p).split('\\').join('/');

  await mkdir(paths.questionsDir, { recursive: true });
  // Keeps the (initially empty) questions/ directory in git.
  const keep = join(paths.questionsDir, '.gitkeep');
  if (!(await access(keep).then(() => true, () => false))) await writeFile(keep, '');

  if (opts.force) {
    await saveConfig(root, defaultConfig());
    out(`${pc.green('✔')} Wrote ${rel(paths.config)} (defaults, overwritten by --force)`);
  } else if (await initConfig(root)) {
    out(`${pc.green('✔')} Wrote ${rel(paths.config)} (defaults)`);
  } else {
    out(`${pc.dim('•')} Kept existing ${rel(paths.config)} (use --force to reset it to the defaults)`);
  }
  out(`${pc.green('✔')} Questions directory: ${rel(paths.questionsDir)}/`);

  const ignored = await findIgnoredPaths(root, MUST_TRACK, { onWarning: warn });
  if (ignored.length > 0) {
    warn(`${GOTCHEA_DIR}/ is ignored by git, but it holds shared state and should be committed.`);
    for (const hit of ignored) {
      const where = hit.source ? ` (${hit.source}${hit.line ? `:${hit.line}` : ''}: ${hit.pattern ?? '?'})` : '';
      warn(`  ${hit.path} is ignored${where}`);
    }
    warn(`Remove or negate the matching rule(s) so ${GOTCHEA_DIR}/ can be committed.`);
  } else {
    out(`${pc.green('✔')} ${GOTCHEA_DIR}/ is not git-ignored: commit it to share chunks and questions`);
  }

  const repoId = await computeRepoId(root);
  out(`${pc.dim('•')} Personal progress will live in ${userPaths(repoId, ctx.io.env).repoDir} (repoId ${repoId}, never committed)`);
  out();
  out(`Next: ${pc.bold('gotchea scan')} to chunk the repository, then ${pc.bold('gotchea map')}.`);
}
