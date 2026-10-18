# gotchea — Implementation Plan

## 1. Goal

`gotchea` works like Anki for codebases. It splits a repository into meaningful chunks (module → file → symbol group → symbol), generates multiple-choice questions for each chunk that test real understanding (behavior, edge cases, purpose, impact, bugs), and tracks how well each developer remembers each chunk with a spaced-repetition model. The result is a comprehension heat map: grey means no questions yet, and red/yellow/green come from retrievability R. When code changes, the related comprehension decays automatically. The core is UI-agnostic and code-agnostic, so the same engine can later run on docs and contracts. A CLI and an MCP server both sit on top of it.

## 2. Repository Layout

```
gotchea/
├─ package.json              # private workspace root (scripts: build, test, lint)
├─ pnpm-workspace.yaml       # packages/*
├─ tsconfig.base.json        # strict, ES2022, NodeNext, ESM only
├─ vitest.config.ts          # test.projects (core, cli, mcp); vitest ≥4 dropped vitest.workspace.ts
├─ LICENSE (MIT) · README.md (M5) · PLAN.md · AGENTS.md (M5)
├─ fixtures/                 # shared fixture repos (see §8)
└─ packages/
   ├─ core/  (gotchea-core) src/
   │  ├─ index.ts             # public API surface only
   │  ├─ config/              schema.ts (zod) · defaults.ts · load.ts
   │  ├─ model/               chunk.ts · question.ts · progress.ts · ids.ts
   │  ├─ fs/                  walker.ts (git ls-files / ignore) · filters.ts
   │  ├─ parse/               registry.ts · parser.ts · lang/typescript.ts · lang/python.ts · grammars/*.wasm
   │  ├─ chunk/               chunker.ts (interface) · code-chunker.ts · tree-builder.ts · grouping.ts · metrics.ts · fanin.ts
   │  ├─ hash/                normalize.ts · hash.ts
   │  ├─ scan/                scan.ts · diff.ts · line-diff.ts · reconcile.ts
   │  ├─ store/               paths.ts · repo-id.ts · atomic-write.ts · chunk-store.ts · question-store.ts · progress-store.ts · snapshot-store.ts
   │  ├─ index/               chunk-index.ts   # no tree-sitter import (fast cold start)
   │  ├─ generate/            prompt.ts · tasks.ts · schema.ts · validate.ts · dedupe.ts · verify.ts
   │  │  └─ providers/        provider.ts · anthropic.ts · openai.ts · openai-compatible.ts
   │  ├─ quiz/                select.ts · session.ts · views.ts (public/private)
   │  └─ score/               retrievability.ts · transitions.ts · state.ts · aggregate.ts   # pure, 100% coverage
   ├─ cli/   (gotchea, bin: gotchea) src/
   │  ├─ bin.ts               # commander-style router
   │  ├─ commands/            init · scan · generate · quiz (@clack/prompts) · map · status · serve (M4)
   │  └─ render/              tree-heatmap.ts (ANSI colors) · json.ts
   ├─ mcp/   (gotchea-mcp, bin: gotchea-mcp) src/
   │  ├─ bin.ts · server.ts   # @modelcontextprotocol/sdk, StdioServerTransport
   │  ├─ tools/               one file per tool
   │  └─ schemas.ts           # zod input + strict output schemas
   └─ web/   (M4)             # treemap UI served by `gotchea serve`
```

Dependency direction: `cli`, `mcp` and `web` → `core`. `core` never imports from the interface packages. Within core, `score/` and `quiz/select` import nothing from `parse/`, `chunk/` or `generate/`.

## 3. Core Interfaces (sketches)

```ts
// ---- model ----
type ChunkKind = 'module' | 'file' | 'group' | 'symbol';
interface LineRange { path: string; start: number; end: number }        // 1-based, inclusive
interface Chunk {
  id: string; kind: ChunkKind; parentId: string | null; title: string;   // title = display name
  source: string;                                // chunker id: 'code' (later 'markdown', 'openapi')
  lang?: string;                                 // 'typescript' | 'python' | ...
  ranges: LineRange[]; contentHash: string;      // leaves + files; modules: hash of child hashes
  metrics: { loc: number; complexity: number; fanIn: number };
  questionCount: number;                         // target per session (0 for non-leaf)
  isLeaf: boolean; aliases?: string[];           // previous ids (move detection, capped at 5)
}
type QuestionType = 'behavior' | 'edge_case' | 'purpose' | 'impact' | 'bug_detection';
interface QuestionPrivate {
  id: string; chunkId: string; chunkHash: string; type: QuestionType;
  stem: string; options: [string, string, string, string]; correctIndex: 0 | 1 | 2 | 3;
  explanation: string; refs: LineRange[]; difficulty: 1 | 2 | 3; lang: 'tr' | 'en';
  generatedBy: string;                           // 'host:<client>' | 'anthropic:<model>' | ...
  status: 'ok' | 'stale' | 'flagged'; createdAt: string;
}
interface Progress {
  stability: number | null;                      // S in days; null = never passed
  lastReviewedAt: string | null; lastPassedHash: string | null;
  lastSeenHash: string;                          // hash the decay was last reconciled against
  mustRepass: boolean;                           // set by fail or changeRatio > redOnChangeRatio
  history: { at: string; sessionId: string; questionIds: string[]; correct: number; total: number; passed: boolean; hash: string }[];
}
// ChunkState (computed, never stored)
interface ChunkState { R: number | null; color: 'grey' | 'red' | 'yellow' | 'green'; dueAt?: string }

// ---- chunking (content-agnostic) ----
interface SourceUnit { path: string; text: string }
interface ChunkDraft { kind: 'group' | 'symbol' | 'file'; symbolPath: string[]; ranges: LineRange[]; normalizedLines: string[]; complexity: number; children: ChunkDraft[] }
interface Chunker {
  readonly id: string;                           // 'code'
  supports(path: string): boolean;
  chunk(unit: SourceUnit, cfg: ChunkingConfig): Promise<ChunkDraft>;    // returns the file root
  references?(unit: SourceUnit): Promise<{ imports: ImportRef[]; idents: string[] }>; // for fanIn
}
// TreeBuilder (generic) adds module chunks from directories and assigns ids, hashes and metrics.

// ---- parsing ----
interface SymbolNode { name: string; kind: 'class' | 'function' | 'method' | 'variable' | 'other'; start: number; end: number; children: SymbolNode[] }
interface LanguageParser {
  readonly lang: string; readonly extensions: string[];
  init(): Promise<void>;                         // lazy-load WASM grammar once
  parse(text: string): ParsedFile;               // wraps web-tree-sitter Tree
  symbols(f: ParsedFile): SymbolNode[];
  commentRanges(f: ParsedFile): { start: number; end: number }[];   // byte offsets (incl. Python docstrings)
  complexity(f: ParsedFile, start: number, end: number): number;   // 1 + decision nodes
  imports(f: ParsedFile): ImportRef[];
}
interface ParserRegistry { register(p: LanguageParser): void; forPath(path: string): LanguageParser | undefined }

// ---- storage ----
interface ChunkStore    { load(): Promise<ChunksFile | null>; save(f: ChunksFile): Promise<void> }
interface QuestionStore { list(chunkId: string): Promise<QuestionPrivate[]>; save(chunkId: string, qs: QuestionPrivate[]): Promise<void>;
                          remove(chunkId: string): Promise<void>; move(fromId: string, toId: string): Promise<void> }
interface ProgressStore { load(): Promise<ProgressFile>; save(p: ProgressFile): Promise<void> }
interface SnapshotStore { get(hash: string): Promise<string[] | null>; put(hash: string, lineFingerprints: string[]): Promise<void> }
// Fs* implementations + InMemory* implementations for tests. All writes are atomic (tmp + rename).

// ---- LLM ----
interface LLMProvider {
  readonly name: string; readonly model: string;
  completeJson(req: { system: string; user: string; schema: JsonSchema; temperature?: number }): Promise<unknown>;
}
// AnthropicProvider (ANTHROPIC_API_KEY), OpenAIProvider (OPENAI_API_KEY),
// OpenAICompatibleProvider (baseUrl, default http://localhost:11434/v1, e.g. Ollama; optional OPENAI_COMPAT_API_KEY)

// ---- scoring (pure; `now` is always injected) ----
retrievability(S: number, elapsedDays: number, cfg: ScoreConfig): number           // (1 + t/(9S))^-1
onSessionResult(p: Progress | undefined, r: { passed: boolean; at: string; hash: string; ... }, cfg): Progress
onContentChange(p: Progress, changeRatio: number, newHash: string, cfg): Progress
chunkState(c: Pick<Chunk,'isLeaf'>, okQuestions: number, p: Progress | undefined, now: Date, cfg): ChunkState
aggregate(children: { loc: number; R: number | null }[]): number | null           // LOC-weighted, null children skipped
colorFor(R: number | null, flags: { neverPassed: boolean; mustRepass: boolean; hasQuestions: boolean }, cfg): Color
passThreshold(n: number, ratio: number): number                                    // Math.ceil(ratio*n - 1e-9)
questionCount(m: Chunk['metrics'], cfg): 3 | 5 | 7
selectionPriority(R: number | null, fanIn: number, cfg): number                    // (1 - (R ?? 0)) * (1 + w·ln(1+fanIn))
```

