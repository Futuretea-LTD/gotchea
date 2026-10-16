# Verification — 2026-10-16

Real MCP stdio tests ran against the built local CLI. This task changed only E2E
tests, reporting, and documentation; all pre-existing product changes were preserved.

| Check | Result |
| --- | --- |
| `pnpm build` | Passed |
| E2E suite | 27 passed, 2 failed, 1 skipped across 10 files |
| `pnpm typecheck` | Passed, including all E2E files |
| `pnpm lint` | Passed; 4 existing warnings outside E2E |
| `pnpm test` | 74 files passed, 7 failed; 1022 passed, 59 failed, 8 skipped |

All commands used `--config.verify-deps-before-run=false` to use installed
workspace dependencies without attempting registry synchronization. No compiler,
linter, test, or assertion was disabled.

The two E2E failures are Scenario E color discrepancies: small and large edits
both produced grey rather than requested yellow/red. At the time of this run the tests
kept the requested color assertions. Invalidation and regeneration checks passed before them.
See [FINDINGS.md](FINDINGS.md) for reproduction, evidence and the specification conflict.
Since resolved as spec = grey, by design; the tests now expect grey and pass (FINDINGS.md, Resolution).

Scenario D passed: first-pass S=3, green/yellow/red thresholds under restarted
`GOTCHEA_NOW`, two successive S×2.5 passes, and two below-threshold failures with
S=max(1,S×0.3). Scenario E whitespace/comment controls passed. All nine F cases
passed, including meaningful errors and server recovery.

Scenario G measured nearest-rank lookup p95 **19.299 ms** over 100 sequential MCP
round trips (<100 ms), and **223.236 ms** for a cold scan of 200 TypeScript files
(8,000 source lines). Scan duration is informational; no scan timing threshold
was imposed. These are shared-host measurements with concurrent E2E workers,
not isolated benchmark results. Full per-test results and annotations: `report.md`
(written locally by every `pnpm e2e` run; gitignored).

The root suite failures reproduce existing environment limits: repository lock
creation under the real user's `~/.gotchea/repos/` fails with EPERM, and HTTP tests
cannot bind `127.0.0.1:0` (listen EPERM). Failed setup also causes teardown errors.
Affected suites include core generate/save and run-generate, CLI generate/map/
e2e-fixtures, serve and serve-security. No fixes or suppression were applied.

Published/version targets were not exercised (registry access restricted). The
clock probe skips only unsupported registry time-travel verification and records
the reason. Local missing clock support remains a failure.

The Claude smoke is collected and skipped by default; it was not run with
`GOTCHEA_AGENT_SMOKE=1`, so no claim is made about actual generated question quality.
Its isolated authentication requirements and execution command are in README.md.

Three independent subagents authored/reviewed Scenario E, Scenario F and the
Claude smoke. The main tester implemented Scenario D, Scenario G, reporter
annotations, documentation, and ran the workspace/E2E verification.
