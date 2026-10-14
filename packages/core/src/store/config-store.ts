// Writing `.gotchea/config.json` (reading lives in config/load.ts).
import { access } from 'node:fs/promises';
import { defaultConfig } from '../config/load.js';
import type { GotcheaConfigInput } from '../config/schema.js';
import { writeFileAtomic } from './atomic-write.js';
import { canonicalJson } from './json.js';
import { repoPaths } from './paths.js';

/** Writes the config pretty-printed (caller's key order kept), atomically. */
export async function saveConfig(root: string, config: GotcheaConfigInput): Promise<void> {
  await writeFileAtomic(repoPaths(root).config, canonicalJson(config, { sortKeys: false }));
}

/** Writes `defaultConfig()` unless a config already exists. Returns whether it wrote. */
export async function initConfig(root: string): Promise<boolean> {
  try {
    await access(repoPaths(root).config);
    return false;
  } catch {
    await saveConfig(root, defaultConfig());
    return true;
  }
}
