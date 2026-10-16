# Engine changes for deterministic E2E time

## Audit

Core and MCP already accepted injected clocks (`Date` options or `() => Date`),
but had no environment-based application clock. Defaults used `new Date()` in
map loading, status, question stamping, quiz operations, session creation and
session scoring. MCP's `createToolContext()` and CLI's `processIo()` also created
their own wall-clock defaults. MCP handlers already passed their context clock
through to the engine; CLI commands likewise used their injected I/O clock.

`GOTCHEA_HOME` already existed for personal-state isolation; no engine changes
were needed for home-directory handling.

## Central application clock

`packages/core/src/now.ts` exports `now(env = process.env): Date`, also exposed
through the public `gotchea-core` entry point. With `GOTCHEA_NOW` absent it returns
the current wall time, preserving normal behavior. With the variable present it
returns a fresh Date for the supplied fixed instant on every call:

- Zoned ISO timestamps, e.g. `2030-01-01T00:00:00.000Z` or
  `2030-01-01T03:00:00+03:00` (seconds required, optional 1–3 fractional digits).
- ISO calendar dates, e.g. `2030-01-01` (UTC midnight).
- Signed integer epoch milliseconds, including `0`.

Surrounding whitespace is trimmed. Empty, unparseable, timezone-ambiguous or
out-of-Date-range values throw an error identifying `GOTCHEA_NOW`. The value is
read on each call rather than captured at import time. This is a fixed clock,
not an offset or an automatically advancing simulated clock.

## Call sites and precedence

The defaults in `map/load.ts`, `ops/status.ts`, `ops/quiz.ts`, `generate/save.ts`
and `quiz/session.ts` now use the central helper. Where operations accept an
environment, it is forwarded to the helper. Standalone `QuizSessions` uses the
process environment unless given its existing explicit clock callback.

MCP `createToolContext()` uses its supplied `env` for the default clock. CLI
`processIo()` delegates to the core helper using the process environment. All
existing explicit Date/callback injections retain priority over `GOTCHEA_NOW`.
Consequently map decay, due counts, question creation timestamps, session TTL,
answer timestamps and review history use the same application clock.

No code in `core/src/score/**` was modified. Scoring functions remain pure and
receive `now` from their callers. No output schema, question view, shuffle,
answer-key isolation rule, or persistence shape was changed.

## Operational time stays real

`store/repo-lock.ts` intentionally retains its real-time defaults for lock
acquisition timeouts, stale-file checks, heartbeat mtimes and diagnostics. Filesystem
mtimes and elapsed waiting must stay comparable to wall time: freezing these
could cause infinite waits or break a live process's lock. Existing lock-specific
test seams remain available. Date construction in scoring/date arithmetic also
stays unchanged because it converts injected timestamps rather than reading time.

## Tests and build

- `core/test/now.test.ts`: normal wall time, ISO/epoch parsing, malformed inputs,
  runtime environment changes, independent Date objects, session TTL and injected
  clock priority.
- `core/test/map/ops.test.ts`: environment-driven decay/due counts and explicit
  date priority using actual persisted progress.
- `mcp/test/clock.test.ts`: server-specific environment and explicit clock priority.
- `e2e/`: real child-process MCP harness smoke tests and restart support.

`pnpm build` regenerates the ignored `packages/*/dist/` outputs used by local
E2E tests. Published/version targets can use time travel only after the tested
release includes this change. Without an explicit `GOTCHEA_NOW`, application
behavior stays on wall time in tests and normal use alike.
