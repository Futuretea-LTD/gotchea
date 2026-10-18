# gotchea with Claude Code

gotchea's MCP server lets Claude Code show your comprehension map, find the chunk you are editing, write quiz questions without an API key, and quiz you. See the [main README](../README.md) for what chunks, colors and decay mean.

## Setup

Initialize and scan the repository once (you can also ask Claude to call the `scan` tool later):

```sh
npx gotchea init
npx gotchea scan
```

Then add the server:

```sh
claude mcp add gotchea -- npx -y gotchea mcp
```

The server works on the directory it is started in, which is normally the directory you launched `claude` from, so launch it from the repository root (or pin the repository with `--cwd`, see [Troubleshooting](#troubleshooting)). The default scope is local (this project, only you). Add `--scope project` to write it to `.mcp.json` so teammates get it too, or `--scope user` to make it available in every project.

Alternative: the standalone server package, which uses the current directory:

```sh
claude mcp add gotchea -- npx -y gotchea-mcp
```

Check with `/mcp` inside Claude Code (or `claude mcp get gotchea` from a shell) that `gotchea` is connected. It provides 8 tools: `scan`, `get_map`, `get_chunk_for_file`, `get_status`, `get_generation_tasks`, `save_questions`, `start_quiz` and `submit_answer`.

## Example session

> **You:** show my map
>
> Claude calls `get_map` and shows the heat map: modules, files and symbols with their colors, LOC and question counts. Add a path ("show my map for src/auth") to filter it.

> **You:** what's due?
>
> Claude calls `get_status`: tracked chunks, questions, reviews due now and the color distribution.

> **You:** quiz me on this file
>
> Claude calls `get_chunk_for_file` for the file you have open (or name), then `start_quiz` with that `path`. gotchea picks the chunk under it that most needs review and returns the first question, with the chunk's current source above it. Claude shows the cited code block, the question and all four options verbatim; you answer with a letter (or choose A–D in a selection prompt), and Claude passes your choice to `submit_answer`. Each reply reveals whether you were right, the correct option, the explanation and the cited lines of code, then the next question. After the last one you get pass or fail, the chunk's new color and a mini heat map.

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

The preview is the chunk's source as it is now, up to 60 lines (longer chunks are cut and marked truncated). It is left out if the file changed since the last `scan`; run `scan` to get it back. In the terminal, `npx gotchea quiz` prints the same preview with line numbers, and `--no-code` hides it.

With the code shown, the quiz is open book. For a closed-book quiz, ask Claude to pass `includeCode: false` to `start_quiz` (the session keeps that setting), or set `quiz.showCode` to `false` in `.gotchea/config.json`.

The tool descriptions tell Claude to show the code block, the question and every option in full, then wait for your answer. The text result marks that passage with `<<<SHOW TO USER VERBATIM` and `SHOW TO USER VERBATIM>>>`. If a selection prompt is offered, its choices can be just A–D because the full text is in Claude's reply. After each answer the result also carries an answer-feedback block (correct option, explanation and the cited code), marked with `<<<SHOW ANSWER FEEDBACK TO USER VERBATIM` and `SHOW ANSWER FEEDBACK TO USER VERBATIM>>>`; the server's MCP `instructions` repeat these display rules. The cited code is left out when previews are off, the file changed since the last `scan`, or the reference is approximate. Showing it is a request to the agent, so ask Claude to show the block if it summarises.

Form elicitation is opt-in: set `GOTCHEA_MCP_ELICIT=on` (or `auto`) when launching the server and use a client that supports forms. The form message shows code as plain numbered lines and all options in full, with short A–D choices below. Long messages or code previews over 40 lines fall back to the text flow. `GOTCHEA_MCP_ELICIT=off` explicitly selects the default text flow.

If a quiz is refused because the chunk has too few questions, generate them first (next section).

## Generating questions in a subagent

In host mode Claude writes the questions, so the answers end up in the context of whoever wrote them. **Never generate in the same conversation you take the quiz in.** Use a subagent: its context is discarded when it finishes, and only its summary comes back.

Ask, for example:

> Use a subagent to generate gotchea questions: it should call `get_generation_tasks` with limit 3, write the questions for each task following the task instructions, and call `save_questions` with the task's `chunkId` and `chunkHash` unchanged. If some questions are rejected, it should fix only those and resubmit them. Report back only the saved and rejected counts, never the questions or answers.

Or define a dedicated subagent in `.claude/agents/gotchea-generator.md`:

```markdown
---
name: gotchea-generator
description: Writes gotchea quiz questions through the gotchea MCP tools. Use when asked to generate gotchea questions.
---

You write multiple-choice comprehension questions for gotchea.

1. Call `get_generation_tasks` (limit 3 unless told otherwise).
2. For each task, write the questions exactly as its instructions describe, citing chunk-relative lines.
3. Call `save_questions` with the task's `chunkId` and `chunkHash` unchanged.
4. For rejected items, fix only those and resubmit them. If the whole call is refused because the code changed, skip that task.

Reply with counts only (saved, rejected, refused tasks). Never repeat a question, its options or its answer.
```

A fresh `claude` session in another terminal works too. Alternatively, generate with an API key from the terminal (`npx gotchea generate`), which never prints questions or answers.

The questions are also stored, with their answers, in `.gotchea/questions/*.json`. Don't let the agent that quizzes you read that directory.

## CLAUDE.md snippet

Add this to your repository's `CLAUDE.md`:

```markdown
## gotchea (code comprehension quizzes)

This repo uses gotchea through the `gotchea` MCP server.

- "Show my map" → `get_map` (pass `path` to narrow it). "What's due?" → `get_status`.
- "Quiz me on <file or dir>" → `start_quiz` with that `path`, then `submit_answer` for each answer. Show me the code block, the question and all options exactly as the tool returns them, and every answer-feedback block with its cited code. Ask me every question and wait for my answer; never answer for me or hint at the answer.
- To find the chunk for a file or line, use `get_chunk_for_file`.
- After large edits or a pull, call `scan` so the map and decay are current.
- Generate questions (`get_generation_tasks` → `save_questions`) only in a subagent, never in the conversation I am quizzed in.
- Never read `.gotchea/questions/`: it contains the answer key.
```

## Troubleshooting

- **"run `gotchea init`"**: the server found no `.gotchea/` in the directory it was started in. Run `npx gotchea init` there, or pin the directory with `claude mcp add gotchea -- npx -y gotchea --cwd /path/to/repo mcp`.
- **Empty map**: run `npx gotchea scan` (or ask Claude to call `scan`).
- **Everything grey**: no questions yet. Generate some in a subagent or with `npx gotchea generate`.
- **Shortened options or missing code**: ask Claude to show the question verbatim, including the code block and every option. Code previews and answer-feedback blocks need a release newer than 0.1.1 (`npx gotchea --version`).
