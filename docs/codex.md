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
- "Quiz me on src/auth/session.ts" → `start_quiz` with that `path`. Codex shows the cited code block, each question and every option A–D verbatim; you answer with a letter (or choose A–D in a selection prompt), and it calls `submit_answer` with your choice. Each reply reveals the correct option and the explanation, then the next question; the last one returns pass or fail and the chunk's new color.

A question looks like this:

````text
Question 1 of 4 · 3 correct to pass

Code: src/auth/session.ts:18-22
```typescript
export async function refresh(session: Session): Promise<Session> {
  if (session.expiresAt > Date.now() + SKEW_MS) return session;
  const token = await issueToken(session.userId);
  return { ...session, token, expiresAt: Date.now() + TTL_MS };
}
```

When does `refresh` call `issueToken`?

A) On every call
B) Only when the session expires within SKEW_MS from now
C) Only after the session has already expired
D) Only when `session.token` is empty
````

The preview shows up to 60 lines and is left out if the file changed since the last `scan`. In the terminal, `npx gotchea quiz` prints it with line numbers; `--no-code` hides it.

With the code shown, the quiz is open book. For a closed-book quiz, ask Codex to pass `includeCode: false` to `start_quiz` (the session keeps that setting), or set `quiz.showCode` to `false` in `.gotchea/config.json`.

The tool descriptions tell Codex to show the code block, the question and every option in full, then wait for your answer. The text result marks that passage with `<<<SHOW TO USER VERBATIM` and `SHOW TO USER VERBATIM>>>`. If a selection prompt is offered, its choices can be just A–D because the full text is in Codex's reply. After each answer the result also carries an answer-feedback block (correct option, explanation and the cited code), marked with `<<<SHOW ANSWER FEEDBACK TO USER VERBATIM` and `SHOW ANSWER FEEDBACK TO USER VERBATIM>>>`; the server's MCP `instructions` repeat these display rules. The cited code is left out when previews are off, the file changed since the last `scan`, or the reference is approximate. Showing it is a request to the agent, so ask Codex to show the block if it summarises.

Form elicitation is opt-in: set `GOTCHEA_MCP_ELICIT=on` (or `auto`) when launching the server and use a client that supports forms. The form message shows code as plain numbered lines and all options in full, with short A–D choices below. Long messages or code previews over 40 lines fall back to the text flow. `GOTCHEA_MCP_ELICIT=off` explicitly selects the default text flow.

## Generating questions

In host mode the agent writes the questions, so the answers end up in its context. **Generate in a separate Codex session**, not the one you take the quiz in: start a new session, ask it to call `get_generation_tasks`, write the questions and call `save_questions` for each task, and close it when done. Or generate from the terminal with an API key (`npx gotchea generate`), which never prints questions or answers.

The questions are also stored, with their answers, in `.gotchea/questions/*.json`. Don't let the agent that quizzes you read that directory.

## AGENTS.md snippet

Add this to your repository's `AGENTS.md`:

```markdown
## gotchea (code comprehension quizzes)

This repo uses gotchea through the `gotchea` MCP server.

- "Show my map" → `get_map` (pass `path` to narrow it). "What's due?" → `get_status`.
- "Quiz me on <file or dir>" → `start_quiz` with that `path`, then `submit_answer` for each answer. Show me the code block, the question and all options exactly as the tool returns them, and every answer-feedback block with its cited code. Ask me every question and wait for my answer; never answer for me or hint at the answer.
- To find the chunk for a file or line, use `get_chunk_for_file`.
- After large edits or a pull, call `scan` so the map and decay are current.
- Only generate questions (`get_generation_tasks` → `save_questions`) when I ask for it in a dedicated session, never in a session where I am quizzed.
- Never read `.gotchea/questions/`: it contains the answer key.
```

## Troubleshooting

- **"run `gotchea init`"**: the server found no `.gotchea/` in the directory it was started in. Run `npx gotchea init` there, or pin the directory with `--cwd` as shown above.
- **Empty map**: run `npx gotchea scan` (or ask Codex to call `scan`).
- **Everything grey**: no questions yet. Generate some in a separate session or with `npx gotchea generate`.
- **Shortened options or missing code**: ask Codex to show the question verbatim, including the code block and every option. Code previews and answer-feedback blocks need a release newer than 0.1.1 (`npx gotchea --version`).
