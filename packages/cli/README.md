# gotchea

> Power your code memory: spaced-repetition comprehension quizzes for your codebase.

The name is **`gotchea`**, not `gotcha`. Requires Node.js >= 20; run it with `npx` from your repository root:

```sh
npx gotchea init       # create .gotchea/ (config + questions directory)
npx gotchea scan       # chunk the repository into .gotchea/chunks.json
npx gotchea generate   # write questions with an LLM (ANTHROPIC_API_KEY by default)
npx gotchea quiz       # quiz yourself on the chunk that most needs review
npx gotchea map        # the comprehension heat map
npx gotchea serve      # the heat map as a web treemap on 127.0.0.1:4477
```

## Install

Requires Node.js >= 20.

```sh
npm i -g gotchea      # then run `gotchea <command>`
npx gotchea init      # or run it without installing
```

`init` creates `.gotchea/` in the current repository with a default `config.json` and an empty `questions/` directory, warns you if git ignores `.gotchea/` (commit it: it holds the shared config, chunks and questions) and prints where your personal progress will be stored.

## Commands

| Command | Options |
|---|---|
| `init` | `-f, --force` |
| `scan` | `--json` |
| `status` | `--json` |
| `map [path]` | `--json` |
| `generate` | `--chunk <id>` `--provider <anthropic\|openai\|openai-compatible>` `--model <id>` `--lang <code>` `--limit <n>` `--verify` / `--no-verify` `--dry-run` `--json` |
| `quiz [target]` | `--count <n>` `--lang <code>` `--new` |
| `serve [path]` | `--port <n>` `--no-open` |
| `mcp` | starts the MCP server on stdio |

Global options: `--cwd <dir>`, `--no-color`, `-h, --help`, `-V, --version`.

## MCP server

Claude Code:

```sh
claude mcp add gotchea -- npx -y gotchea mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "mcp"]
```

Generate questions in a subagent or a separate session, never in the conversation you take the quiz in: the generating agent keeps the answers it wrote in its context.

## Environment variables

| Variable | Effect |
|---|---|
| `GOTCHEA_HOME` | Where personal progress, quiz sessions, snapshots and the scan cache live (default `~/.gotchea`). Shared state stays in `<repo>/.gotchea/`. |
| `GOTCHEA_LOCK_TIMEOUT_MS` | How long to wait for the per-repo lock (default 30000). |
| `GOTCHEA_MCP_ELICIT` | `off` disables quiz elicitation in `gotchea mcp`. |
| `GOTCHEA_DEBUG` | Print stack traces for unexpected errors. |
| `ANTHROPIC_API_KEY` | API key for the default `anthropic` provider of `generate`. |
| `ANTHROPIC_BASE_URL` | Another base URL for the `anthropic` provider, such as a proxy or gateway (default: the Anthropic SDK's endpoint). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Key and optional base URL for `--provider openai`. |
| `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_BASE_URL` | Optional key and base URL for `--provider openai-compatible` (the base URL wins over `provider.baseUrl`). |

## Documentation

See the [main README](https://github.com/Futuretea-LTD/gotchea#readme) for the full guide: question generation (API key or your coding agent), the MCP tools, colors and decay.

## License

MIT © 2026 Futuretea LTD
