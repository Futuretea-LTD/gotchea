// Temp copies of the fixture repos under test/fixtures/. A fixture's ignore file
// is stored as `gitignore` (a real nested `.gitignore` would hide the files it
// ignores from this repository) and renamed to `.gitignore` in the copy.
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FixtureName = 'ts-basic' | 'py-basic';

export const fixturePath = (name: FixtureName): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export interface FixtureRepo {
  /** Temp copy of the fixture. */
  root: string;
  /** Temp GOTCHEA_HOME (personal state). */
  home: string;
  env: NodeJS.ProcessEnv;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** Replaces exactly one occurrence of `from` (throws otherwise, so fixture drift is caught). */
  edit(path: string, from: string, to: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function copyFixture(name: FixtureName): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), `gotchea-${name}-`));
  const home = await mkdtemp(join(tmpdir(), 'gotchea-home-'));
  await cp(fixturePath(name), root, { recursive: true });
  await rename(join(root, 'gitignore'), join(root, '.gitignore'));
  const read = (path: string) => readFile(join(root, path), 'utf8');
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  return {
    root,
    home,
    env: { GOTCHEA_HOME: home },
    read,
    write,
    async edit(path, from, to) {
      const text = await read(path);
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`edit(${path}): expected 1 occurrence of ${JSON.stringify(from)}, found ${n}`);
      await write(path, text.replace(from, to));
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
