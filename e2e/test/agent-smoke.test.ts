import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { QuestionsFileV2Schema, RawQuestionSchema } from '../../packages/core/src/generate/schema.js';
import type { GenerationTaskOut } from '../../packages/mcp/src/schemas.js';
import { createHarness } from '../src/harness.js';

const exec = promisify(execFile);
const smokeFlag = process.env['GOTCHEA_AGENT_SMOKE'];
const allowedTools = ['mcp__gotchea__get_generation_tasks', 'mcp__gotchea__save_questions'];
const triviaPatterns = [
  /\b(?:line\s+numbers?|which\s+line|at\s+what\s+line)\b/i,
  /\b(?:variable|function|method|class|file|module)\s+(?:name|named|called)\b/i,
  /\bname\s+of\s+(?:the\s+)?(?:variable|function|method|class|file|module)\b/i,
  /\bhow\s+many\s+(?:lines|parameters|arguments)\b/i,
];

describe.skipIf(!smokeFlag)('real Claude Code generation smoke (explicit opt-in)', () => {
  // Values such as "0" must never accidentally start a paid agent session.
  it.skipIf(smokeFlag !== '1')('saves schema-valid, non-trivia questions using only gotchea MCP tools', async () => {
    const harness = await createHarness();
    try {
      await harness.callTool('scan');
      const pending = (await harness.callTool('get_generation_tasks', { limit: 10, lang: 'en' }))
        .structuredContent as { tasks: GenerationTaskOut[] };
      expect(pending.tasks.length).toBeGreaterThan(0);
      await harness.stop();

      const configPath = join(harness.fixture.directory, 'claude-mcp.json');
      await writeFile(configPath, JSON.stringify({
        mcpServers: { gotchea: { type: 'stdio', command: harness.target.command, args: [...harness.target.args, 'mcp'] } },
      }), { mode: 0o600 });

      const prompt = [
        'Use gotchea get_generation_tasks with limit=1 and lang="en" for this already scanned fixture.',
        'Generate the entire requested question batch for that single task, following its instructions and typePlan.',
        'Call gotchea save_questions with the provided chunkId and chunkHash.',
        'If questions are rejected, fix and resubmit them until the requested count is saved.',
        'Test behavior and understanding; never ask about line numbers, identifier names or parameter counts.',
        'Use four plausible options with similar lengths. Do not quote the questions or answer keys in your final response.',
        'Stop after successfully saving this one batch and report only the saved count.',
      ].join('\n');
      const { stdout } = await exec('claude', [
        '-p', prompt,
        '--output-format', 'json',
        '--tools', '',
        '--allowedTools', allowedTools.join(','),
        '--permission-mode', 'dontAsk',
        '--strict-mcp-config', '--mcp-config', configPath,
        '--setting-sources', '',
        '--disable-slash-commands', '--no-session-persistence',
      ], {
        cwd: harness.fixture.root,
        env: { ...harness.fixture.env, CLAUDE_CONFIG_DIR: join(harness.fixture.home, '.claude') },
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const result = JSON.parse(stdout) as { is_error?: boolean; subtype?: string };
      expect(result.is_error, `Claude run failed (${result.subtype ?? 'unknown result'}); check Claude authentication and MCP availability`).toBe(false);

      const directory = join(harness.fixture.root, '.gotchea', 'questions');
      const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
      expect(files, 'Claude must successfully call save_questions for exactly one task').toHaveLength(1);
      const pool = QuestionsFileV2Schema.parse(JSON.parse(await readFile(join(directory, files[0]!), 'utf8')));
      const task = pending.tasks.find((candidate) => candidate.chunkId === pool.chunkId);
      expect(task, 'Saved questions must belong to a real generation task').toBeDefined();
      expect(pool.questions).toHaveLength(task!.count);
      expect(pool.questions.map((question) => question.type).sort()).toEqual([...task!.typePlan].sort());
      for (const question of pool.questions) {
        // Validate the submitted fields too: the storage schema permits legacy empty strings.
        RawQuestionSchema.parse({
          type: question.type, stem: question.stem, options: question.options,
          correctIndex: question.correctIndex, explanation: question.explanation,
          refs: question.refs, difficulty: question.difficulty,
        });
        expect(question.chunkHash).toBe(task!.chunkHash);
        expect(question.lang).toBe('en');
        expect(question.status).toBe('ok');
        for (const pattern of triviaPatterns) expect(question.stem, `Trivia detected (${pattern.source})`).not.toMatch(pattern);
        const lengths = question.options.map((option) => option.trim().length);
        // A 3:1 bound catches conspicuous answer-length clues while allowing concise alternatives.
        expect(Math.max(...lengths) / Math.min(...lengths), 'Option lengths should be balanced').toBeLessThanOrEqual(3);
        expect(question.refs.every((ref) => ref.start >= 1 && ref.end >= ref.start && ref.end <= task!.lineCount)).toBe(true);
      }
    } finally {
      await harness.dispose();
    }
  }, 300_000);
});
