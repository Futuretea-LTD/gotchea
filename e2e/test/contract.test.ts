import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createHarness } from '../src/harness.js';

const snapshot = fileURLToPath(new URL('../contract/tools.snapshot.json', import.meta.url));

it('A: matches every advertised tool name, description, input/output schema and the server instructions against the reviewed contract', async () => {
  const harness = await createHarness();
  try {
    const result = await harness.client.listTools();
    const tools = result.tools.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })).sort((a, b) => a.name.localeCompare(b.name));
    expect(tools.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBeUndefined();
    // The display rules the agent is told to follow live in the descriptions and the server instructions: drift there changes behaviour.
    const contract = { instructions: harness.client.getInstructions(), tools };
    expect(contract.instructions).toBeTypeOf('string');
    if (process.env['UPDATE_CONTRACT'] === '1') {
      await mkdir(fileURLToPath(new URL('../contract/', import.meta.url)), { recursive: true });
      await writeFile(snapshot, `${JSON.stringify(contract, null, 2)}\n`);
    }
    expect(contract).toEqual(JSON.parse(await readFile(snapshot, 'utf8')));
  } finally {
    await harness.dispose();
  }
});
