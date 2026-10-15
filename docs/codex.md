# gotchea with Codex

gotchea's MCP server lets Codex show your comprehension map, find the chunk you are editing, write quiz questions without an API key, and quiz you. See the [main README](../README.md) for what chunks, colors and decay mean.

## Setup

Initialize and scan the repository once:

```sh
npx gotchea init
npx gotchea scan
```

Then add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "mcp"]
```

The server works on the directory it is started in, so start Codex from the repository root. To pin it to one repository instead, pass `--cwd` before `mcp`:

```toml
[mcp_servers.gotchea]
command = "npx"
args = ["-y", "gotchea", "--cwd", "/path/to/repo", "mcp"]
```

Alternative: the standalone server package (`args = ["-y", "gotchea-mcp"]`), which always uses the current directory.

The server exposes 8 tools: `scan`, `get_map`, `get_chunk_for_file`, `get_status`, `get_generation_tasks`, `save_questions`, `start_quiz` and `submit_answer`. The [tool table](../README.md#use-it-from-your-coding-agent-mcp) in the README describes each one.

## Example session

- "Show my map" → Codex calls `get_map`.
- "What's due?" → `get_status`.
- "Quiz me on src/auth/session.ts" → `start_quiz` with that `path`. Codex shows you each question with options A–D; you answer, and it calls `submit_answer` with your choice. Each reply reveals the correct option and the explanation, then the next question; the last one returns pass or fail and the chunk's new color.

## Generating questions

In host mode the agent writes the questions, so the answers end up in its context. **Generate in a separate Codex session**, not the one you take the quiz in: start a new session, ask it to call `get_generation_tasks`, write the questions and call `save_questions` for each task, and close it when done. Or generate from the terminal with an API key (`npx gotchea generate`), which never prints questions or answers.

The questions are also stored, with their answers, in `.gotchea/questions/*.json`. Don't let the agent that quizzes you read that directory.

## AGENTS.md snippet

Add this to your repository's `AGENTS.md`:

```markdown
## gotchea (code comprehension quizzes)

This repo uses gotchea through the `gotchea` MCP server.

- "Show my map" → `get_map` (pass `path` to narrow it). "What's due?" → `get_status`.
- "Quiz me on <file or dir>" → `start_quiz` with that `path`, then `submit_answer` for each answer. Ask me every question and wait for my answer; never answer for me or hint at the answer.
- To find the chunk for a file or line, use `get_chunk_for_file`.
- After large edits or a pull, call `scan` so the map and decay are current.
- Only generate questions (`get_generation_tasks` → `save_questions`) when I ask for it in a dedicated session, never in a session where I am quizzed.
- Never read `.gotchea/questions/`: it contains the answer key.
```

## Troubleshooting

- **"run `gotchea init`"**: the server found no `.gotchea/` in the directory it was started in. Run `npx gotchea init` there, or pin the directory with `--cwd` as shown above.
- **Empty map**: run `npx gotchea scan` (or ask Codex to call `scan`).
- **Everything grey**: no questions yet. Generate some in a separate session or with `npx gotchea generate`.
