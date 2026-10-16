# End-to-end harness

Build the local CLI before running these opt-in tests from the repository root:

```sh
pnpm build
pnpm e2e
pnpm e2e:published
GOTCHEA_TARGET=version:0.1.0 pnpm --filter gotchea-e2e test
```

Local mode executes `node <repoRoot>/packages/cli/dist/index.js mcp`.
Published/version modes execute `npx -y gotchea@latest mcp` or the selected version;
these modes require registry access and install the selected package automatically.
The root unit-test configuration stays separate so running `pnpm test` needs no built CLI.

Every `createHarness()` copies `fixtures/sample-repo` into a fresh OS temporary directory,
creates a git repository and initial commit, runs `gotchea init`, and starts a new MCP
stdio process. Each fixture has a separate temporary `HOME`, `USERPROFILE`, and
`GOTCHEA_HOME`; caller-supplied home overrides cannot escape that directory.
Git configuration and commit identities are also isolated. Call `dispose()` from
`afterEach` or `finally` to close the child and remove all temporary files.

```ts
import { createHarness } from './src/harness.js';

const harness = await createHarness({ now: '2030-01-01T00:00:00.000Z' });
try {
  await harness.callTool('scan');
  const status = await harness.callTool('get_status');
  await harness.restart('2030-01-15T00:00:00.000Z');
  // The new child keeps the same repository and personal progress.
} finally {
  await harness.dispose();
}
```

Use `harness.client` for raw SDK methods, `callTool()` for results that reject tool
errors, `runCli([...])` for isolated CLI setup, and `harness.stderr` for bounded
server diagnostics. `createFixture()` supports scenarios that need their own process
management. `{ initialize: false }` starts against an uninitialized repository.
Published releases support time travel only if they include `GOTCHEA_NOW` support.

## Contract and scenarios

`test/contract.test.ts` compares the live SDK `tools/list` response (all tool names
and complete input schemas) with `contract/tools.snapshot.json`. Removed or renamed
tools, new required parameters, and any other input-schema drift fail the test.
Review intentional changes against [CONTRACT.md](contract/CONTRACT.md), then refresh:

```sh
pnpm e2e:update-contract
# Equivalent, from the repository root:
UPDATE_CONTRACT=1 pnpm --filter gotchea-e2e test -- test/contract.test.ts
```

The update command requires a built target just like the tests. Normal test runs
never create or update the snapshot. Review the resulting JSON diff before committing.

`happy-path.test.ts` checks known fixture function locations, grey → red → green,
and green-leaf coverage computed from `get_status` (the tool has no percentage field).
Questions are deterministic local fixtures; no LLM or provider credentials are used.
Correct answers are selected by matching the generated option text after shuffling.

`security-leak.test.ts` checks all seven pre-answer tool responses recursively,
including structured content, JSON text payloads, partial pools with existing stems,
and rejected save items. It uses the current core `FORBIDDEN_KEYS` list and a private
explanation sentinel. Shuffle verification completes eight sessions and checks the
same question IDs across them; it does not confuse a resumed session with a fresh one.
There is a residual random false-failure probability of at most `24^-7` per question.

`storage.test.ts` completes quizzes, checks shared files in the fixture repo, verifies
that the only progress file is under the redirected HOME, and checks persistence after
restarting the MCP server. See [VERIFICATION.md](VERIFICATION.md) for execution limits.

The Vitest reporter rewrites `e2e/report.md` after each run with scenario names,
pass/fail/skip status, milliseconds, and error summaries. Collection and unhandled
errors are included, so a startup failure is visible in the report too.

`time-decay.test.ts` checks the engine formula immediately around both color
thresholds, repeated pass multipliers, and below-threshold failures. For registry
targets it probes persisted question timestamps first: if `GOTCHEA_NOW` is ignored,
only the time-travel case is skipped with a limitation annotation in the report.
An unsupported clock on the local target fails. Stability tests still run on all targets.

`code-changes.test.ts` expects grey after small and large edits: any hash change makes
every question stale, and PLAN colors a chunk with no `ok` questions grey (see E-01/E-02
in [FINDINGS.md](FINDINGS.md)).
Whitespace and comment edits separately check that color, hash and usable stems persist.
`error-cases.test.ts` checks rejection messages and follow-up tool calls in the same process.

`performance.test.ts` records 100 sequential lookup round trips (nearest-rank p95,
including MCP transport) and a cold scan of 200 generated TypeScript files. Scan
fixture generation is outside the measured interval. Only lookup p95 has a timing
assertion; both measurements appear in `report.md` through test annotations.
Concurrent test workers and host load can affect these timings.

The real agent smoke is disabled by default. To explicitly run it:

```sh
GOTCHEA_AGENT_SMOKE=1 pnpm --filter gotchea-e2e test -- test/agent-smoke.test.ts
```

This invokes `claude -p` and can incur provider charges. Install Claude Code and
supply authentication through supported environment credentials (for example
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`); the temporary HOME and
`CLAUDE_CONFIG_DIR` deliberately isolate persisted user settings. The test disables
built-in tools and allows only gotchea `get_generation_tasks` and `save_questions`
through a strict MCP config. It validates one full saved batch, schema, English
trivia patterns, reference ranges, and a maximum option-length ratio of 3:1.
These checks are heuristics, not a semantic assessment of generated answers.
