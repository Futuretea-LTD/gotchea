// Lets callers answer "run `gotchea init`" instead of throwing.
import { access } from 'node:fs/promises';
import { repoPaths } from '../store/paths.js';

/** Whether `<repoRoot>/.gotchea/config.json` exists (what `gotchea init` writes). */
export async function isInitialized(repoRoot: string): Promise<boolean> {
  return access(repoPaths(repoRoot).config).then(
    () => true,
    () => false,
  );
}
