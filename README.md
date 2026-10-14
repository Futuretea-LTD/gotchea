# gotchea

> Power your code memory.

**gotchea is like Anki for your codebase: it splits a repository into meaningful chunks, quizzes you on them, and shows how well you still understand each part as a color-coded heat map.**

> [!NOTE]
> The name is **`gotchea`**, not `gotcha`. Watch for it in `npx gotchea`, in MCP configs and on npm.

<!-- TODO: demo GIF -->
![gotchea demo](docs/demo.gif)

> **Status: early development.** `init`, `scan`, `map`, `status`, `generate`, `quiz` and `serve` work today. See [PLAN.md](./PLAN.md) for the roadmap.

## Quick start (30 seconds)

Run these from the root of any TypeScript, JavaScript or Python repository:

```sh
npx gotchea init    # creates .gotchea/ (config + questions directory)
npx gotchea scan    # chunks the repo into .gotchea/chunks.json
npx gotchea map     # shows the comprehension heat map
```

Useful variations:

```sh
npx gotchea map src/auth                          # only one directory, file or chunk
npx gotchea map src/auth/session.ts#SessionStore  # a single symbol
npx gotchea map --json                            # machine-readable output
npx gotchea --cwd ../other-repo scan              # run against another directory
```

### Generate questions

`gotchea generate` writes multiple-choice questions for the chunks that need them most, through an LLM provider. Chunks with no questions come first, then the most imported ones, then the biggest gap (the same order as the MCP tool `get_generation_tasks`). Each batch is validated before it is saved, and rejected items are retried once.

```sh
export ANTHROPIC_API_KEY=...                       # default provider: anthropic (claude-sonnet-5-5)
npx gotchea generate                               # up to 10 chunks (generate.maxChunksPerRun)
npx gotchea generate --chunk src/math.ts#clamp     # one leaf chunk
npx gotchea generate --lang tr                     # question language (default questions.lang, en)
npx gotchea generate --verify                      # blind-verify each question; disagreements are flagged
npx gotchea generate --dry-run                     # show what would be requested, call no provider
npx gotchea generate --json                        # counts and reason codes as JSON
```

| `--provider` | Credentials | Model |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5`, or `--model` / `provider.models.anthropic` |
| `openai` | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) | required: `--model` or `provider.models.openai` |
| `openai-compatible` | optional `OPENAI_COMPAT_API_KEY`; base URL from `OPENAI_COMPAT_BASE_URL` or `provider.baseUrl` (default `http://localhost:11434/v1`) | required: `--model` or `provider.models["openai-compatible"]` |

The output is one line per chunk (`✓ src/math.ts  3 saved · 1 rejected (length_skew) · 0 flagged`) plus totals. It never prints a question, its options or its answer, so you can still take the quiz afterwards. Questions are stored against the chunk's current content hash, with line references relative to the chunk, so they survive the code moving and go stale when it changes. A missing key exits with code 2; no key is needed if you generate from your coding agent through MCP instead (below).

### Web treemap

```sh
npx gotchea serve                  # http://127.0.0.1:4477/ and opens your browser
npx gotchea serve --port 5000 --no-open
```

