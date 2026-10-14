// `gotchea generate`: write questions for the chunks that need them through an LLM
// provider (M2_DESIGN.md §7). Output carries ids, counts and reason codes only,
// never stems, options, answer keys or explanations.
import {
  API_KEY_ENV,
  FsChunkStore,
  GenerateError,
  LangCodeSchema,
  PROVIDER_NAMES,
  ProviderError,
  createProvider as defaultCreateProvider,
  loadConfig,
  runGenerate,
  type ChunkReport,
  type CreateProvider,
  type GenerateReport,
  type GotcheaConfig,
  type LLMProvider,
  type ProviderName,
} from 'gotchea-core';
import { CliError, requireRepoRoot, type CommandContext } from '../context.js';
import { toJson } from '../render/json.js';

export interface GenerateOptions {
  chunk?: string;
  provider?: string;
  model?: string;
  lang?: string;
  limit?: string;
  /** commander: `--verify` → true, `--no-verify` → false, neither → undefined. */
  verify?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface GenerateDeps {
  createProvider?: CreateProvider;
}

const MCP_HINT =
  'Set it, pick another --provider, or generate from your coding agent through the MCP tools get_generation_tasks/save_questions (no API key needed).';

export async function generateCommand(ctx: CommandContext, opts: GenerateOptions, deps: GenerateDeps = {}): Promise<void> {
  const root = await requireRepoRoot(ctx.dir);
  const config = await loadConfig(root);
  if (!(await new FsChunkStore(root).load())) throw new CliError('nothing tracked yet: run `gotchea scan` first.');

  const providerName = parseProvider(opts.provider ?? config.provider.default);
  const lang = opts.lang ?? config.questions.lang;
  if (!LangCodeSchema.safeParse(lang).success) throw new CliError(`--lang: expected a language code such as en, tr or pt-BR, got "${lang}"`, 2);
  const limit = opts.limit === undefined ? undefined : parseLimit(opts.limit);
  const verify = opts.verify ?? config.questions.verify;

  // Providers are built before any work so a missing key fails fast (exit 2). A dry run needs none.
  const create = deps.createProvider ?? defaultCreateProvider;
  let provider: LLMProvider | undefined;
  let verifier: LLMProvider | null = null;
  if (!opts.dryRun) {
    provider = await buildProvider(create, providerName, config, ctx.io.env, opts.model);
    if (verify) {
      const verifyName = config.provider.verify ?? providerName;
      // --model applies to the generation provider only.
      verifier = verifyName === providerName ? provider : await buildProvider(create, verifyName, config, ctx.io.env, undefined);
    }
  }

  let report: GenerateReport;
  try {
    report = await runGenerate(root, {
      config,
      lang,
      dryRun: opts.dryRun ?? false,
      now: ctx.io.now(),
      verifier,
      ...(provider ? { provider } : {}),
      ...(opts.chunk !== undefined ? { chunkId: opts.chunk } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(opts.json ? {} : { onChunk: (r: ChunkReport) => printChunk(ctx, r) }),
    });
  } catch (err) {
    if (err instanceof GenerateError) throw new CliError(err.message);
    if (err instanceof ProviderError) throw new CliError(providerMessage(err, providerName), 2);
    throw err;
  }

  if (opts.json) ctx.io.stdout(toJson(toJsonReport(report)));
  else printSummary(ctx, report, verify);

  const attempted = report.chunks.filter((c) => c.skipped !== 'pool_full');
  if (!report.dryRun && attempted.length > 0 && attempted.every((c) => c.skipped === 'error')) {
    throw new CliError('every chunk failed; see the errors above.');
  }
}

function parseProvider(value: string): ProviderName {
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) return value as ProviderName;
  throw new CliError(`--provider: expected one of ${PROVIDER_NAMES.join(', ')}, got "${value}"`, 2);
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`--limit: expected a positive integer, got "${value}"`, 2);
  return n;
}

async function buildProvider(
  create: CreateProvider,
  name: ProviderName,
  config: GotcheaConfig,
  env: NodeJS.ProcessEnv,
  model: string | undefined,
): Promise<LLMProvider> {
  try {
    return await create(name, { config, env, ...(model !== undefined ? { model } : {}) });
  } catch (err) {
    if (err instanceof ProviderError) throw new CliError(providerMessage(err, name), 2);
    throw err;
  }
}

