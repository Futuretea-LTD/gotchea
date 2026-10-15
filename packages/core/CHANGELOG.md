# gotchea-core

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