`gotchea serve` shows the map as a treemap: area is lines of code, color is the state (the table under [Colors](#colors)). Click a module or file to drill in, use the breadcrumb or the back button to go up, or move with the arrow keys, Enter and Backspace. The side panel shows a chunk's numbers and the `gotchea quiz <id>` (or `gotchea generate --chunk <id>`) command to copy. The page is read-only: quizzes stay in your terminal or your coding agent. It refreshes by itself every 3 seconds. The server listens on 127.0.0.1 only, accepts only `localhost`/`127.0.0.1` Host headers, and never sends question text or answers.

Commit `.gotchea/`, because it holds shared state (config, chunks, questions). Your personal progress is stored outside the repo in `~/.gotchea` (you can override this with `GOTCHEA_HOME`) and is never committed.

## Use it from your coding agent (MCP)

The MCP server gives your coding agent access to the comprehension map and lets it write the quiz questions itself, with no API key. None of the tools returns question answers:

- `scan`: chunk the repository and update the map (added, changed, moved and removed chunks).
- `get_map`: the heat map as text plus structured JSON, optionally filtered by `path` and limited by `depth`. Leaves show their usable question count, and parents show the sum.
- `get_chunk_for_file`: the innermost chunk for a `path` and `line`, or the file's chunks when no line is given.
- `get_status`: chunk and question counts, reviews due now and the colour distribution of the leaf chunks.
- `get_generation_tasks({ limit?, lang? })`: the next chunks that need questions (default 3, at most 10). Chunks with no questions come first, then the most imported ones, then the biggest gap. Each task carries `chunkId`, `chunkHash`, the chunk's code numbered from line 1, the signatures of the imports it uses, the stems of its existing questions, a type plan and the instructions with the expected JSON shape. Only stems of existing questions are included, never their options or answers.
- `save_questions({ chunkId, chunkHash, lang?, questions })`: saves the questions the agent wrote for one task. If the chunk is unknown or its code changed since the task was issued (`chunkHash` mismatch), the whole call fails and nothing is saved. Otherwise each question is validated (four distinct options, no answer leaks or length skew, line citations within the chunk, no trivia, no duplicates). The tool replies with `savedCount`, the ids it saved and `rejected: [{ index, reason, detail }]`, and never echoes the submitted text.

Without a `.gotchea` directory the tools reply with a "run `gotchea init`" message instead of an error. Quiz tools are planned.

To generate questions, ask your agent to call `get_generation_tasks` and then `save_questions` for each task. Do this in a subagent or a separate session: the answers the agent writes stay in its context, so it should not be the same context you take the quiz in.

### Claude Code

```sh
claude mcp add gotchea -- npx -y gotchea mcp
```

### Codex

Add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "mcp"]
```

## How it works

1. **Chunk.** `gotchea scan` parses your code with tree-sitter (TS/TSX/JS and Python) and builds a tree of module → file → symbol group → symbol. Large files are split into symbols, and tiny neighbors are merged. Every chunk gets a stable, human-readable id (for example `src/auth/session.ts#SessionStore.refresh`) and a content hash that ignores comments and whitespace.
2. **Quiz** *(planned)*. Each leaf chunk gets multiple-choice questions that test real understanding: behavior, edge cases, purpose, impact and bug detection.
3. **Remember.** Each chunk you pass gets a memory *stability* **S**. Your *retrievability* **R** (how likely you are to still remember it) fades over time:

   ```
   R = 1 / (1 + days_since_review / (9 × S))
   ```

   Your first pass sets S = 3 days. Each later pass multiplies S by 2.5, so reviews spread further apart. A failed quiz cuts S to 30% (minimum 1) and means you have to pass again.

### Colors

| Color | Meaning |
|---|---|
| ⚪ **grey** | The chunk has no valid questions yet, so there is nothing to measure. |
| 🔴 **red** | You never passed it, you must pass it again (after a failed quiz or a big code change), or **R < 50%**. |
| 🟡 **yellow** | You knew it, but it is fading: **50% ≤ R < 85%**. Time for a review. |
| 🟢 **green** | Fresh in memory: **R ≥ 85%**. |

Modules and files get their R as the lines-of-code-weighted average of their children, skipping grey children. A parent is grey only if all of its children are grey. All thresholds and multipliers can be tuned under `score` in `.gotchea/config.json`.

### Yellowing and fading

Your knowledge decays in two ways:

- **Time.** R drops every day you don't review. A green chunk turns **yellow** once R falls below 85%, and **red** below 50%. The moment R crosses 85% is the chunk's due date.
- **Code changes.** When a chunk's code changes (your edit or a teammate's pull), `scan` compares the new lines against a local snapshot of the version you last saw. It then shrinks your stability in proportion to the change:

  ```
  S = max(1, S × max(0.1, 1 − changeRatio))
  ```

  A small edit only shortens your memory a little, so the chunk yellows sooner. If more than **50%** of a chunk changed, you must pass it again and it turns red. Any change marks that chunk's old questions as `stale`, so it stays grey until fresh questions exist. Progress is decayed, never reset. Moved or renamed code that has the same content keeps its questions and progress.

## Requirements

- Node.js **>= 20**
- Git is recommended (files are listed with `git ls-files`, which respects `.gitignore`), but gotchea also works without it.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 Futuretea LTD
