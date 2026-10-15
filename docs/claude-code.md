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
> Claude calls `get_chunk_for_file` for the file you have open (or name), then `start_quiz` with that `path`. gotchea picks the chunk under it that most needs review and returns the first question. Claude shows you the four options; you answer with a letter, and Claude passes your choice to `submit_answer`. Each reply reveals whether you were right, the correct option, the explanation and the line references, then the next question. After the last one you get pass or fail, the chunk's new color and a mini heat map.

The tool descriptions tell Claude to ask you each question and never to guess the answer itself. If your client supports MCP form elicitation, the questions are shown to you directly as a choice form, and the model never sees a question before you answer it (`GOTCHEA_MCP_ELICIT=off` disables this).

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
- "Quiz me on <file or dir>" → `start_quiz` with that `path`, then `submit_answer` for each answer. Ask me every question and wait for my answer; never answer for me or hint at the answer.
- To find the chunk for a file or line, use `get_chunk_for_file`.
- After large edits or a pull, call `scan` so the map and decay are current.
- Generate questions (`get_generation_tasks` → `save_questions`) only in a subagent, never in the conversation I am quizzed in.
- Never read `.gotchea/questions/`: it contains the answer key.
```

## Troubleshooting

- **"run `gotchea init`"**: the server found no `.gotchea/` in the directory it was started in. Run `npx gotchea init` there, or pin the directory with `claude mcp add gotchea -- npx -y gotchea --cwd /path/to/repo mcp`.
- **Empty map**: run `npx gotchea scan` (or ask Claude to call `scan`).
- **Everything grey**: no questions yet. Generate some in a subagent or with `npx gotchea generate`.
