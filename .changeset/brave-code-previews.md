---
"gotchea": minor
"gotchea-core": minor
"gotchea-mcp": minor
---

- **Quiz questions show the code they ask about.** Each question can carry an optional `code` preview (`path`, `startLine`, `endLine`, `language`, `text`, `truncated?`) with the chunk's current source, up to 60 lines. It is left out when the file changed since the last `scan`, so you never see code that no longer matches the question. It carries nothing from the answer key. With the code on screen the quiz is open book.
- **New config key `quiz.showCode`** (default `true`) turns the preview on or off for every interface.
- **`gotchea quiz`** prints the preview above each question as a numbered, lightly highlighted block (plain when colours are off). `--code` / `--no-code` override `quiz.showCode` for one run.
- **MCP:** `start_quiz` and `submit_answer` return `code` on `question` / `next` and render it as a fenced block above the stem, with a header that follows `questions.lang`. Both accept an optional `includeCode`: `start_quiz` defaults to `quiz.showCode`, and the session keeps that value, so `submit_answer` defaults to it. The question text is wrapped in a `SHOW TO USER VERBATIM` block, and tool descriptions tell the agent to show the cited code and every option in full before asking for the user's answer. Elicitation forms put full options and plain numbered code lines in the message, use short A–D choices, and fall back to the text flow for long messages or code. Form elicitation is now opt-in: `GOTCHEA_MCP_ELICIT=on` (or `auto`).
- Control and bidi characters in code previews, and in the question text, explanations, paths and chunk titles that `gotchea quiz` prints and that the MCP quiz tools put in their text (and elicitation prompts), are shown as visible placeholders, so they can't move the cursor or make code read differently than it runs. `structuredContent` keeps the stored text.
- `gotchea serve` has no quiz route; its API leak guard now also rejects a `code` key.
