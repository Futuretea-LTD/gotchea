# E2E findings — 2026-10-16

Target: built local CLI, Node v26.9.0, darwin/arm64. Product code was not modified.

## E-01: small code edit yields grey rather than requested yellow

Status: **resolved: spec = grey, by design.** See [Resolution](#resolution-e-01-e-02).

Reproduce with `test/code-changes.test.ts`, small-edit case: scan the fixture,
save deterministic questions, pass the `src/math.ts` quiz (green), change only
`RangeError('Inverted range')` to `RangeError('Minimum exceeds maximum')`, then scan.

Expected by Scenario E: yellow. Observed: grey. The hash changes and the generation
task exposes zero existing usable stems and requests replacement questions.
The test fails explicitly on the requested color.

## E-02: major function rewrite yields grey rather than requested red

Status: **resolved: spec = grey, by design.** See [Resolution](#resolution-e-01-e-02).

Reproduce with the same test file, major-edit case: start green, replace the
`clamp` implementation, including more than half its lines, and scan. The larger
replacement also exceeds half of the file leaf's original normalized lines.

Expected by Scenario E: red, with old questions stale. Observed: grey. Invalidation
is verified through MCP: the new generation task has a different hash, no existing
usable stems, and the status usable-question count drops by the old pool size.
The test fails explicitly on color after those assertions pass.

## Shared cause / specification conflict

`packages/core/src/scan/reconcile.ts` (`applyScanDiff`) makes old-hash questions stale;
`packages/core/src/score/state.ts` (`chunkState`) prioritizes zero usable questions
and returns grey. This agrees with PLAN's grey-if-no-ok-questions rule but conflicts
with the requested Scenario E colors. In addition, small-change stability decay
alone does not guarantee immediate yellow: with zero elapsed time R remains 1.
A product/specification decision is needed. No expectations were weakened, skipped,
or marked as expected failures, and no product changes were made.

## Resolution (E-01, E-02)

Resolved: spec = grey, by design. The product behavior matches PLAN, so the tests
were changed, not the product. PLAN §3 (Colors): "grey if there are no `ok` questions".
PLAN §5 step 5 and §10 decision 13 mark every question of a modified chunk stale on
any hash change, so after either edit the chunk has zero `ok` questions.
`packages/core/src/scan/reconcile.ts` (`applyScanDiff`) does the stale marking and
`packages/core/src/score/state.ts` (`chunkState`) returns grey for zero usable questions
before it considers R or `mustRepass`.

`test/code-changes.test.ts` now expects grey in both cases, under the names
`small edit invalidates questions and turns grey` and
`large edit invalidates questions and turns grey`. Every invalidation assertion is kept:
the chunk hash changes, the regeneration task has no existing stems, and (large edit)
the status usable-question count drops by the old pool size.

## Future: stale signal for changed chunks (v0.2 candidate)

Not implemented now. Grey currently covers both "never had questions" and "had
questions, then the code changed". A separate `stale` signal (state, mark or color)
for chunks that were known before and changed later would let the map show lost
comprehension instead of blank coverage. This needs a PLAN decision and a change to
`chunkState` and the map JSON shape, so it is out of scope for the E2E suite.

## Execution limits

The published/version targets were not run because registry access is restricted.
Time-travel tests detect unsupported registry clocks and record an explicit skipped
case rather than assume that `GOTCHEA_NOW` works. The real Claude smoke was collected
and skipped by default; no paid generation was executed.
