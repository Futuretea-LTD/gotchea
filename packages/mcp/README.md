# gotchea-mcp

> The MCP server for [gotchea](https://www.npmjs.com/package/gotchea): codebase comprehension maps and quizzes for coding agents.

**This is a library package.** End users should not install it directly. Use the `gotchea` CLI, which starts the server:

```sh
claude mcp add gotchea -- npx -y gotchea mcp
```

For Codex, add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "mcp"]
```

It requires Node.js >= 20. The server is in early development, and its tools are still being added.

Tools: `scan`, `get_map`, `get_chunk_for_file`, `get_status`, `get_generation_tasks` and `save_questions`. The last two let the host agent write quiz questions itself, with no API key. See the main README for details.

## Documentation

See the [main README](https://github.com/Futuretea-LTD/gotchea#readme).

## License

MIT © 2026 Futuretea LTD