**Score transitions:** a first pass (`lastPassedHash == null`) sets S=3. Each later pass sets S×=2.5. A fail sets S=max(1, (S ?? 1)×0.3) and `mustRepass=true`. A pass clears `mustRepass` and sets `lastPassedHash` to the current hash. Both outcomes set `lastReviewedAt=now`. **Colors:** grey if there are no `ok` questions; red if never passed, `mustRepass`, or R<0.5; yellow if 0.5≤R<0.85; green if R≥0.85. A parent's R is the LOC-weighted mean of its children's R, skipping grey children. A parent is grey if all of its children are grey.

### Config schema (`.gotchea/config.json`, every field optional, defaults below)

```jsonc
{
  "version": 1,
  "include": ["**/*"],
  "exclude": ["**/node_modules/**", "**/vendor/**", "**/dist/**", "**/build/**", "**/.venv/**", "**/__pycache__/**",
              "**/*.min.*", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/poetry.lock", "**/uv.lock", "**/Pipfile.lock"],
  "respectGitignore": true,
  "includeTests": false,
  "testPatterns": ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test/**", "**/tests/**", "**/test_*.py", "**/*_test.py", "**/conftest.py"],
  "generatedMarkers": ["@generated", "DO NOT EDIT", "auto-generated"],   // checked in the first 5 lines
  "maxFileBytes": 524288,
  "languages": ["typescript", "javascript", "python"],
  "chunking": { "leafMinLoc": 40, "leafMaxLoc": 200, "mergeBelowLoc": 15, "splitAboveLoc": 300 },
  "questions": {
    "bands": [ { "maxLoc": 60, "maxComplexity": 8, "count": 3 }, { "maxLoc": 150, "maxComplexity": 20, "count": 5 }, { "count": 7 } ],
    "poolMultiplier": 2, "lang": "en",
    "types": ["behavior", "edge_case", "purpose", "impact", "bug_detection"],
    "dedupeJaccard": 0.8, "maxCorrectLengthRatio": 1.4, "verify": false
  },
  "quiz": { "passRatio": 0.75, "excludeRecentSessions": 2, "fanInWeight": 0.5, "showCode": true },
  "score": { "initialStability": 3, "passMultiplier": 2.5, "failMultiplier": 0.3, "minStability": 1, "forgettingFactor": 9,
             "greenAt": 0.85, "yellowAt": 0.5, "changeDecayFloor": 0.1, "redOnChangeRatio": 0.5 },
  "provider": { "default": "anthropic", "verify": null, "models": { "anthropic": "claude-sonnet-5-5", "openai": null, "openai-compatible": null },
                "baseUrl": "http://localhost:11434/v1" }
}
```

## 4. Chunk IDs and Content Hash

**IDs** are human-readable, deterministic and OS-independent (POSIX paths relative to the repo root, NFC-normalized):

| kind | id format | example |
|---|---|---|
| module | dir path, root = `.` | `src/auth` |
| file | file path | `src/auth/session.ts` |
| symbol | `path#Outer.Inner` | `src/auth/session.ts#SessionStore.refresh` |
| group | `path#<parentSymbolPath>~group:<firstMember>` | `src/util.ts#~group:clamp` |
| preamble | top-level code outside symbols | `src/util.ts#~top` |

Duplicate names in the same scope (overloads, redefinitions) get `@2`, `@3` in source order. IDs do not depend on line numbers, so edits that move code do not change them. Question file name: `.gotchea/questions/<slug>--<sha1(id)[0..8]>.json`, where the slug is the id with every character outside `[A-Za-z0-9_-]` replaced by `_` and truncated to 80 chars (see §10.43).

**Normalization (`normalize.ts`, versioned `n1`):**
1. Convert CRLF/CR to LF and strip the BOM.
2. Blank out every comment byte range from `commentRanges()`, including Python docstrings and JSDoc. Newlines are kept so line numbers stay aligned.
3. For each line: trim, then collapse runs of `[ \t]+` into a single space. String literals are not special-cased. This is a known, accepted imprecision.
4. Drop empty lines. The result is `normalizedLines[]`, and `metrics.loc = normalizedLines.length`.
5. `contentHash = sha256("n1\n" + normalizedLines.join("\n")).hex.slice(0, 16)`.

