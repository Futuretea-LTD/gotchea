# gotchea

> Power your code memory.

**gotchea is like Anki for your codebase: it splits a repository into meaningful chunks, quizzes you on them, and shows how well you still understand each part as a color-coded heat map.**

> [!NOTE]
> The name is **`gotchea`**, not `gotcha`. Watch for it in `npx gotchea`, in MCP configs and on npm.

<!--
  Demo GIF: not recorded yet. Record it from docs/demo.tape (`vhs docs/demo.tape`), then uncomment:
  ![gotchea demo](docs/demo.gif)
-->

## Install

gotchea needs Node.js **>= 20**. Install the CLI globally:

```sh
npm i -g gotchea
gotchea init
```

or run it without installing:

```sh
npx gotchea init
```

`init` sets up the current repository: it creates `.gotchea/` with a default `config.json` and an empty `questions/` directory, checks that git doesn't ignore `.gotchea/`, and prints where your personal progress will be stored. The examples below use `npx gotchea`; with a global install, plain `gotchea` works the same.

## Quick start

Run these from the root of any TypeScript, JavaScript or Python repository. Node.js >= 20 is all you need.

### 1. Init

```sh
npx gotchea init
```

Creates `.gotchea/` with the default `config.json` and an empty `questions/` directory, and warns you if git ignores it. Commit `.gotchea/`: it holds shared state (config, chunks, questions). Your personal progress is stored outside the repo in `~/.gotchea` (override with `GOTCHEA_HOME`) and is never committed.

### 2. Scan

```sh
npx gotchea scan          # chunks the repo into .gotchea/chunks.json
npx gotchea scan --json   # the same summary as JSON
```

Run it again after you or a teammate change code: it detects added, changed, moved and removed chunks, marks questions for changed code as stale and decays your progress in proportion to the change.

### 3. Generate questions

Each leaf chunk needs multiple-choice questions before you can be quizzed on it. There are two ways to write them.

**API-key mode (the CLI calls an LLM):**

```sh
export ANTHROPIC_API_KEY=...                       # default provider: anthropic (claude-sonnet-5-5)
npx gotchea generate                               # up to 10 chunks (generate.maxChunksPerRun)
npx gotchea generate --chunk src/math.ts#clamp     # one leaf chunk
npx gotchea generate --limit 3 --lang tr           # fewer chunks, another question language
npx gotchea generate --verify                      # blind-verify each question; disagreements are flagged
npx gotchea generate --dry-run                     # show what would be requested, call no provider
npx gotchea generate --json                        # counts and reason codes as JSON
```

| `--provider` | Credentials | Model |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` (optional `ANTHROPIC_BASE_URL`) | `claude-sonnet-5-5`, or `--model` / `provider.models.anthropic` |
| `openai` | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) | required: `--model` or `provider.models.openai` |
| `openai-compatible` | optional `OPENAI_COMPAT_API_KEY`; base URL from `OPENAI_COMPAT_BASE_URL` or `provider.baseUrl` (default `http://localhost:11434/v1`) | required: `--model` or `provider.models["openai-compatible"]` |

Chunks with no questions come first, then the most imported ones, then the biggest gap. Each batch is validated (four distinct options, no answer leaks or length skew, line citations within the chunk, no duplicates) before it is saved, and rejected items are retried once. The output is one line per chunk (`✓ src/math.ts  3 saved · 1 rejected (length_skew) · 0 flagged`) plus totals. It never prints a question, its options or its answer, so you can still take the quiz afterwards. A missing key exits with code 2.