function providerMessage(err: ProviderError, name: ProviderName): string {
  return err.code === 'missing_api_key' ? `${API_KEY_ENV[name]} is not set. ${MCP_HINT}` : err.message;
}

/** `--json` shape (§7): ids, counts and reason codes only. Fields are copied explicitly. */
function toJsonReport(r: GenerateReport) {
  return {
    dryRun: r.dryRun,
    chunks: r.chunks.map((c) => ({
      chunkId: c.chunkId,
      requested: c.requested,
      saved: c.saved,
      flagged: c.flagged,
      rejected: c.rejected.map((x) => ({ attempt: x.attempt, index: x.index, reason: x.reason })),
      ...(c.skipped ? { skipped: c.skipped } : {}),
      ...(c.error ? { error: c.error } : {}),
      ...(c.typePlan ? { typePlan: [...c.typePlan] } : {}),
      ...(c.usable !== undefined ? { usable: c.usable } : {}),
      ...(c.target !== undefined ? { target: c.target } : {}),
    })),
    totals: { saved: r.totals.saved, rejected: r.totals.rejected, flagged: r.totals.flagged },
    remaining: r.remaining,
    changedSinceScan: [...r.changedSinceScan],
    verifyErrors: r.verifyErrors,
  };
}

/** `length_skew, trivia ×2` */
function reasonList(rejected: ChunkReport['rejected']): string {
  const counts = new Map<string, number>();
  for (const r of rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason)).join(', ');
}

function printChunk(ctx: CommandContext, r: ChunkReport): void {
  const { out, pc } = ctx;
  if (r.typePlan) {
    out(`${pc.dim('·')} ${r.chunkId}  ${r.requested} ${plural(r.requested, 'question')}: ${r.typePlan.join(', ')}`);
    return;
  }
  switch (r.skipped) {
    case 'pool_full':
      out(`${pc.dim('–')} ${r.chunkId}  pool full (${r.usable ?? 0}/${r.target ?? 0})`);
      return;
    case 'too_large':
    case 'too_small':
    case 'changed_since_scan':
      out(`${pc.dim('–')} ${r.chunkId}  skipped: ${r.error ?? r.skipped}`);
      return;
    case 'error':
      out(`${pc.red('✗')} ${r.chunkId}  ${pc.red('error:')} ${r.error ?? 'unknown error'}`);
      return;
  }
  const rejected = r.rejected.length > 0 ? ` (${reasonList(r.rejected)})` : '';
  const mark = r.saved > 0 ? pc.green('✓') : pc.yellow('!');
  out(`${mark} ${r.chunkId}  ${r.saved} saved · ${r.rejected.length} rejected${rejected} · ${r.flagged} flagged`);
  if (r.error) out(pc.dim(`    retry failed: ${r.error}`));
}

function printSummary(ctx: CommandContext, r: GenerateReport, verify: boolean): void {
  const { out, warn, pc } = ctx;
  if (r.chunks.length === 0) out('Nothing to generate: every eligible chunk has a full question pool.');
  if (!r.dryRun && r.chunks.some((c) => c.skipped === undefined)) {
    out();
    out(`Total: ${r.totals.saved} saved · ${r.totals.rejected} rejected · ${r.totals.flagged} flagged`);
  }
  if (r.dryRun && r.chunks.length > 0) out(pc.dim('Dry run: no provider was called and nothing was saved.'));
  if (r.remaining > 0) out(pc.dim(`${r.remaining} more ${plural(r.remaining, 'chunk')} need questions; run \`gotchea generate\` again.`));
  if (r.changedSinceScan.length > 0) {
    warn(`${r.changedSinceScan.length} ${plural(r.changedSinceScan.length, 'chunk')} changed since the last scan and were skipped; run \`gotchea scan\`.`);
  }
  if (verify && r.verifyErrors > 0) {
    warn(`blind verify failed for ${r.verifyErrors} ${plural(r.verifyErrors, 'question')}; they were saved unverified.`);
  }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
