# AGENTS.md

Instructions for coding agents working **on** the gotchea repository. (To *use* gotchea from an agent, see [docs/claude-code.md](docs/claude-code.md) and [docs/codex.md](docs/codex.md).)

Read [PLAN.md](PLAN.md) before larger changes: §2 is the layout, §6 the answer-key rules, §10 the recorded decisions. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the release flow.

## Packages

| Directory | npm package | Role |
|---|---|---|
| `packages/core` | `gotchea-core` | The engine: config, walker, parsers, chunking, hashing, scan, stores, generation, quiz, scoring, map JSON |
| `packages/cli` | `gotchea` | The CLI (commander), `gotchea mcp`, `gotchea serve`; bundles the web UI into `dist/web/` |
| `packages/mcp` | `gotchea-mcp` | The MCP server (`@modelcontextprotocol/sdk`, stdio), one file per tool in `src/tools/` |
| `packages/web` | `gotchea-web` (private, never published) | The treemap UI served by `gotchea serve` |

## Dependency direction (PLAN §2)

- `cli`, `mcp` and `web` depend on `core`. **`core` never imports from an interface package.**
- `cli` may depend on `mcp` (for `gotchea mcp`). `web` is only a build-order devDependency of `cli`, and `web` imports only *types* from `core`.
- Inside `core`, `score/` and `quiz/select.ts` import nothing from `parse/`, `chunk/` or `generate/`. `score/` is pure: `now` is always injected, no I/O.
- `core/src/index/chunk-index.ts` must not import `web-tree-sitter` (fast cold start; guarded by `core/test/index/chunk-index.test.ts`).
- `core/src/index.ts` is the public API. Question stores and `QuestionPrivate` live behind `gotchea-core/internal`, which is for the CLI and tests only. **`mcp` and `web` must not import `gotchea-core/internal`.**
- Shared shapes live in core (`map/json.ts`: `MapJson`, `StatusJson`) so `map --json`, MCP `get_map`, `GET /api/map` and the web UI stay one shape.

## Answer-key isolation (PLAN §6)

This is the product's core promise. Treat any violation as a release blocker.

- **No agent-facing or user-facing output may contain `correctIndex`, `explanation` (or any other key in `FORBIDDEN_KEYS`, `core/src/quiz/views.ts`) before the question has been answered.** That covers every MCP tool result, every CLI `--json` output and every `serve` API response.
- Interfaces get questions only through the public views (`toPublicView`): id, position, stem and shuffled options. The reveal (`correct`, correct display index, explanation, refs) exists only in `submit_answer` / `RevealView`, for the question just answered.
- Every MCP tool output is checked against a `.strict()` zod schema in `packages/mcp/src/schemas.ts`. Public views go through `assertPublicView` (strict parse plus a deep scan for forbidden keys). Don't loosen these schemas to make a test pass.
- Quiz sessions are server-side. Clients see display indexes only; the permutation maps them back.
- Generation tasks expose existing **stems only** (for dedupe), never options or answers. `generate` and `save_questions` report counts and reason codes, never echo question text.
- `gotchea serve` additionally rejects `options` and `stem` in API JSON (`packages/cli/src/serve/leak-guard.ts`).
- Accepted leaks, by design: `.gotchea/questions/*.json` holds the answers, and in host mode the generating agent's context holds the answers it wrote. Docs must keep telling users to generate in a subagent or a separate session.

When you add a tool, a `--json` output or an API route, add it to the leak tests (for example `packages/mcp/test/quiz-noleak.test.ts`, `packages/mcp/test/safety.test.ts`, `packages/mcp/test/save-contract.test.ts`).

## Commands

Run from the repo root (pnpm via Corepack; Node >= 20, Node >= 20.19 to build the web package with Vite):

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace |
| `pnpm build` | Build every package (`tsup` + `tsc` declarations; core copies the grammar WASMs, cli copies `packages/web/dist`) |
| `pnpm test` | Run all Vitest projects (`core`, `cli`, `mcp`, `web`) |
| `pnpm test:coverage` | Tests with v8 coverage and thresholds |
| `pnpm lint` | `biome lint .` |
| `pnpm typecheck` | `tsc --noEmit` in every package (no build needed: `paths` map workspace packages to source) |
| `pnpm changeset` | Add a changeset for a user-visible change to a published package |

Single project: `pnpm vitest run --project core` (or `cli`, `mcp`, `web`). Tests import workspace packages from **source**, never from `dist`.

Before finishing a change, `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm typecheck` must pass.

## Tests and coverage

- Tests live in `packages/<pkg>/test/**/*.test.ts`, mirroring `src/`.
- Coverage thresholds (`vitest.config.ts`): **100% statements, branches, functions and lines for `packages/core/src/score/**`**. `pnpm test:coverage` fails below that. Process entry points (`packages/*/src/bin.ts`, `packages/cli/src/index.ts`) are excluded from coverage.
- Add or update tests for every behavior change. Interactive quiz tests inject a `ScriptedAnswerSource` instead of a TTY; MCP tests use the SDK's in-memory client.

## Changesets and releases

- `gotchea`, `gotchea-core` and `gotchea-mcp` are a **fixed** group: they always share one version. `gotchea-web` is private and is never versioned, tagged or listed in a changeset.
- Never run `npm publish`, `changeset publish`, `git tag` or `git push` yourself. Releases go through the "Version Packages" PR in CI.

## Style

- TypeScript strict, ESM only, `NodeNext`: `.js` extensions in relative imports, `import type` for types.
- MCP stdout carries JSON-RPC only; log to stderr.
- Comments explain *why*, not *what*. Match the surrounding code.
