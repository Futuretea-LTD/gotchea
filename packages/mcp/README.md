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
| `start_quiz` | Start or resume a quiz on one chunk; returns the first question. |
| `submit_answer` | Record the user's answer; returns the reveal, then the next question or the result. |

No tool returns a correct answer or explanation before the question is answered. Generate questions in a subagent or a separate session, never in the conversation you are quizzed in.

## Programmatic use

```ts
import { createServer, startStdioServer } from 'gotchea-mcp';

await startStdioServer({ root: '/path/to/repo' }); // or connect createServer(opts) to any transport
```

## Documentation

See the [main README](https://github.com/Futuretea-LTD/gotchea#readme) and the setup guides for [Claude Code](https://github.com/Futuretea-LTD/gotchea/blob/main/docs/claude-code.md) and [Codex](https://github.com/Futuretea-LTD/gotchea/blob/main/docs/codex.md).

## License

MIT © 2026 Futuretea LTD