Module hash = sha256 of the sorted child `id:hash` pairs. Bumping `n1` forces a full rehash, and the next scan treats every chunk as "renormalized, not changed" (no decay).

## 5. Chunking and Scan Diff

**Chunk tree:**
- A file with `loc ≤ leafMaxLoc` is a leaf.
- Otherwise its children are the top-level symbols plus `~top`. Adjacent siblings under `mergeBelowLoc` are merged greedily into a group until the group reaches `leafMinLoc`, or until the next sibling would push it past `leafMaxLoc`. A leftover group with a single member stays a symbol.
- A symbol over `splitAboveLoc` is split recursively into its sub-symbols (methods) plus a `~body` remainder. A symbol with no sub-symbols stays an oversized leaf.
- Questions attach to leaves only.

**fanIn:** imports are resolved to files: relative paths, tsconfig `baseUrl`/`paths`, Python package paths from the repo root and `src/`. For a file, fanIn = number of distinct importing files. For a symbol, fanIn = number of distinct files that import it by name and reference that identifier. There is no type resolution.

**Scan algorithm (`scan.ts`):**
1. List files with `git ls-files -co --exclude-standard`. Without git, fall back to a walker plus the `ignore` package. Apply include/exclude/test/generated/size filters.
2. Parse and chunk each file, then compute metrics. A local scan cache keyed by `sha1(raw file)` (`~/.gotchea/repos/<id>/scan-cache.json`) skips re-chunking unchanged files.
3. Diff against the old `chunks.json` by id to get `added`, `removed`, `unchanged` (same hash) and `modified` (hash differs).
4. **Move detection:** pair `removed × added` chunks with the same kind and same `contentHash`. Each pair becomes a move: questions move, and the old id is pushed onto `aliases`.
5. For each `modified` chunk, set every question with `chunkHash ≠ newHash` to `stale`. The regeneration queue is derived, not stored: leaves where `okCount < poolMultiplier × questionCount`.
6. For each `removed` chunk (not moved), delete its question file. Progress entries are kept until `gotchea gc` (future).
7. Write `chunks.json` sorted by id with stable key order, so two scans produce byte-identical output.

**Per-user reconcile (`reconcile.ts`).** This runs on every command that loads progress, because a teammate's pull can change `chunks.json` without a local scan. For each chunk where `progress.lastSeenHash ≠ chunk.contentHash`, aliases included:
- `old` = `SnapshotStore.get(lastSeenHash)`. This is a list of FNV-1a 32-bit fingerprints, one per normalized line, stored locally under `~/.gotchea/repos/<id>/snapshots/`.
- `new` = fingerprints of the current normalized lines, re-chunked from the working tree for this file only.
- Run a Myers line diff on the fingerprint arrays: `changed = max(added, removed)` and `changeRatio = min(1, changed / max(1, old.length))`. If the snapshot is missing, `changeRatio = 1`.
- Apply `onContentChange`: `S = max(minStability, S × max(changeDecayFloor, 1 − changeRatio))`. If `changeRatio > redOnChangeRatio`, set `mustRepass = true`. Then set `lastSeenHash = new` and store the new snapshot.

## 6. Answer-Key Isolation

- **Two types.** `QuestionPrivate` exists only inside core (`QuestionStore`, `quiz/session.ts`, `generate/`). Interfaces only receive `QuestionPublic = { id, type, stem, options (shuffled), difficulty, lang }` from `views.toPublic()`. Explanation and refs stay out of public views because they often give away the answer.
- **Sessions are server-side.** `start_quiz` creates `Session { id, chunkId, questionIds, permutations, answers }`. It is held in memory (MCP) and persisted to `~/.gotchea/repos/<id>/sessions/` for crash recovery. Clients only see display indexes, and `submit_answer` maps them back through the permutation.
- **Reveal happens only after an answer.** `submit_answer` returns `{ correct, correctOptionIndex (display), explanation, refs, refs[].excerpt?, sessionComplete?, passed?, newState? }` for the question just answered. The ref excerpt is reveal-only and listed in `FORBIDDEN_KEYS`, so it can never appear in a pre-answer view (§10.65).
- **Strict output schemas.** Every MCP tool output passes a `.strict()` zod schema before it is sent. A contract test calls every tool and every CLI `--json` output and fails if the keys `correctIndex` or `explanation` appear anywhere before an answer. It also checks that the correct display index is uniformly distributed.
- **Code preview (0.2.0).** A public view may carry an optional `code`: `{ path, startLine, endLine, language, text, truncated? }`, built by `chunkPreview` in `core/ops/quiz.ts` and copied field by field in `toPublicView`. It holds the chunk's working-tree source only, never anything from the answer key (no refs, explanation or correct option). It is dropped when the chunk's current hash differs from `chunks.json`, for multi-range chunks, for paths that are not repo-relative or resolve (symlinks included) outside the root or into `.gotchea/`, and when the file can't be read. It is capped at `CODE_PREVIEW_MAX_LINES` (60) lines, with `truncated: true` beyond that. Text, path and language pass through `sanitizeTerminalText` (`core/quiz/sanitize.ts`), so control and bidi characters arrive as visible placeholders. `assertPublicView` scans keys only, not string values, because real source may contain words like `explanation`. `serve` has no quiz route, and its leak guard (`cli/serve/leak-guard.ts`) also rejects a `code` key.
- **Generation tasks** expose existing *stems only* (for dedupe), never options or answers.
- **Accepted leaks, by design:** `.gotchea/questions/*.json` contains answers. In host mode, the generating agent's context contains the answers it wrote. Mitigation: the docs and the future plugin tell the host to generate in a subagent or a separate session.

## 7. `get_chunk_for_file` in Under 100 ms

- `ChunkIndex` (`core/index/`) is built when the MCP server starts, from `chunks.json` and `progress.json`: `Map<path, Interval[]>` sorted by start line, over the leaf ranges. A lookup is a binary search for the innermost leaf that contains `line`. With no `line`, it returns the file chunk and its leaf summaries. The cost is O(log n) and touches no disk.
- Freshness: each call runs one `fs.stat` on `chunks.json` and `progress.json`, and reloads if their mtimes changed. If the file's mtime is newer than `scannedAt`, the result includes `staleIndex: true`. It never parses on the hot path.
- `chunk-index.ts` must not import web-tree-sitter (enforced by a lint rule), so the future hook CLI (`gotchea which <file>:<line>`) also starts quickly.
- A benchmark test with 20k synthetic chunks requires p95 < 5 ms in-process. An MCP round-trip test over stdio requires < 100 ms.

## 8. Testing Strategy

