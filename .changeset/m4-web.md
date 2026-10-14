---
"gotchea": minor
"gotchea-core": minor
"gotchea-mcp": patch
---

M4: `gotchea serve [path] [--port <n>] [--no-open]` serves a read-only treemap of the comprehension map on 127.0.0.1 (area = LOC, colour = state, drill-down, live refresh) with a JSON API (`/api/map`, `/api/status`). `gotchea status --json` is new. `gotchea-core` now owns the shared `MapJson` / `StatusJson` shapes (`copyMapNode`, `mapJsonFrom`, `statusJsonFrom`), which `map --json`, MCP `get_map` and the server all use.
