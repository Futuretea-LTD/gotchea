---
"gotchea": patch
"gotchea-core": patch
"gotchea-mcp": patch
---

- **git ignore rules are honoured in full.** Paths now go to `git check-ignore` on stdin (current git rejects `-z` without `--stdin`, so the check always fell back to the root `.gitignore`). Nested `.gitignore` files, `.git/info/exclude` and the global `core.excludesFile` are now respected when `gotchea init` checks that `.gotchea/` can be committed. If git fails for any reason other than "not a repository", a warning is printed before falling back to the root ignore files.
- **MCP text follows `questions.lang`.** `get_map` text is English by default, and Turkish when `questions.lang` is `tr` (or `tr-TR`).
- An unknown provider now throws a configuration `ProviderError` (`unknown_provider`) that lists the valid provider names.
- `GOTCHEA_NOW` (ISO date or epoch milliseconds) pins application time for reproducible runs across the CLI and MCP.
- README: install instructions and a table of environment variables.
- CI: tests also run on Node 24.
