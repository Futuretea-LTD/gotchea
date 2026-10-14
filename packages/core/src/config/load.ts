// Config loading: `.gotchea/config.json` merged over defaults and validated.
import { readFile } from 'node:fs/promises';
import { ConfigSchema, type GotcheaConfig, type GotcheaConfigInput } from './schema.js';
import { repoPaths } from '../store/paths.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** The full default config. Returns a fresh object on every call. */
export function defaultConfig(): GotcheaConfig {
  return ConfigSchema.parse({});
}

/** Validates partial input and fills defaults (nested objects merge, arrays replace). */
export function resolveConfig(input: unknown = {}): GotcheaConfig {
  const result = ConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid gotchea config: ${issues}`);
  }
  return result.data;
}

/**
 * Deep-merges `override` into `base` (plain objects merge, everything else replaces)
 * and validates the result. Useful for CLI flag overrides on top of a loaded config.
 */
export function mergeConfig(base: GotcheaConfigInput, override: GotcheaConfigInput): GotcheaConfig {
  return resolveConfig(deepMerge(base, override));
}

/** Reads `<root>/.gotchea/config.json`; a missing file yields the defaults. */
export async function loadConfig(root: string): Promise<GotcheaConfig> {
  const file = repoPaths(root).config;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, '')); // Windows editors often save with a BOM
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  return resolveConfig(json);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}