**Host-agent mode (your coding agent writes them, no API key):** connect the [MCP server](#use-it-from-your-coding-agent-mcp) and ask your agent to call `get_generation_tasks`, write the questions, and call `save_questions` for each task. The same validator runs on the server.

> [!WARNING]
> **Keep the answer key away from the agent that quizzes you.** In host mode the agent that writes the questions also writes their answers, and those stay in its context. Generate questions in a **subagent or a separate session**, never in the conversation you take the quiz in. Guides: [Claude Code](docs/claude-code.md) · [Codex](docs/codex.md).

### 4. Quiz

```sh
npx gotchea quiz                        # the chunk that most needs review in the whole repo
npx gotchea quiz src/auth               # the best chunk under a directory or file
npx gotchea quiz 'src/math.ts#clamp'    # one leaf chunk (id or alias)
npx gotchea quiz --count 3 --lang tr --new
```

The quiz runs in your terminal (it needs a TTY). Each question shows the chunk's current source above it, with line numbers. Set `quiz.showCode` to `false` in `.gotchea/config.json` to hide it by default (default `true`); `--code` / `--no-code` override the config for one run. With the code on screen the quiz is open book: it tests whether you can read the code, not whether you remember it. Pick an answer with the arrow keys and Enter; after each answer you see whether it was right, the correct option, the explanation and the line references. After the last question you get pass or fail, the chunk's color change and a mini heat map. To pass you need 75% correct (`quiz.passRatio`). An unfinished quiz is offered for resume next time (`--new` starts fresh), and Ctrl-C abandons it without scoring. If the chunk has too few questions, `quiz` offers to run `generate` for it.

### 5. Map and serve

```sh
npx gotchea map                                   # the comprehension heat map in the terminal
npx gotchea map src/auth                          # only one directory, file or chunk
npx gotchea map src/auth/session.ts#SessionStore  # a single symbol
npx gotchea map --json                            # machine-readable output
npx gotchea status                                # chunk and question counts, reviews due, color distribution
npx gotchea serve                                 # web treemap on http://127.0.0.1:4477/
```

`gotchea serve` shows the map as a treemap: area is lines of code, color is the state (see [Colors](#colors)). Click a module or file to drill in, use the breadcrumb or the back button to go up, or move with the arrow keys, Enter and Backspace. The side panel shows a chunk's numbers and the `gotchea quiz <id>` (or `gotchea generate --chunk <id>`) command to copy. The page is read-only: quizzes stay in your terminal or your coding agent. It refreshes by itself every 3 seconds. The server listens on 127.0.0.1 only, accepts only `localhost`/`127.0.0.1` Host headers, and never sends question text or answers.

## Commands

Every command accepts the global options `--cwd <dir>` (run as if started in `<dir>`) and `--no-color`, plus `-h, --help` and `-V, --version`.

| Command | Options | What it does |
|---|---|---|
| `init` | `-f, --force` | Create `.gotchea/` with the default config and the questions directory. `--force` resets an existing config to the defaults. |
| `scan` | `--json` | Chunk the repository and update `.gotchea/chunks.json`, stale questions and progress decay. |
| `status` | `--json` | Show tracked chunks, questions, what is due and the color distribution. |
| `map [path]` | `--json` | Show the heat map (repo > module > file > symbol), optionally for one directory, file or chunk id. |
| `generate` | `--chunk <id>` `--provider <name>` `--model <id>` `--lang <code>` `--limit <n>` `--verify` / `--no-verify` `--dry-run` `--json` | Generate questions with an LLM provider for the chunks that need them most. |
| `quiz [target]` | `--count <n>` (1–10) `--lang <code>` `--new` `--code` / `--no-code` | Quiz yourself on a chunk: the one that most needs review under `target`, or the named leaf. |
| `serve [path]` | `--port <n>` (default 4477, 0 = any free port) `--no-open` | Serve the read-only web heat map on 127.0.0.1 until Ctrl+C. |
| `mcp` | | Start the MCP server on stdio (for Claude Code, Codex and other MCP clients). |

Exit codes: 0 success, 1 a command was refused or failed (for example nothing to quiz, or an invalid `.gotchea/config.json`), 2 usage errors (unknown commands or options, invalid option values, a missing provider API key).

## Use it from your coding agent (MCP)

The MCP server gives your coding agent the comprehension map, lets it write quiz questions with no API key, and lets it quiz you. It works on the directory it is started in.

```sh
npx -y gotchea mcp        # canonical: the CLI starts the server (accepts --cwd <dir> before `mcp`)
npx -y gotchea-mcp       # alternative: the standalone server package (uses the current directory)
```

| Tool | What it does |
|---|---|
| `scan` | Chunk the repository and update the map: detects added, changed, moved and removed chunks. Runs synchronously. |
| `get_map` | The heat map (repo > module > file > symbol) with colors, LOC and question counts. Optional `path` filter and `depth` limit. |
| `get_chunk_for_file` | The innermost chunk covering a `path` and `line`, or the file chunk and its leaves when no line is given. Served from an in-memory index. |
| `get_status` | Tracked chunk count, question count, reviews due now and the color distribution of the leaf chunks. |
| `get_generation_tasks` | The next chunks that need questions (`limit` 1–10, default 3; optional `lang`): numbered code, import signatures, existing stems only, and the instructions. |
| `save_questions` | Save the questions written for one task (`chunkId`, `chunkHash`, `questions`). Refused as a whole if the code changed; otherwise each question is validated and rejects come back as `{ index, reason, detail }`. |
| `start_quiz` | Start (or resume) a quiz on one chunk, by `path` or `chunkId`, optional `count`, `lang` and `includeCode`. Returns the first question only, with the chunk's current source as `code` (left out if the file changed since the last scan, or with `includeCode: false`; a new session defaults to `quiz.showCode`, a resumed one to its own setting). |
| `submit_answer` | Submit the user's choice (`sessionId`, `questionId`, `displayIndex` A=0…D=3; optional `includeCode`, default the session's setting). Returns the reveal for that question, including the cited lines of code (up to 15 per reference and 30 per reply; left out when previews are off, the file changed since the last scan, or the reference is approximate), then the next question or the result. |

No tool output contains a correct answer or an explanation before the question has been answered; sessions and the answer key stay on the server. Without a `.gotchea` directory the tools reply with a "run `gotchea init`" message instead of an error. Form elicitation is opt-in: set `GOTCHEA_MCP_ELICIT=on` (or `auto`) and use a client that supports forms, and `start_quiz` asks you the questions through the client's form UI. By default the quiz uses the text flow, where the agent relays the marked block verbatim. Long messages or code previews over 40 lines fall back to the text flow.

### Claude Code

```sh
claude mcp add gotchea -- npx -y gotchea mcp
```

See [docs/claude-code.md](docs/claude-code.md) for an example session, generating questions in a subagent and a `CLAUDE.md` snippet.

### Codex

Add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "mcp"]
```

See [docs/codex.md](docs/codex.md) for an `AGENTS.md` snippet.

> [!WARNING]
> **Answer-key isolation.** The tools never return answers before you answer, but two leaks are accepted by design: `.gotchea/questions/*.json` on disk contains the answers, and in host mode the generating agent's context contains the answers it wrote. Generate in a subagent or a separate session, and don't let the quizzing agent read `.gotchea/questions/`.

## How it works

1. **Chunk.** `gotchea scan` parses your code with tree-sitter (TS/TSX/JS and Python) and builds a tree of module → file → symbol group → symbol. Large files are split into symbols, and tiny neighbors are merged. Every chunk gets a stable, human-readable id (for example `src/auth/session.ts#SessionStore.refresh`) and a content hash that ignores comments and whitespace.
2. **Quiz.** Each leaf chunk gets multiple-choice questions that test real understanding: behavior, edge cases, purpose, impact and bug detection. Questions are stored against the chunk's content hash, with line references relative to the chunk, so they survive the code moving and go stale when it changes.
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
- **Code changes.** When a chunk's code changes (your edit or a teammate's pull), gotchea compares the new lines against a local snapshot of the version you last saw. It then shrinks your stability in proportion to the change:

  ```
  S = max(1, S × max(0.1, 1 − changeRatio))
  ```

  A small edit only shortens your memory a little, so the chunk yellows sooner. If more than **50%** of a chunk changed, you must pass it again and it turns red. Any change marks that chunk's old questions as `stale`, so it stays grey until fresh questions exist. Progress is decayed, never reset. Moved or renamed code that has the same content keeps its questions and progress.

## Environment variables

| Variable | Effect |
|---|---|
| `GOTCHEA_HOME` | Where personal state lives: progress, quiz sessions, code snapshots and the scan cache, under `repos/<repoId>/` (default `~/.gotchea`). Shared repo state always stays in `<repo>/.gotchea/` and is not affected. |
| `GOTCHEA_LOCK_TIMEOUT_MS` | How long to wait for the per-repo lock before giving up (default 30000). |
| `GOTCHEA_MCP_ELICIT` | `on` or `auto` enables quiz form elicitation in the MCP server (default: off, text flow). |
| `GOTCHEA_DEBUG` | Print stack traces for unexpected errors. |
| `ANTHROPIC_API_KEY` | API key for the default `anthropic` provider. |
| `ANTHROPIC_BASE_URL` | Sends `anthropic` provider requests to another base URL, such as a proxy or gateway (default: the Anthropic SDK's endpoint). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Key and optional base URL for the `openai` provider. |
| `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_BASE_URL` | Optional key and base URL for the `openai-compatible` provider; the base URL wins over `provider.baseUrl`. |

Provider variables are read by `gotchea generate` only (see the provider table above).

## Requirements

- Node.js **>= 20**
- Git is recommended (files are listed with `git ls-files`, which respects `.gitignore`), but gotchea also works without it.

## Packages

| npm package | Role |
|---|---|
| [`gotchea`](packages/cli) | The CLI (`npx gotchea`), including `gotchea mcp` and the bundled web UI |
| [`gotchea-core`](packages/core) | The comprehension engine (chunking, scanning, question pools, quizzes, scoring) |
| [`gotchea-mcp`](packages/mcp) | The MCP server |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Coding agents working on this repo should read [AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE) © 2026 Futuretea LTD