- **Score:** pure unit tests, plus property tests (fast-check) for monotonicity (R decreases in t, increases in S) and bounds. A vitest coverage threshold of 100% applies to `score/**` and `quiz/select.ts`.
- **Fixture repos** live in `fixtures/` and each has `expected/chunks.json` as a golden file:
  - `ts-basic`: classes, overloads, arrow exports, tiny helpers to group, a 350-LOC class to split, JSX/TSX, path aliases.
  - `py-basic`: classes, decorators, docstrings, nested functions, relative imports, `__init__.py`.
  - `mixed-ignore`: `.gitignore`, node_modules, dist, lockfiles, generated markers, tests (opt-in flag).
  - `edge`: empty files, syntax errors (partial tree), huge single function, unicode identifiers, CRLF.
- **Mutation pairs** (`fixtures/mutations/*.patch`) are applied to a temp copy, with expected `changeRatio`, stale and move results: comment-only, whitespace-only, rename-file, 10% body edit, 60% rewrite.
- **Hash invariants:** comment, whitespace or CRLF edits keep the hash. Any token edit changes it. Scanning twice produces byte-identical `chunks.json`, and so does scanning on posix and win32 path styles.
- **Generation:** a `MockProvider` with recorded JSON fixtures, validator tables (leaking stem, length skew, duplicates, bad refs, wrong count), and prompt snapshot tests.
- **MCP:** in-memory client/server from the SDK, contract tests for each tool, the answer-leak test from §6, and the latency test from §7.
- **CLI:** e2e with `execa` on temp copies of the fixtures (`init → scan → map --json`). @clack prompts are tested by injecting a scripted answer source.

## 9. Milestones

**M1 — Scan (no LLM)**
- [x] Workspace scaffold: pnpm, tsconfig, vitest, eslint/prettier, CI (Node 20 and 22, macOS/Linux/Windows). Replace the root `package.json` with a private workspace root. *(Done. Biome replaces eslint/prettier: `biome.json` (linter only, formatter disabled) and `pnpm lint` = `biome lint .`. `.github/workflows/ci.yml` runs typecheck, lint, build and test on ubuntu/macOS/Windows × Node 20/22, plus a pack smoke test of the installed tarballs. See §10.53.)*
- [x] `config/`: zod schema, defaults, loader with deep-merge, `init` writes the defaults
- [x] `store/`: paths, `repoId` (normalized origin URL → sha256[0..16], fallback to the realpath of the root), atomic write, Fs and InMemory stores
- [x] `fs/walker`: git ls-files plus fallback, all filters
- [x] `parse/`: web-tree-sitter loader, registry, TS/TSX/JS and Python parsers (symbols, comments, complexity, imports), pinned grammar WASMs
- [x] `hash/normalize` with invariant tests
- [x] `chunk/`: CodeChunker, grouping/splitting, TreeBuilder (modules), metrics, fanIn, questionCount
- [x] `scan/`: diff, move detection, stale marking, line-diff (Myers) and reconcile with SnapshotStore
- [x] `score/`: all pure functions with 100% coverage (they are needed for `map` colors, which are all grey in M1)
- [x] `index/ChunkIndex` plus benchmark
- [x] CLI `init`, `scan`, `map [path] [--json]`, `status`. MCP server skeleton with `scan`, `get_map`, `get_chunk_for_file`, `get_status` *(Done in M1.5: `gotchea status [--json]` is real (`cli/src/commands/status.ts`), and `mcp/src/server.ts` registers `scan`, `get_map`, `get_chunk_for_file` and `get_status`, plus the M2/M3 tools `get_generation_tasks`, `save_questions`, `start_quiz` and `submit_answer`. See §10.52.)*
- [ ] Fixtures, golden files and mutation tests green *(Deferred until after 0.1.0. Fixture repos `ts-basic`, `py-basic` and the CLI `small-repo` exist with inline expectations and inline re-scan edits; golden `expected/chunks.json` files, `mixed-ignore`/`edge` fixtures and `.patch` mutation pairs are not built, see §10.38.)*

