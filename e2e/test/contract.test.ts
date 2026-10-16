import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createHarness } from '../src/harness.js';

const snapshot = fileURLToPath(new URL('../contract/tools.snapshot.json', import.meta.url));

it('A: matches every advertised tool name and input schema against the reviewed contract', async () => {
  const harness = await createHarness();
  try {
    const result = await harness.client.listTools();
    const tools = result.tools.map(({ name, inputSchema }) => ({ name, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
    expect(tools.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBeUndefined();
    if (process.env['UPDATE_CONTRACT'] === '1') {
      await mkdir(fileURLToPath(new URL('../contract/', import.meta.url)), { recursive: true });
      await writeFile(snapshot, `${JSON.stringify(tools, null, 2)}\n`);
    }
    expect(tools).toEqual(JSON.parse(await readFile(snapshot, 'utf8')));
  } finally {
    await harness.dispose();
  }
});
