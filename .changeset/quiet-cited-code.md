---
"gotchea": patch
"gotchea-core": patch
"gotchea-mcp": patch
---

- **MCP answer feedback shows the cited code.** `submit_answer` reveals now carry an optional `excerpt` (`language`, `text`, `truncated?`) per reference: the cited lines, sanitized, up to 15 per reference and 30 per reveal. It is left out when previews are off, the file changed since the last `scan` or the reference is approximate, and it only appears after the answer was recorded. The text result wraps each reveal in `SHOW ANSWER FEEDBACK TO USER VERBATIM` markers, separate from the question markers, and the server sends its display rules as MCP `instructions`.
- Elicitation choice titles are `A) ` plus at most 24 characters of the option; the form message and the text flow carry every option in full. Continuation lines of options, correct answers and explanations are indented so a code fence inside them can't swallow the rest of the message.
- `excerpt` joins the forbidden answer-key keys for pre-answer values and the `serve` API guard.