- [x] **M2 — Generation:** prompt template (`generate/prompt.ts`; numbered code, import signatures as context, type mix, no trivia, plausible equal-length distractors, explanation cites lines, `lang`). Zod schema, validator (leak check: normalized correct-option text or ≥60% of its content words appear in the stem; length skew; refs inside the chunk; dedupe by trigram Jaccard). Providers, CLI `generate [--chunk] [--provider] [--lang]`, MCP `get_generation_tasks(limit)` / `save_questions` (rejected if `chunkHash` ≠ current), optional blind verify pass → `flagged`. *(Done, see M2_SUMMARY.md and M2_DESIGN.md.)*
- [x] **M3 — Quiz and score:** selection, sessions, public views, CLI `quiz [path|chunkId]`, MCP `start_quiz` / `submit_answer`, reconcile wired into every command, heat-map colors. *(Done, see M3_SUMMARY.md and M3_DESIGN.md.)*
- [x] **M4 — Web:** `packages/web` treemap (area = LOC, color = state, drill-down), `gotchea serve` (localhost, read-only JSON API built on `get_map`). *(Done, see M4_SUMMARY.md and §10.58–62.)*
- [x] **M5 — Packaging:** README, changesets, npm publish (`gotchea`, `gotchea-core`, `gotchea-mcp`), bundled WASM verified via `npx gotchea`, Claude Code/Codex setup docs. *(Done, split below.)*
  - [x] README, changesets and Claude Code/Codex setup docs *(`README.md`, `.changeset/`, `docs/claude-code.md`, `docs/codex.md`.)*
  - [x] npm publish of `gotchea`, `gotchea-core` and `gotchea-mcp` (first release, 0.1.0) and the bundled WASM verified via `npx gotchea` *(Done. 0.1.0, the initial release, and the 0.1.1 patch are on npm, published by `.github/workflows/release.yml` from the "Version Packages" PR (commits `4ce9a3c` and `ca2d6e6`). The three packages share one version (fixed group), see their `CHANGELOG.md`; `gotchea-web` stays private at 0.0.0. CI's pack smoke test (`scripts/pack-smoke.mjs`) checks the grammar WASMs from the installed tarballs, and `.github/workflows/e2e.yml` runs the e2e suite against the published `gotchea@latest`.)*

**Future (designed for now, not built):**
- **Claude Code plugin:** `/gotchea:quiz` and `/gotchea:map`, a skill, and a PostToolUse `Edit|Write` hook that calls `gotchea which` (§7).
- **Codex:** `config.toml` `mcp_servers.gotchea = { command = "npx", args = ["-y", "gotchea", "mcp"] }` plus an AGENTS.md snippet.
- **Progress export:** `gotchea export --progress` → `{ schema: "gotchea.progress-export/v1", repoId, exportedAt, alias?, chunks: [{ id, contentHash, S, lastReviewedAt, R }] }`. It is opt-in, contains no history details or answers, and is meant for Orchestea.
- **Non-code chunkers:** implement `Chunker` (e.g. `markdown`, `openapi`) and supply per-chunker question types and prompt templates.

## 10. Assumptions & Open Questions

1. **Root `package.json`:** the existing one is named `gotchea`, is ISC and CommonJS. Assumed: it is replaced by a private, MIT, ESM workspace root, and the name `gotchea` moves to `packages/cli`.
2. **ESM only, built with tsup** (bundled CLI/MCP) plus `tsc` for `.d.ts`. *Scaffold (done):* each package runs `tsup && tsc -p tsconfig.build.json` (tsup emits JS only, `tsc` emits declarations only). There are no project references. `tsconfig.base.json` maps `gotchea-core`/`gotchea-mcp` to their `src/index.ts` via `paths`, so `pnpm typecheck` needs no prior build. Build configs reset `paths` so they read the dependency's `dist/*.d.ts`, and vitest aliases `gotchea-core`/`gotchea-mcp` to their sources. Pinned toolchain: TypeScript 7, vitest 4.1 (vitest 5 needs Node ≥22.12) and commander 14 (commander 15 needs Node ≥22.12), all to keep `engines.node >=20`. pnpm ≥10 needs `allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml`.
3. **Repo level:** the data model has no `repo` kind, so the repo root is the `module` chunk with id `.`.
4. **Questions attach to leaves only.** Files, modules and split containers get their score by aggregation.
5. **Group ID anchor:** a group ID is anchored on its first member's name. If that member is renamed or removed, the group gets a new id and its progress is lost (only exact-hash moves are detected).
6. **Oversized symbols** with no sub-symbols (>300 LOC) stay single leaves. Splitting them by statement blocks is deferred.
7. **LOC means normalized SLOC** (no blanks or comments), and the thresholds use it. Python docstrings count as comments.
8. **Complexity** = 1 + decision nodes (if/elif/for/while/case/catch/except/&&/||/??/ternary/comprehension-if).
9. **Question-count bands** (≤60 LOC and ≤8 complexity → 3; ≤150 and ≤20 → 5; else 7) are a guess. "Pool holds 2x" means a target of `2 × count` ok questions per leaf.
10. **fanIn** is file-level import resolution plus a name match. Dynamic imports, re-export chains beyond one hop and `from x import *` are ignored.
11. **Snapshot storage:** changeRatio is measured against the *user's* `lastSeenHash`, using local line-fingerprint snapshots, so nothing large is committed. If the snapshot is missing, changeRatio = 1 (pessimistic). The denominator is the *old* LOC, and changed = max(added, removed).
12. **The "floor" applies to the decay multiplier** (`max(0.1, 1−ratio)`), and S is also clamped to `minStability`.
13. **Any hash change marks every question for that chunk stale**, even small edits. Alternative: keep questions whose `refs` don't intersect the changed lines.
14. **First pass** is defined as `lastPassedHash == null`. A fail before any pass leaves S=1. A pass after an earlier pass and a fail is a "later pass" (S×=2.5 on the reduced S).
15. **One quiz session covers one chunk**, with N = its `questionCount`. If fewer than N unasked questions are left, the least recently asked are reused. If fewer than N `ok` questions exist, the chunk cannot be quizzed and the CLI offers to generate.
16. **Selection priority** = `(1−R)·(1 + 0.5·ln(1+fanIn))`, where never-passed counts as R=0. Which chunk is picked when `quiz` gets a path: the highest-priority leaf under that path.
17. **Parent aggregation skips grey children.** Parent color comes from the aggregated R only (no "never passed" rule).
18. **Removed chunks:** their question files are deleted (git history keeps them), and progress stays orphaned until a future `gc`.
19. **Leak heuristic and length thresholds** (60% word overlap, correct option ≤1.4× the mean distractor length, Jaccard 0.8) need tuning on real output.
20. **Explanation and refs are hidden until the user answers**, because they often reveal the answer.
21. **Default models:** Anthropic `claude-sonnet-5-5`. There is no default for OpenAI or OpenAI-compatible, so the user must set one. The verify provider defaults to the generation provider with a fresh context. Should verification require a *different* model?
22. **repoId** uses the `origin` remote (else the first remote), normalized: credentials, protocol and `.git` stripped, host lowercased, so SSH and HTTPS give the same id. Forks get separate progress.
23. **Concurrency:** single writer assumed. A lockfile at `~/.gotchea/repos/<id>/.lock` guards scan and save, and the MCP server and CLI may run at the same time.
24. **WASM grammars come from `@vscode/tree-sitter-wasm@0.3.1`, pinned exactly with `web-tree-sitter@0.27.1`** (resolved). Verified on 2026-10-14: `tree-sitter-wasms@0.1.13` (built with tree-sitter-cli 0.20) **fails to load** on web-tree-sitter 0.27 for typescript, tsx, javascript and python. `@vscode/tree-sitter-wasm` (MIT, Microsoft, no install scripts, no deps) loads all four (TS/TSX ABI 14, JS/Python ABI 15), and `packages/core/test/tree-sitter.smoke.test.ts` guards this. The official `tree-sitter-typescript`/`-python`/`-javascript` npm packages also ship working `.wasm` files, but they pull native `node-gyp` install scripts, which is bad for `npx gotchea`. Load grammars with `createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-<lang>.wasm')`. The package is ~22 MB because it ships about 20 grammars. In M1 `parse/`, consider copying only the 4 needed `.wasm` files into `core/src/parse/grammars/` at build time and dropping the runtime dependency. Bump the two packages together and rerun the smoke test.
25. **Partial parses:** files with syntax errors are chunked from the partial tree, and a fully failed parse falls back to a single file leaf.
26. **Question `lang`** comes from config or a CLI flag per generation. Mixed-language pools are allowed, and a quiz filters by the user's preferred lang (default config `lang`).
27. **`scan` via MCP** runs synchronously and may take longer than typical tool timeouts on large repos. Is a progress notification needed?
28. **The `serve` (M4) API** binds only to 127.0.0.1 with no auth.
29. **Config key names (M1):** the §3 names are kept: `chunking.mergeBelowLoc` is the "group merge below" threshold, `score.changeDecayFloor` is the changeRatio floor, `score.redOnChangeRatio` is "red on change above", and `questions.lang` is `tr|en`. Added `ignore: string[]` (default `[]`): extra globs appended to `exclude`, so users can add ignores without restating the defaults. Parsing uses zod defaults with `prefault({})` on nested objects: objects deep-merge, arrays replace, unknown keys are dropped silently. `mergeConfig()` deep-merges two partial inputs (for CLI overrides).
30. **Always-skipped paths** (`ALWAYS_EXCLUDE`, independent of config): `.git/`, `.gotchea/`, `node_modules/`, `vendor/`, `dist/`, `build/`, `*.min.{js,mjs,cjs}` and common lockfiles (npm/pnpm/yarn/bun/poetry/uv/Pipfile/Cargo/composer/Gemfile/go.sum). Glob matching is case-sensitive (`ignore({ ignorecase: false })`) for deterministic results across OSes.
31. **Walker:** `git ls-files -co --exclude-standard` first. Without git, or with `useGit: false`, a directory walk honors `.gitignore` at every level plus `.git/info/exclude` (not the user's global excludes file). `respectGitignore: false` always uses the walk without gitignore. Symlinked directories are skipped. Generated detection looks at the first 5 lines; binary detection checks the first 4 KB for a NUL byte.
32. **`chunks.json` has no `scannedAt`**, so two scans are byte-identical. §7's `staleIndex` should compare the source file's mtime with `chunks.json`'s mtime instead.
33. **Nested ids:** segments are joined with `.`. A nested group is `path#Parent.~group:<firstMember>` and a split remainder is `path#Parent.~body`. Symbol names are sanitized (`.`, `#` and whitespace become `_`, e.g. `[Symbol_iterator]`; since the M1 review also `@` and a leading `~`, see §10.44).
34. **Tree shape details:** a file over `leafMaxLoc` whose only child would be a single leaf stays a leaf (no duplicate chunk). `~top` and `~body` never join groups. Python nested classes and TS namespaces are symbols. TS overload signatures, `declare` forms and abstract methods are not symbols. `export default <expression>` has no symbol, while `export default function/class/arrow` is named `default`. In a multi-declarator `const a = 1, b = 2`, each symbol covers only its own declarator. Class members' ranges extend up to their decorators.
35. **Complexity of synthetic chunks:** a group is `1 + Σ(memberComplexity − 1)`. `~top`/`~body` count only decision nodes that start on their own (uncovered) lines. A file counts the whole file. Module LOC and complexity are sums of their children.
36. **fanIn details (M1):** tsconfig `baseUrl`/`paths` are **not** resolved yet (only relative specifiers and `.js→.ts` mapping). A default import only matches a symbol named `default`. `export * from` and bare `require()` count as referencing every export. A method counts a file that imports its owner and references the method name. A group counts the union of its members, and `~top`/`~body` count 0. A module counts distinct importing files outside that directory. Python `from pkg import sub` is treated as a submodule import when `pkg/sub.py` or `pkg/sub/__init__.py` exists.
37. **Scan diff naming and decay ownership:** the diff list is called `changed` (§5's "modified"), and normalization bumps go in a separate `renormalized` list (questions get the new `chunkHash`, no decay). `applyScanDiff` decays progress only when the user's `lastSeenHash` equals the diff's old hash. Any other mismatch is left to `reconcileProgress`, which `scanRepo` runs right after, so progress never decays twice. Both are pure, and `scanRepo` does the I/O.
38. **Not built yet in M1 core:** the scan cache (`scan-cache.json`) and the `.lock` file (their paths are reserved in `userPaths`), plus fixture repos with golden files and mutation patches. Snapshots are stored for leaves only, since progress attaches to leaves.
39. **Scoring API refinements:** a leaf with questions but no pass has `R = 0` (red), so it pulls parent aggregates down. Grey leaves have `R = null` and are skipped. `chunkState(okQuestions, progress, now, cfg)` dropped the `Pick<Chunk,'isLeaf'>` parameter; parents use `parentState()` or `computeTreeStates()`. `dueAt` is when R falls below `greenAt`. When every non-grey child has LOC 0, aggregation falls back to an unweighted mean.
40. **Tests live under `packages/core/test/<area>/`**, mirroring `src/`, because the root vitest config includes `test/**/*.test.ts`. A coverage threshold of 100% is enforced for `packages/core/src/score/**` under `pnpm test:coverage`.
41. **Grammar WASMs** are still resolved at runtime from `@vscode/tree-sitter-wasm` (assumption 24). Copying the 4 files into `parse/grammars/` is left for M5 packaging.
42. **Symlinks (M1 review):** a file symlink is followed only while its real path stays inside the repo's real root; otherwise it is skipped with reason `outside-root`, in both git and walker modes, so content from `~/.ssh` or `/etc` never reaches chunks, question prompts or committed question files. A symlink to another file inside the repo is still listed and creates duplicate chunks. *Open:* should in-repo file symlinks be skipped too, as git sees them as links rather than content?
43. **Question file slug (M1 review):** the slug keeps only ASCII `[A-Za-z0-9_-]`, which changes the §4 rule (`/#.~` only). Ids can contain `:`, `\`, `*` or non-ASCII through string-named TS members and modules. `:` writes an NTFS alternate data stream, and `\` creates a subdirectory on Windows. The sha1 digest keeps names unique. This is a format change, made before any question file was committed.
44. **Synthetic segment collisions (M1 review):** `sanitizeSegment` now also replaces `@` and a leading `~`, and NFC-normalizes names. A real name like `declare module 'a@2'` or `'~top'` can no longer collide with a duplicate suffix or `~top`/`~body`/`~group:`. `buildTree` throws on a duplicate id instead of silently overwriting it.
45. **Robustness:** a parser whose `init()` fails, or input that throws during analysis (for example a 6000-branch `else if` chain overflowing the stack in symbol extraction), falls back to the single-leaf `parseFailed` draft. One bad file never aborts a scan. A file that disappears or becomes unreadable between the walk and the read is reported as `unreadable`.
46. **Line ranges:** a trailing newline ends the last line, so `'a\n'` is 1 line, not 2. File ranges no longer point one line past EOF.
47. **Python docstrings** are plain, raw or unicode string literals only. An f-string or bytes literal in docstring position is code and counts toward the hash.
48. **Move pairing (M1 review):** chunks with LOC 0 (empty files, comment-only chunks) all share one hash and are never paired as moves. Among same-kind, same-hash candidates, pairing prefers, across all removed chunks, the same symbol path plus file name, then the same symbol path, then id order. Moved questions still keep their old `refs` (path and line numbers); M2 must rebase refs on move. *Open:* should refs be stored relative to the chunk start, so unchanged chunks that shift down a file do not drift?
49. **Module `source`** is the shared chunker id of the module's children, or `mixed` when several chunkers contributed. It used to be the first file's chunker id, with a hardcoded `'code'` fallback. An empty repo's root is therefore `mixed`.
50. **Score input hardening:** `greenAt`/`yellowAt` must be > 0, since 0 made `dueAt` infinite and crashed `map`. `chunkState` treats a progress entry with an unparseable `lastReviewedAt` or with `S <= 0` as never passed (R = 0, red), `colorFor(NaN)` is red, and `dueAt` is omitted when it is not a representable date. Clock skew (now < lastReviewedAt) clamps elapsed time to 0, giving R = 1.
51. **Paths and ids:** `buildTree` and `CodeChunker` POSIX- and NFC-normalize any path they are given, so win32 input such as `src\a.ts` yields `src/a.ts` ids and ranges. `userPaths` rejects repoIds outside `[A-Za-z0-9_-]{1,64}`. `map [path]` compares real paths, so a symlinked checkout and names like `..foo` work, and `..`, `../x` and absolute paths outside the repo are rejected. *Known limitation:* the walker NFC-normalizes paths before `stat`/`read`, so on normalization-sensitive filesystems (ext4) an NFD-named file is silently dropped. The fix is to keep the raw path for I/O.
52. **Not built in M1 (deferred, needs approval):** the CLI `status` command is a stub labelled M3. Stubs print "not implemented" and exit 0. The MCP package is only `createServer()` with no tools (`scan`, `get_map`, `get_chunk_for_file`, `get_status` are missing). The map tree (`buildMapTree`/`filterTree`) lives in `cli/src/render/`. It should move into core so MCP `get_map` and M4 `serve` share one leak-checked shape. `scan` has no `--json`. *Open:* build these before M2, or fold them into M3? *Resolved in M1.5:* `gotchea status` is real, the MCP server registers `scan`, `get_map`, `get_chunk_for_file` and `get_status`, and the map tree moved to `core/src/map/tree.ts` (the shared JSON shape followed in M4, §10.61).
53. **Tooling gaps:** there is no eslint/prettier config and no CI workflow. The §7 "no tree-sitter in `chunk-index.ts`" rule is enforced by a source-import test, not a lint rule, and `gotchea-core`'s single bundle still statically imports `web-tree-sitter`. A separate `./index` entry point is needed before the `gotchea which` hook. *Resolved (lint and CI):* biome (`biome.json`, `pnpm lint`) instead of eslint/prettier, and CI in `.github/workflows/ci.yml`. The separate `./index` entry point is still open: core exports only `.` and `./internal`.
54. **Defaults that cannot be overridden:** `ALWAYS_EXCLUDE` contains `vendor/`, `dist/` and `build/` at any depth, so a real source directory such as `src/build/` is always skipped (assumption 30). *Open:* keep it, or limit `ALWAYS_EXCLUDE` to `.git/`, `.gotchea/` and `node_modules/` and leave the rest to the overridable `exclude`? Tracked files that match `.gitignore` are included in git mode (git semantics) but skipped by the fallback walker.
55. **Known M1 limitations (not fixed):**
    - Complexity is computed by a root walk per chunk, which is O(symbols × top-level nodes): about 3 s for a 4000-function file. Precomputing sorted decision rows would fix it.
    - Each file is parsed twice, once for `chunk` and once for `references`.
    - Questions marked stale are not restored to `ok` when the code is reverted to their `chunkHash`.
    - When a file grows past `leafMaxLoc`, its question pool stays attached to the now non-leaf id.
    - `writeFileAtomic` does not fsync or retry on Windows `EPERM`.
    - `FsQuestionStore.list` does not check that `file.chunkId` matches the requested id.
    - One git repo with several gotchea roots (monorepo packages) shares one repoId and one progress file. *Open:* include `git rev-parse --show-prefix` in the repoId?
56. **Benchmark:** §7 bounds only lookups (p95 < 5 ms over 20k chunks). The index-build sanity bound was relaxed from 100 ms to 500 ms because it flaked under parallel test load.
57. **§6 boundary:** core's public barrel still exports `QuestionPrivate`, `FsQuestionStore` and `InMemoryQuestionStore`. `map` reads full private pools just to count `ok` questions, though it emits only counts (guarded by tests). Before M3/MCP, move the stores to an internal entry point and expose an `okQuestionCounts()` view.
58. **`serve` is read-only and reloads by mtime (M4).** `ensureReconciled` writes `progress.json` (under the repo lock), so `gotchea serve` runs it **once at startup**, through the normal flow. After that no request writes to the repo or `~/.gotchea`: the map and status are loaded with `reconcile: false` and cached in memory. Each request stats `chunks.json`, `config.json`, the `questions/` directory (atomic writes rename into it, so its mtime moves) and the user's `progress.json`, the §7 MCP approach, and reloads when any mtime, size or inode changed (a missing file is its own value). The cache is also rebuilt when it is 60 s old, because R and the colours decay with time while nothing on disk changes, and because an in-place edit of a question file does not move the directory mtime. Concurrent requests share one reload. `generatedAt` is the time the cache was built, so the body and its ETag stay stable between reloads. Consequence: after a `git pull`, decay shows up in the browser only after the next CLI or MCP command (or a `serve` restart) has reconciled, since `serve` itself never decays progress.
59. **`serve` security (M4, refines §10.28).** It binds to `127.0.0.1` only; there is no `--host`. Every request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` gets 403, which defeats DNS rebinding. A missing Host also gets 403: the server sets `requireHostHeader: false` so Node's bare 400 (without the security headers) never answers instead. `[::1]` and `0.0.0.0` are rejected, and absolute-form request targets get 400. There are no CORS headers. Every response carries `Content-Security-Policy: default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Static paths are checked on the raw request target, before URL normalisation: a `..`/`.` segment, an encoded `/`, `\` or NUL is 403, and the resolved `realpath` must stay inside `dist/web`. Only GET and HEAD are served (405 otherwise). API JSON is deep-scanned for the §6 forbidden keys plus `options` and `stem` before it is sent. The UI never quizzes; it only shows the `gotchea quiz <id>` command to copy.
60. **Web packaging (M4).** `packages/web` (`gotchea-web`, private, never published) is vanilla TypeScript built by Vite (a devDependency only). `pnpm build` runs web before cli because the cli has `gotchea-web` as a `workspace:*` **devDependency** (topological order only). The cli build copies `packages/web/dist` to `packages/cli/dist/web/` after tsup and fails if the web bundle is missing, so the published `gotchea` tarball carries the static files and gains no runtime dependency. Changesets: `privatePackages: { version: false, tag: false }`, and web is not in the `fixed` group. Building from source needs Node ≥ 20.19 for Vite 8 (verified to build and test on 20.15 too); the shipped CLI still needs only Node ≥ 20.
61. **One JSON shape (M4, completes §10.52).** `MapJson`, `StatusJson`, `copyMapNode`, `mapJsonFrom` and `statusJsonFrom` live in `core/map/json.ts`. `gotchea map --json`, MCP `get_map` (its tree, via `copyMapNode` with `depth`), `GET /api/map` and the web UI's types all use them, and the web imports the types only. `gotchea status --json` is new and has the same schema as `GET /api/status`: the `StatusReport` fields plus `version: 1` and `generatedAt`. Before a scan it prints `scanned: false` with zero counts and exits 0.
62. **Treemap semantics (M4).** Area is `loc` and colour is `state.color`. Chunks with 0 LOC get no cell but are listed in the children table below the treemap. One level is drawn per view: a node with children shows its children, and a leaf is shown selected inside its parent's treemap. The URL hash holds the selected node (`#/src/auth/session.ts`, with `#` in symbol ids encoded as `%23`), so drill-down is plain navigation and the back button works. If the hashed chunk disappears after a rescan, the view falls back to the closest surviving ancestor. The legend counts leaves per colour under the node on screen, like the `gotchea map` legend, but without the numeric thresholds, which are config values not present in `MapJson`. Each state also has a text mark (`!` red, `~` yellow, `✓` green, `–` grey) and a CSS pattern, so no state relies on colour alone. The UI polls `/api/map` every 3 s with `If-None-Match` and does not re-render on 304. There is no SSE or WebSocket.
63. **Quiz code preview (0.2.0, refines §6).** Each public question view may carry `code`, the chunk's working-tree source (§6 lists the fields and when it is dropped). It is **on by default**: the questions are about code, and reading that code is part of the exercise. **Open book does not break §6.** The preview is the code the question is about, which the user could read in their editor anyway; it is never derived from the answer key (no refs, explanation or correct option), and `PublicCodePreviewSchema` is a `.strictObject` whose only keys are `path`, `startLine`, `endLine`, `language`, `text` and `truncated`, none of them in `FORBIDDEN_KEYS`. The trade-off is that a pass shows comprehension more than recall; a user who wants a recall test turns it off. **At most 60 lines** (`CODE_PREVIEW_MAX_LINES`, `core/quiz/views.ts`): chunks are capped by `leafMaxLoc` but can still be long, and the preview must keep a question readable in a terminal and in an agent's context. Longer chunks are cut to their first 60 lines with `truncated: true`, and the schema checks that `text` holds exactly `startLine..endLine`. **Stale chunks get no preview.** `chunkPreview` (`core/ops/quiz.ts`) re-chunks the file like a scan and drops the preview when the current hash differs from `chunks.json`, so the user never sees code that no longer matches the question. Multi-range chunks and unreadable files get none either; a preview is optional and never fails the quiz. **Path containment:** `chunks.json` is committed and hand-editable, so a range path must be repo-relative (no `..`, `\`, NUL or absolute path) and its `realpath`, symlinks included, must stay under the root and outside `.gotchea/`. Otherwise a forged chunk over `.gotchea/questions/*.json` would pass the hash check (the fallback chunker accepts any file) and put the answer key in a pre-answer view. Precedence is explicit choice > session value > config: the CLI's `--code` / `--no-code` and MCP `includeCode` on `start_quiz` / `submit_answer` override for that call, otherwise the session's value applies; a new session takes `includeCode ?? quiz.showCode` (default `true`). The resolved value is **stored on the session** at creation (`Session.showCode`), so an MCP client that turned code off at `start_quiz` doesn't get it back with the next question just because `submit_answer` omitted the input. An explicit `includeCode` on a resumed session or on `submit_answer` applies to that response only and doesn't rewrite the stored value. Session files written by 0.1.x have no `showCode` and read as `true`, regardless of `quiz.showCode`. **Sanitization lives in core** (`sanitizeTerminalText`, `core/quiz/sanitize.ts`) because the source and the hand-editable `chunks.json` path reach every interface, including MCP hosts that render tool output to a terminal: C0 controls become Control Pictures (`␀`…`␟`), DEL becomes `␡`, C1 controls become `�`, CRLF becomes LF (a lone CR is `␍`), bidi controls (U+061C, U+200E/U+200F, U+202A–U+202E, U+2066–U+2069) are shown as `\u{XXXX}`, and tab and LF are kept. Lines are sanitized one by one after splitting, so a stray `\r` can't shift the line count against the 60-line cap. The CLI sanitizes again at the TTY (`render/code.ts`) and also sanitizes the stems and options it prints, which are hand-editable in `.gotchea/questions/`. The CLI's syntax highlighter (`cli/render/code.ts`) is **hand-rolled on purpose**: a small lexer for comments, strings, numbers and keywords on top of picocolors, plain when colours are off, so the CLI gains no runtime dependency. Exact highlighting is not the goal.
64. **MCP quiz display.** The text result is canonical: the agent relays the block between `<<<SHOW TO USER VERBATIM` and `SHOW TO USER VERBATIM>>>` verbatim, including the cited code block, stem and all options in display order, before asking for the user's answer. Selection widgets carry short labels only. Elicitation is opt-in (`GOTCHEA_MCP_ELICIT=on` or `auto`; default `off`) because Claude Code renders form messages as plain, height-limited text and titles as single-line labels. Forms therefore show plain numbered source lines and full options in the message, use short A–D titles, and fall back to the complete text flow when a message exceeds 6000 characters or code exceeds 40 lines. Both renderers use public question fields only; the previous answer's reveal stays outside the next question's marked block.
65. **Reveal excerpts (0.2.0, refines §6 and §10.63).** `withRefExcerpts` (`core/ops/quiz.ts`) adds `excerpt: { language, text, truncated? }` to the refs of a `RevealView`, so the `submit_answer` reveal shows the cited lines next to the explanation (the CLI reveal still lists only the ref locations). **The excerpt follows the answer, so it can't leak.** It is built only after the answer has been recorded, and `excerpt` is in `FORBIDDEN_KEYS` (`core/quiz/views.ts`), so a pre-answer view can never carry it; `serve`'s leak guard (`cli/serve/leak-guard.ts`) rejects it too, since it extends `FORBIDDEN_KEYS`. **It is tied to the preview setting**, so closed-book stays closed-book: excerpts are added only when code previews are on for that response (the same `showCode` resolution as §10.63), and a closed-book quiz (`--no-code`, `includeCode: false`, `quiz.showCode: false`) never gets them. **Only owned, exact ranges are cited.** Refs come from the generator and could point anywhere, so a ref is excerpted only if it lies inside one of the chunk's own ranges (same path, start and end inside the range). Refs with `approximate` set, inverted ranges, or lines that can't be read keep their line numbers and get no excerpt. Files are read through the same `sanitizedLines` path as `chunkPreview`: the current hash must match `chunks.json`, the path must stay inside the root (`realpath`, symlinks included) and outside `.gotchea/`, and the text goes through `sanitizeTerminalText`. **A line budget keeps a reveal readable** in a terminal and in an agent's context: at most `REF_EXCERPT_MAX_LINES` (15) per ref and `REVEAL_EXCERPT_MAX_LINES` (30) per reveal. Refs are processed in order against one shared budget, and a cut excerpt gets `truncated: true`. Each excerpted ref is checked with `RevealRefSchema.safeParse`; if that fails, the ref is kept without an excerpt, so an excerpt never fails the quiz.
