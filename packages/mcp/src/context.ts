// State shared by the tool handlers of one server instance.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ChunkIndex,
  FsChunkStore,
  FsSessionStore,
  QuizSessions,
  computeRepoId,
  ensureReconciled,
  isInitialized,
  loadConfig,
  type QuizOpsDeps,
  type Rng,
} from 'gotchea-core';

export interface ServerOptions {
  /** Repository root; defaults to `process.cwd()`. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Randomness for question order and option permutations; tests only. */
  rng?: Rng;
  /**
   * Elicitation is optional and capability-gated: `auto` (default) offers a multiple-choice prompt only
   * when the connected client advertises `elicitation`; `off` never does. Env: GOTCHEA_MCP_ELICIT=off.
   */
  elicitation?: 'auto' | 'off';
}

export interface ToolContext {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  now(): Date;
  /** The in-memory index built at server start (null until the repo has been scanned). */
  index(): Promise<ChunkIndex | null>;
  /** Rebuilds the index from chunks.json; called after a scan. */
  reloadIndex(): Promise<void>;
  readonly elicitation: 'auto' | 'off';
  /** Reconciles progress with chunks.json under the repo lock (one JSON read when nothing changed). */
  reconcile(): Promise<void>;
  /** Quiz engine deps. Sessions live in memory (write-through) and are recovered from disk on first use. */
  quiz(): Promise<QuizOpsDeps>;
  /** Recovers sessions from ~/.gotchea/repos/<id>/sessions/ at server start; never throws. */
  warm(): Promise<void>;
}

export function createToolContext(opts: ServerOptions = {}): ToolContext {
  const root = opts.root ?? process.cwd();
  const load = async (): Promise<ChunkIndex | null> => {
    if (!(await isInitialized(root))) return null;
    const file = await new FsChunkStore(root).load();
    return file ? new ChunkIndex(file.chunks) : null;
  };
  // Built once, eagerly; a load failure surfaces from the first tool call instead of crashing startup.
  let index = load();
  index.catch(() => undefined);
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  let sessions: Promise<QuizSessions> | null = null;
  const openSessions = async (): Promise<QuizSessions> => {
    const config = await loadConfig(root);
    const store = new FsSessionStore(await computeRepoId(root), env);
    const s = QuizSessions.fromConfig(store, config.quiz, { now, cache: true, ...(opts.rng ? { rng: opts.rng } : {}) });
    await s.recover();
    return s;
  };
  const elicitation = opts.elicitation ?? (env['GOTCHEA_MCP_ELICIT'] === 'off' ? 'off' : 'auto');
  return {
    root,
    env,
    now,
    elicitation,
    reconcile: async () => {
      if (await isInitialized(root)) await ensureReconciled(root, { env });
    },
    quiz: async () => {
      sessions ??= openSessions();
      try {
        const s = await sessions;
        return { sessions: s, origin: 'mcp', config: await loadConfig(root), env, now, ...(opts.rng ? { rng: opts.rng } : {}) };
      } catch (err) {
        sessions = null;
        throw err;
      }
    },
    warm: async () => {
      if (!(await isInitialized(root))) return;
      sessions ??= openSessions();
      await sessions.catch(() => {
        sessions = null;
      });
    },
    // Retry only while the startup result is empty or failed (e.g. `gotchea scan` run from a shell after the
    // server started); once an index is built it is reused.
    index: async () => {
      const cached = await index.catch(() => null);
      if (cached) return cached;
      index = load();
      return index;
    },
    reloadIndex: async () => {
      index = load();
      await index;
    },
  };
}

export const INIT_MESSAGE = 'gotchea is not initialized in this repository. Run `gotchea init`, then `gotchea scan`.';
export const SCAN_MESSAGE = 'No scan yet. Call the `scan` tool (or run `gotchea scan`) first.';

export function textResult<T extends Record<string, unknown>>(text: string, structuredContent: T): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

/** A tool body that never throws: unexpected failures become `isError` text results. */
export function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return fn().catch((err: unknown) => ({
    isError: true,
    content: [{ type: 'text' as const, text: `gotchea: ${err instanceof Error ? err.message : String(err)}` }],
  }));
}
