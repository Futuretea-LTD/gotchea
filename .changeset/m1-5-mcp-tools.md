---
"gotchea": minor
"gotchea-core": minor
"gotchea-mcp": minor
---

M1.5: the MCP server now has real tools (`scan`, `get_map`, `get_chunk_for_file`, `get_status`). The map tree moved into `gotchea-core` (`buildMapTree`, `filterTree`, `loadMapTree`, `okQuestionCounts`) together with shared `runScan` and `getStatus` operations. The question stores and the private question type moved off the public barrel to the internal `gotchea-core/internal` entry. The CLI gains a real `status` command and `scan --json`.
