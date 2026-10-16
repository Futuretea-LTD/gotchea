import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureSource = fileURLToPath(new URL('../fixtures/sample-repo/', import.meta.url));

export interface TargetCommand {
  command: string;
  args: string[];
}

/** Resolve argv without a shell, including registry versions supplied by callers. */
export function resolveTarget(target = process.env['GOTCHEA_TARGET'] ?? 'local'): TargetCommand {
  if (target === 'local') return { command: process.execPath, args: [join(repoRoot, 'packages/cli/dist/index.js')] };
  if (target === 'published') return { command: 'npx', args: ['-y', 'gotchea@latest'] };
  if (/^version:\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(target)) {
    return { command: 'npx', args: ['-y', `gotchea@${target.slice('version:'.length)}`] };
  }
  throw new Error(`Invalid GOTCHEA_TARGET: ${target}; expected local, published, or version:x.y.z`);
}

export interface Fixture {
  directory: string;
  root: string;
  home: string;
  env: Record<string, string>;
  dispose(): Promise<void>;
}

export async function createFixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'gotchea-e2e-'));
  const root = join(directory, 'repo');
  const home = join(directory, 'home');
  try {
    await cp(fixtureSource, root, { recursive: true });
    await mkdir(home);
    await writeFile(join(home, '.gitconfig'), '');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...extraEnv })) {
      // An inherited git worktree/config override would defeat fixture isolation.
      if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      GOTCHEA_HOME: join(home, '.gotchea'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      GIT_AUTHOR_NAME: 'Gotchea E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'Gotchea E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
    });
    await exec('git', ['init', '--quiet'], { cwd: root, env });
    await exec('git', ['add', '.'], { cwd: root, env });
    await exec('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(directory, 'hooks')}`, 'commit', '--quiet', '-m', 'Initial fixture'], { cwd: root, env });
    return { directory, root, home, env, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export interface HarnessOptions {
  target?: string;
  env?: NodeJS.ProcessEnv;
  /** ISO date or epoch milliseconds. Restarting preserves the fixture and progress. */
  now?: string | number;
  initialize?: boolean;
}

export class McpHarness {
  private connection: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private stderrText = '';

  constructor(readonly fixture: Fixture, readonly target: TargetCommand) {}

  get client(): Client {
    if (!this.connection) throw new Error('MCP server is not connected');
    return this.connection;
  }

  get stderr(): string { return this.stderrText; }

  async runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec(this.target.command, [...this.target.args, ...args], {
      cwd: this.fixture.root, env: this.fixture.env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
  }

  async start(now?: string | number): Promise<void> {
    if (this.connection || this.transport) throw new Error('MCP server already started; use restart()');
    if (now !== undefined) this.fixture.env['GOTCHEA_NOW'] = String(now);
    this.stderrText = '';
    const client = new Client({ name: 'gotchea-e2e', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: this.target.command, args: [...this.target.args, 'mcp'],
      cwd: this.fixture.root, env: this.fixture.env, stderr: 'pipe',
    });
    this.connection = client;
    this.transport = transport;
    transport.stderr?.on('data', (data: Buffer) => {
      // Keep startup diagnostics bounded even when testing a broken published server.
      this.stderrText = (this.stderrText + data.toString()).slice(-32_768);
    });
    try {
      await client.connect(transport, { timeout: 120_000 });
    } catch (error) {
      await this.stop();
      throw new Error(`MCP connection failed: ${String(error)}\n${this.stderrText}`, { cause: error });
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    if (result.isError) throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
    return result;
  }

  async stop(): Promise<void> {
    const client = this.connection;
    const transport = this.transport;
    this.connection = undefined;
    this.transport = undefined;
    try { await client?.close(); } finally { await transport?.close(); }
  }

  async restart(now?: string | number): Promise<void> {
    await this.stop();
    await this.start(now);
  }

  async dispose(): Promise<void> {
    try { await this.stop(); } finally { await this.fixture.dispose(); }
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<McpHarness> {
  const target = resolveTarget(options.target);
  const fixture = await createFixture(options.env);
  const harness = new McpHarness(fixture, target);
  try {
    if (options.now !== undefined) fixture.env['GOTCHEA_NOW'] = String(options.now);
    if (options.initialize !== false) await harness.runCli(['init']);
    await harness.start();
    return harness;
  } catch (error) {
    await harness.dispose();
    throw error;
  }
}
