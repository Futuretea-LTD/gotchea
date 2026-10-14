# gotchea

> Power your code memory: spaced-repetition comprehension quizzes for your codebase.

The name is **`gotchea`**, not `gotcha`.

## Usage

Requires Node.js >= 20. You don't need to install anything; run it with `npx` from your repository root:

```sh
npx gotchea init    # create .gotchea/ (config + questions directory)
npx gotchea scan    # chunk the repository into .gotchea/chunks.json
npx gotchea map     # show the comprehension heat map (add --json for JSON)
npx gotchea status  # chunk and question counts, reviews due, colour distribution
npx gotchea generate [--chunk <id>] [--provider anthropic|openai|openai-compatible] [--lang <code>]
                    # write questions with an LLM (ANTHROPIC_API_KEY by default; see the main README)
```

`quiz` and `serve` are planned and are not implemented yet.

### MCP server

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

## Documentation

See the [main README](https://github.com/Futuretea-LTD/gotchea#readme) for how chunks, colors and decay work.

## License

MIT © 2026 Futuretea LTD
