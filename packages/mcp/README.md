# gotchea-mcp

> The MCP server for [gotchea](https://www.npmjs.com/package/gotchea): codebase comprehension maps and quizzes for coding agents.

You don't need to install it. The `gotchea` CLI starts it, which is the recommended setup:

```sh
claude mcp add gotchea -- npx -y gotchea mcp
```

For Codex, add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "mcp"]
```

This package also works on its own: `npx -y gotchea-mcp` serves the current directory over stdio. Requires Node.js >= 20.

## Tools

| Tool | What it does |
|---|---|
| `scan` | Chunk the repository and update the map (added, changed, moved and removed chunks). |
| `get_map` | The heat map with colors, LOC and question counts; optional `path` and `depth`. |
| `get_chunk_for_file` | The innermost chunk for a `path` and `line`, or the file chunk and its leaves. |
| `get_status` | Chunk and question counts, reviews due now, leaf color distribution. |
| `get_generation_tasks` | The next chunks that need questions, with numbered code and instructions (stems of existing questions only). |
| `save_questions` | Validate and save the questions written for one task; refused if the code changed. |
| `start_quiz` | Start or resume a quiz on one chunk; returns the first question, a cited code block and every option in full in a marked text block for the agent to show verbatim. Optional `includeCode: false` leaves the preview out (default: config `quiz.showCode`, `true`, for a new session; a resumed session keeps its own setting). |
| `submit_answer` | Record the user's answer; returns the reveal (correct option, explanation and the cited lines of code, up to 15 per reference and 30 per reply), then the next question with its cited code block and full options, or the result. The excerpt is left out when previews are off, the file changed since the last `scan`, or the reference is approximate. Optional `includeCode` (default: the value the session started with). |

No tool returns a correct answer or explanation before the question is answered. Generate questions in a subagent or a separate session, never in the conversation you are quizzed in.

## Taking a quiz

By default the agent shows the code block with its `path:startLine-endLine` header, the question and all options A–D exactly as returned. Answer with a letter, or choose A–D if the agent offers a selection prompt. The text result contains the complete question between `<<<SHOW TO USER VERBATIM` and `SHOW TO USER VERBATIM>>>`; selection prompts need only the letters. After each answer the agent should also show the answer-feedback block, between `<<<SHOW ANSWER FEEDBACK TO USER VERBATIM` and `SHOW ANSWER FEEDBACK TO USER VERBATIM>>>`: the correct option, the explanation and the cited code under `path:start-end` headers. The server also sends these display rules as MCP `instructions`. Showing them is a request to the agent, not something the protocol enforces. If a question has no code preview, the text says so. The agent waits for your answer before calling `submit_answer`.

Form elicitation is opt-in: launch the server with `GOTCHEA_MCP_ELICIT=on` (or `auto`) and use a client that supports forms. The form message contains the code as plain numbered lines and all options in full; its choices have short, single-line A–D titles. Long messages or code previews over 40 lines fall back to the complete text flow. `GOTCHEA_MCP_ELICIT=off` selects the default text flow explicitly.

## Programmatic use

```ts
import { createServer, startStdioServer } from 'gotchea-mcp';

await startStdioServer({ root: '/path/to/repo' }); // or connect createServer(opts) to any transport
```

## Documentation

See the [main README](https://github.com/Futuretea-LTD/gotchea#readme) and the setup guides for [Claude Code](https://github.com/Futuretea-LTD/gotchea/blob/main/docs/claude-code.md) and [Codex](https://github.com/Futuretea-LTD/gotchea/blob/main/docs/codex.md).

## License

MIT © 2026 Futuretea LTD
