import { resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { ConfigError, VERSION } from 'gotchea-core';
import { generateCommand, type GenerateDeps, type GenerateOptions } from './commands/generate.js';
import { initCommand, type InitOptions } from './commands/init.js';
import { mapCommand, type MapOptions } from './commands/map.js';
import { quizCommand, type QuizDeps, type QuizOptions } from './commands/quiz.js';
import { scanCommand, type ScanOptions } from './commands/scan.js';
import { serveCommand, type ServeDeps, type ServeOptions } from './commands/serve.js';
import { statusCommand, type StatusOptions } from './commands/status.js';
import { STUB_COMMANDS, stubCommand } from './commands/stubs.js';
import { CliError, createContext, processIo, type CliIo, type CommandContext, type GlobalOptions } from './context.js';

export { CliError, processIo, type CliIo } from './context.js';
export type { GenerateDeps } from './commands/generate.js';
export type { ServeDeps } from './commands/serve.js';
export type { RunningServer } from './serve/server.js';

/** Injection points for tests (e.g. a mock LLM provider). */
export type ProgramDeps = GenerateDeps & QuizDeps & ServeDeps;
export type { AnswerChoice, AnswerSource } from './quiz/answer-source.js';
export { ScriptedAnswerSource, type ScriptStep } from './quiz/scripted-source.js';
export type { MapJson, MapNode, StatusJson } from 'gotchea-core';

/** Command router. Commander errors are thrown (exitOverride) and mapped to exit codes by `run`. */
export function createProgram(io: CliIo = processIo(), deps: ProgramDeps = {}): Command {
  const program = new Command('gotchea')
    .description('Power your code memory: spaced-repetition comprehension quizzes for your codebase')
    .version(VERSION, '-V, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .option('--cwd <dir>', 'run as if gotchea was started in <dir>')
    .option('--no-color', 'disable colored output')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError('(run `gotchea --help` for usage)');

  // Runs a command body with the shared context built from the global options.
  const action =
    <A extends unknown[]>(fn: (ctx: CommandContext, ...args: A) => Promise<void> | void) =>
    async (...args: unknown[]): Promise<void> => {
      const cmd = args[args.length - 1] as Command;
      const ctx = await createContext(io, cmd.optsWithGlobals<GlobalOptions>());
      await fn(ctx, ...(args.slice(0, -1) as A));
    };

  program
    .command('init')
    .description('create .gotchea/ with the default config and the questions directory')
    .option('-f, --force', 'overwrite an existing config with the defaults')
    .action(action((ctx, opts: InitOptions) => initCommand(ctx, opts)));

  program
    .command('scan')
    .description('chunk the repository and update .gotchea/chunks.json, stale questions and progress decay')
    .option('--json', 'print the scan summary as JSON')
    .action(action((ctx, opts: ScanOptions) => scanCommand(ctx, opts)));

  program
    .command('status')
    .description('show tracked chunks, questions, what is due and the color distribution')
    .option('--json', 'print machine-readable JSON')
    .action(action((ctx, opts: StatusOptions) => statusCommand(ctx, opts)));

  program
    .command('map')
    .description('show the comprehension heat map (repo > module > file > symbol)')
    .argument('[path]', 'only show this directory, file or chunk id (relative to the working directory)')
    .option('--json', 'print machine-readable JSON')
    .action(action((ctx, path: string | undefined, opts: MapOptions) => mapCommand(ctx, path, opts)));

  program
    .command('generate')
    .description('generate questions with an LLM provider for the chunks that need them most')
    .option('--chunk <id>', 'only this leaf chunk (id or alias)')
    .option('--provider <name>', 'anthropic | openai | openai-compatible (default: config provider.default)')
    .option('--model <id>', 'model id (default: config provider.models[provider])')
    .option('--lang <code>', 'question language code, e.g. en, tr, pt-BR (default: config questions.lang)')
    .option('--limit <n>', 'most chunks to process (default: config generate.maxChunksPerRun)')
    .option('--verify', 'blind-verify each saved question with a second request (flags disagreements)')
    .option('--no-verify', 'skip the blind verify even if config questions.verify is on')
    .option('--dry-run', 'show the chunks and question counts that would be requested; call no provider')
    .option('--json', 'print machine-readable JSON (counts and reason codes only)')
    .action(action((ctx, opts: GenerateOptions) => generateCommand(ctx, opts, deps)));

  program
    .command('quiz')
    .description('quiz yourself on a chunk (the one that most needs review under the target, if none is named)')
    .argument('[target]', 'directory, file or chunk id (relative to the working directory)')
    .option('--count <n>', 'questions in this quiz (1-10; clamped to the chunk size)')
    .option('--lang <code>', 'question language code, e.g. en, tr, pt-BR (default: config questions.lang)')
    .option('--new', "don't resume an unfinished quiz")
    .action(action((ctx, target: string | undefined, opts: QuizOptions) => quizCommand(ctx, target, opts, deps)));

  program
    .command('serve')
    .description('serve the web heat map on http://127.0.0.1 (read-only) until Ctrl+C')
    .argument('[path]', 'repository directory to serve (default: the working directory)')
    .option('--port <n>', 'port to listen on, 0 for any free one (default: 4477)')
    .option('--no-open', "don't open the browser")
    .action(action((ctx, path: string | undefined, opts: ServeOptions) => serveCommand(ctx, path, opts, deps)));

  // No shared context here: stdout must carry nothing but JSON-RPC once the server starts.
  program
    .command('mcp')
    .description('start the MCP server on stdio (for Claude Code, Codex and other MCP clients)')
    .action(async (_opts: unknown, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<GlobalOptions>();
      const { startStdioServer } = await import('gotchea-mcp');
      await startStdioServer({ root: resolve(io.cwd, cwd ?? '.') });
    });

  for (const stub of STUB_COMMANDS) {
    const cmd = program.command(stub.args ? `${stub.name} ${stub.args}` : stub.name);
    cmd
      .description(`${stub.description} (not implemented yet, ${stub.milestone})`)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(action((ctx) => stubCommand(ctx, stub)));
  }

  return program;
}

/** Parses `argv` (user arguments only, without `node gotchea`) and returns the exit code. */
export async function run(argv: readonly string[], io: CliIo = processIo(), deps: ProgramDeps = {}): Promise<number> {
  const program = createProgram(io, deps);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    // Help, version and usage errors were already printed by commander.
    if (err instanceof CommanderError) return err.exitCode;
    const colors = pc.createColors(io.color && !argv.includes('--no-color'));
    const known = err instanceof CliError || err instanceof ConfigError;
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`${colors.red('error:')} ${message}\n`);
    if (!known && io.env['GOTCHEA_DEBUG'] && err instanceof Error && err.stack) io.stderr(`${err.stack}\n`);
    return err instanceof CliError ? err.exitCode : 1;
  }
}
