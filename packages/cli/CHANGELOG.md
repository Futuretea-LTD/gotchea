# gotchea

## 0.2.0

### Minor Changes

- e9ff012: - **Quiz questions show the code they ask about.** Each question can carry an optional `code` preview (`path`, `startLine`, `endLine`, `language`, `text`, `truncated?`) with the chunk's current source, up to 60 lines. It is left out when the file changed since the last `scan`, so you never see code that no longer matches the question. It carries nothing from the answer key. With the code on screen the quiz is open book.
  - **New config key `quiz.showCode`** (default `true`) turns the preview on or off for every interface.
  - **`gotchea quiz`** prints the preview above each question as a numbered, lightly highlighted block (plain when colours are off). `--code` / `--no-code` override `quiz.showCode` for one run.
  - **MCP:** `start_quiz` and `submit_answer` return `code` on `question` / `next` and render it as a fenced block above the stem, with a header that follows `questions.lang`. Both accept an optional `includeCode`: `start_quiz` defaults to `quiz.showCode`, and the session keeps that value, so `submit_answer` defaults to it. The question text is wrapped in a `SHOW TO USER VERBATIM` block, and tool descriptions tell the agent to show the cited code and every option in full before asking for the user's answer. Elicitation forms put full options and plain numbered code lines in the message, use short A–D choices, and fall back to the text flow for long messages or code. Form elicitation is now opt-in: `GOTCHEA_MCP_ELICIT=on` (or `auto`).
  - Control and bidi characters in code previews, and in the question text, explanations, paths and chunk titles that `gotchea quiz` prints and that the MCP quiz tools put in their text (and elicitation prompts), are shown as visible placeholders, so they can't move the cursor or make code read differently than it runs. `structuredContent` keeps the stored text.
  - `gotchea serve` has no quiz route; its API leak guard now also rejects a `code` key.

### Patch Changes

- 0b99e90: - **MCP answer feedback shows the cited code.** `submit_answer` reveals now carry an optional `excerpt` (`language`, `text`, `truncated?`) per reference: the cited lines, sanitized, up to 15 per reference and 30 per reveal. It is left out when previews are off, the file changed since the last `scan` or the reference is approximate, and it only appears after the answer was recorded. The text result wraps each reveal in `SHOW ANSWER FEEDBACK TO USER VERBATIM` markers, separate from the question markers, and the server sends its display rules as MCP `instructions`.
  - Elicitation choice titles are `A) ` plus at most 24 characters of the option; the form message and the text flow carry every option in full. Continuation lines of options, correct answers and explanations are indented so a code fence inside them can't swallow the rest of the message.
  - `excerpt` joins the forbidden answer-key keys for pre-answer values and the `serve` API guard.
- Updated dependencies [e9ff012]
- Updated dependencies [0b99e90]
  - gotchea-core@0.2.0
  - gotchea-mcp@0.2.0

## 0.1.1

### Patch Changes

- 0768395: - **git ignore rules are honoured in full.** Paths now go to `git check-ignore` on stdin (current git rejects `-z` without `--stdin`, so the check always fell back to the root `.gitignore`). Nested `.gitignore` files, `.git/info/exclude` and the global `core.excludesFile` are now respected when `gotchea init` checks that `.gotchea/` can be committed. If git fails for any reason other than "not a repository", a warning is printed before falling back to the root ignore files.
  - **MCP text follows `questions.lang`.** `get_map` text is English by default, and Turkish when `questions.lang` is `tr` (or `tr-TR`).
  - An unknown provider now throws a configuration `ProviderError` (`unknown_provider`) that lists the valid provider names.
  - `GOTCHEA_NOW` (ISO date or epoch milliseconds) pins application time for reproducible runs across the CLI and MCP.
  - README: install instructions and a table of environment variables.
  - CI: tests also run on Node 24.
- Updated dependencies [0768395]
  - gotchea-core@0.1.1
  - gotchea-mcp@0.1.1

## 0.1.0

### Minor Changes

- de39c06: Initial public release of gotchea, spaced-repetition comprehension quizzes for your codebase.
  
  - **`gotchea` CLI** (`npx gotchea`):
    - `init` creates `.gotchea/` (config and questions directory) and warns if git ignores it.
    - `scan` chunks TypeScript, JavaScript and Python with tree-sitter (module → file → symbol group → symbol), detects added, changed, moved and removed chunks, marks questions for changed code as stale and decays progress in proportion to the change (`--json` for a machine-readable summary).
    - `generate` writes multiple-choice questions through Anthropic, OpenAI or any OpenAI-compatible endpoint, validates every batch (answer leaks, length skew, line citations, duplicates) and can blind-verify them. It never prints questions or answers.
    - `quiz` runs an interactive terminal quiz on the chunk that most needs review, reveals the answer and explanation after each question, and updates the chunk's stability and color.
    - `map` and `status` show the comprehension heat map and the counts (`--json` for both).
    - `serve [path] [--port <n>] [--no-open]` shows the map as a read-only web treemap on 127.0.0.1 (area = lines of code, colour = retention on a single-hue scale, drill-down, hover and focus tooltips, a legend with per-state counts, a repository stats row, dark and light themes, live refresh) with a JSON API (`/api/map`, `/api/status`).
    - `mcp` starts the MCP server on stdio.
  - **`gotchea-mcp`**: the MCP server with the tools `scan`, `get_map`, `get_chunk_for_file`, `get_status`, `get_generation_tasks`, `save_questions` (the host agent writes questions, no API key needed), `start_quiz` and `submit_answer`. Sessions are server-side, and no output contains an answer before the question is answered.
  - **`gotchea-core`**: the engine behind both: chunking, content hashing, scanning, question pools and validation, LLM providers, quiz sessions, spaced-repetition scoring and the shared map JSON (`MapJson`, `StatusJson`), so `map --json`, MCP `get_map` and `GET /api/map` return the same shape.

### Patch Changes

- Updated dependencies [de39c06]
  - gotchea-core@0.1.0
  - gotchea-mcp@0.1.0
