---
"gotchea-core": patch
---

On Windows, the repository lock now treats `EPERM`/`EACCES` on a lock file that another process is deleting as contention and retries. Before, concurrent CLI and MCP processes could crash.
