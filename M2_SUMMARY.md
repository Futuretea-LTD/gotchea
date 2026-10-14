# gotchea — M2 Summary (Question Generation)

M2 is ready for your review. **M3 has not been started** and will wait for your approval.
The design is in [M2_DESIGN.md](M2_DESIGN.md) (decisions D1–D8), and the scope is PLAN.md §9 "M2". Answer-key isolation follows PLAN §6.

## What was built

- **`gotchea-core` — `generate/`**
  - **`schema.ts`**:
    - `RawQuestionSchema`, the shape a host or LLM submits: 4 options, one `correctIndex`, an explanation that cites lines, 1–5 refs and a difficulty.
    - `StoredQuestionSchema`, the `QuestionPrivate` v2 shape.
    - The provider-facing `RAW_BATCH_JSON_SCHEMA`, which has no length bounds; zod enforces those after the call.
    - `LangCodeSchema` (`en`, `tr`, `pt-BR`, …).
  - **`chunk-code.ts`**:
    - Numbered chunk code, 1..N, with no gaps and an unnumbered `┆` between the ranges of `~top`/`~body` chunks.
    - `chunkLineCount`, and `toAbsoluteLine(chunk, ref)` for display time.
  - **`source.ts`**:
    - Working-tree reads through one per-call `SourceReader`.
    - `currentHash` re-chunks only the chunk's file.
    - Import signatures: only the imports the chunk references, capped at 20 entries and 4000 chars. External imports get an empty signature.
    - The enclosing declaration for methods.
  - **`tasks.ts`**:
    - Chunk selection, shared by the CLI and MCP. Grey leaves come first, then fan-in weight, deficit, LOC and id.
    - Filters: `minLoc` 5, the 800-line size guard, and the pool target `ceil(poolMultiplier × questionCount)`.
    - The type plan starts with the type least represented in the pool.
    - Tasks whose file changed since the last scan are skipped.
  - **`prompt.ts`**: `PROMPT_VERSION = 'p1'`, the static system rules (cacheable), the user prompt, the MCP host instructions and the blind-verify prompt.
  - **`text.ts` / `dedupe.ts` / `validate.ts`**: the pure 13-rule validator (thresholds below).
  - **`stamp.ts`**: the server stamps every identity and metadata field. The id is `q_` + sha256(chunkId, chunkHash, normalised stem)[0..12], so it is deterministic.
  - **`save.ts`**: the single write path for both the CLI and MCP (D6), in this order:
    1. Call-level gate.
    2. Validator.
    3. Optional blind verify.
    4. Stamp.
    5. Insert under the per-chunk lock.
  - **`verify.ts`** (CLI only, D7):
    - The options are permuted with a permutation seeded by the question id.
    - The verifier sees no key, explanation, refs or type.
    - A disagreement sets `flagged`. The question is saved for review but never counted or quizzed.
  - **`providers/`**:
    - `anthropic` uses the official SDK, loaded lazily. Its default model is **`claude-sonnet-5-5`**. It uses structured outputs (`output_config.format: json_schema`) with no `tool_choice`, no `temperature` and the server-side fallback beta.
    - `openai` and `openai-compatible` share a Chat Completions-over-`fetch` implementation. `openai-compatible` falls back once to `json_object` when a server rejects `json_schema`.
    - The transport is always injectable. `createProvider` reads only the `env` it is given.
  - **`generate.ts`**: `runGenerate`, the CLI orchestration. It runs chunks sequentially and retries once with the rejection reasons.
- **Store and map**
  - Question files are now **v2**: `status: 'ok' | 'stale'` plus a separate `flagged`, `chunkLines`, `promptVersion` and `verifiedBy`.
  - `FsQuestionStore.list` upgrades v1 files on read, and returns `[]` when `file.chunkId` doesn't match (fixes PLAN §10.55).
  - `QuestionStore.update()` is serialised by an in-process per-chunk lock.
  - The usable count is `ok && !flagged && chunkHash === chunk.contentHash`.
  - Config adds `questions.leakWordOverlap / leakMargin / lengthSkewMinChars / maxBatch / minLoc` and `generate.maxChunksPerRun`. `questions.lang` is now any language code.
- **CLI**: `gotchea generate` (no longer a stub). `map` prints `· N q` on leaves with usable questions.
- **MCP**: `get_generation_tasks` and `save_questions`, the host path, which needs no API key. `get_map` shows `· N soru` on leaves and `· Σ N soru` on parents.

### Refs are chunk-relative (resolves M1 open question #4)

- Refs and explanation citations use the coordinates of the numbered code shown to the generator: 1-based, with **line 1 = the chunk's first line**. The numbering runs across all of a chunk's ranges with no gaps.
- Each question stores the `chunkId`, `chunkHash` and `chunkLines` it was written against.
- **Same hash** on a rescan (unchanged, moved within or between files, renormalised): the refs stay valid **without any rewrite**. `applyScanDiff` has no ref logic at all.
- **Changed hash**: the questions go `stale` and are replaced by regeneration. They are **never rebased**.
- **Absolute lines are computed only at display time** with `toAbsoluteLine(chunk, ref)`, which walks the chunk's current `ranges`. For a single-range chunk that is `ranges[0].start + ref − 1`. Nothing in M2 displays refs yet. That is M3, and `toAbsoluteLine` is covered by tests, including a move test.
- This supersedes PLAN §3 `refs: LineRange[]` and the "M2 must rebase refs on move" note in PLAN §10.48.

### Validator thresholds (all in `config.questions`, PLAN §10.19)

Rules run in this order, and the first failure rejects the item:
`schema_invalid → type_not_allowed → options_not_distinct → meta_option → answer_leak_marker → answer_leak_stem → answer_leak_options → length_skew → refs_out_of_range → explanation_citation → trivia → duplicate_stored → duplicate_batch`.

| Rule | Threshold |
|---|---|
| Stem leak (a) | The normalised correct option (≥ 4 chars) is a substring of the stem, and no distractor is. |
| Stem leak (b) | The correct option shares **≥ 60 %** of its content words with the stem (`leakWordOverlap` 0.6) **and** beats the best distractor by **≥ 0.25** (`leakMargin`), so identifiers shared by every option don't count as a leak. |
| Options leak | (a) The correct option is a distractor (≥ 4 chars) plus a qualifier, or (b) the distractors are near-identical to each other (trigram J ≥ 0.8) and the correct option is the odd one out (J < 0.5). |
| Length skew | `r = len(correct) / mean(len(distractors))` is outside **[1/1.4, 1.4]** (`maxCorrectLengthRatio`, symmetric) **and** differs by **> 8 chars** (`lengthSkewMinChars`), so short code tokens like `lo`/`hi`/`NaN` pass. |
| Refs / citations | Every ref and every `L<n>` citation must lie in `1..chunkLineCount`, and the explanation must cite at least one line. |
| Dedupe | Character-trigram Jaccard of the stems **≥ 0.8** (`dedupeJaccard`), checked against stored ok + flagged questions at the current hash, then against items already accepted in the same batch. |
| Batch | At most 20 items per save call (`maxBatch`). |

Each table row is tested on both sides of its boundary, for example length r = 1.41 vs 1.39, a margin of exactly 0.25 vs 0.26, and J = 0.79 vs 0.8. `detail` strings follow fixed templates and never quote the stem or an option.

### Fixed during this review

I used two parallel review subagents (general-purpose): one for the providers, blind verify and CLI `generate`, and one for the MCP tools, the leak surface and the map. I checked core myself: the schema, validator, save gate, store migration and refs. I verified every finding before acting on it. Each fix is minimal and has a regression test (+5 tests, plus one new assertion).

**Answer-key and secret leaks:**
- **Corrupt question files leaked answer text.** V8's `JSON.parse` messages quote about 10 characters around the error, and `guarded()` sent that message to the MCP client. A merge-conflicted pool could therefore expose fragments of options or explanations through `get_generation_tasks`, `save_questions` or `scan`. `FsQuestionStore.list` now throws `Invalid JSON in <path>` with no excerpt.
- **The OpenAI and compatible providers quoted raw HTTP error bodies**, up to 300 chars, into the CLI output and `--json`. A gateway that echoes headers could expose the Bearer key. The key is now replaced with `[redacted]` before the body is truncated.
- **Network errors printed the base URL as written**, including any `user:token@` or `?api-key=` in it, and undici repeats that URL in its own message. Both now show only the origin and path.

**Correctness:**
- **The task gate missed hash-neutral shifts.** Adding a comment above a chunk (or inside it) without rescanning keeps `contentHash`, but the numbered code is read from the *scanned* ranges, so the generator saw lines that were off by a few. Refs and citations were then validated against the wrong code. `SourceReader.currentHash` now also requires the re-chunked ranges to equal chunks.json. Such chunks are skipped by `get_generation_tasks` and refused by `save_questions` as `chunk_changed_since_scan` ("run scan").
- **`get_map` with `depth` dropped the parent `Σ N soru` totals**, because they were summed over the cut tree. They are now summed over the full tree, which also removes an O(n²) re-walk.

**Hardening:**
- **Prompt injection:** the generation rules (rule 7) now say that the code, import signatures and existing stems are untrusted data. Instructions inside them are ignored, and they must never change the rules or trigger tool calls. The verify prompt has the same note. `PROMPT_VERSION` stays `p1` because no `p1` question has been committed yet. From now on, every wording change bumps it.
- **Refused `save_questions` results** are `isError`, and the MCP SDK skips output validation for those. They are now parsed with the strict output schema explicitly.
- **The MCP client name** (stored in `generatedBy` as `host:<name>`) is limited to printable ASCII and 64 chars.

## Checked and confirmed

- **§6 isolation:**
  - `gotchea-mcp` imports only `gotchea-core`. `StoredQuestionSchema`, `validateBatch` and the stores live behind `gotchea-core/internal`.
  - Tasks expose **stems of usable questions only**.
  - `save_questions` returns indices, ids, reason codes and fixed-template details. It never echoes a stem, option, key, explanation or refs, including the host's own submission.
  - The leak test (`packages/mcp/test/safety.test.ts`) walks every `structuredContent` and every tool `outputSchema` for the keys, and checks sentinel values (`SEED-OPT-`, `SUBMIT-OPT-`, `SUBMIT-EXPL`, `SEED-FLAGGED-STEM`) for both new tools, including the not-initialised and not-scanned states.
  - The CLI `generate --json` output is checked for the same keys.
- **Hash gate before any write:**
  - `save_questions` checks scan state, `unknown_chunk` (aliases resolve), `not_leaf`, `chunk_hash_mismatch`, `chunk_changed_since_scan`, `lang_invalid` and `batch_too_large` before it reads or writes the pool.
  - The mismatch message does not return the current hash.
  - A test asserts that the pool file is byte-identical after a refused call.
- **Migration v1 → v2:**
  - It is pure and runs on read.
  - `'flagged'` becomes `ok + flagged`. Absolute v1 refs become `[]`, which is safe because no v1 question was ever generated (PLAN §10.43).
  - `chunkLines = 0` and `promptVersion = 'p0'`.
  - The file is rewritten as v2 on the next save. Unknown versions throw.
- **Map:**
  - After a save, the leaf's `okQuestions` = n and its colour is **red (R = 0), no longer grey** (D8).
  - Flagged-only and stale-hash pools stay grey.
  - `questionCount` (the quiz size from the band) is unchanged by the pool size.
- **Providers:**
  - There are no hardcoded keys, and core never reads `process.env`.
  - A missing key gives CLI exit 2 with the MCP hint (`get_generation_tasks`/`save_questions`, no key needed).
  - `missing_model` is reported for OpenAI and compatible providers, which have no default model.

## How to try it

```bash
pnpm install
pnpm -r build && pnpm typecheck && pnpm lint && pnpm test
pnpm test:coverage

cd /path/to/some/repo
G="node <gotchea>/packages/cli/dist/index.js"
$G init && $G scan
$G generate --dry-run                       # selected chunks, counts and type plans; no provider call
ANTHROPIC_API_KEY=… $G generate             # up to generate.maxChunksPerRun (10) chunks, default model claude-sonnet-5-5
$G generate --chunk 'src/math.ts#clamp' --lang tr --verify
$G generate --provider openai --model <id>                # OPENAI_API_KEY (+ OPENAI_BASE_URL)
$G generate --provider openai-compatible --model llama3.1 # OPENAI_COMPAT_BASE_URL (default http://localhost:11434/v1), key optional
$G generate --json                          # { chunks: [{ chunkId, requested, saved, flagged, rejected: [{index, reason}] … }], totals }
$G map                                      # leaves with questions are red and show "· N q"
```

Exit codes: 0 when the run finished, even with rejections; 1 when every chunk errored; 2 for config or credential errors.

**MCP host path (no API key):** register `gotchea-mcp` (stdio) with your coding agent, then:
1. Call `get_generation_tasks { limit?: 1-10 (default 3), lang? }`. Each task has the numbered code, import signatures, existing stems, `count`, `typePlan`, `chunkHash` and full `instructions`.
2. Write the questions **in a subagent or a separate session**, because the answers stay in that context (PLAN §6).
3. Call `save_questions { chunkId, chunkHash, lang?, questions: [...] }`. The response has the `accepted` ids, the `rejected` items as `{index, reason, detail}`, and `usableQuestions/target`. Resubmit only the rejected items.
4. Call `get_map` to see the leaf turn from ⬜ to 🟥 `· N soru`, with `Σ N soru` on its parents.

## Test and coverage results (2026-10-14)

| Check | Result |
|---|---|
| `pnpm -r build` | ✅ exit 0 |
| `pnpm typecheck` | ✅ core, cli, mcp |
| `pnpm lint` (biome) | ✅ exit 0, 0 errors. There are 4 warnings, all in M1 code: 3× `useOptionalChain` in `parse/lang/typescript.ts`, and 1× a `${…}` inside a fixture source string in `mcp/test/helpers.ts`, which is intentional. |
| `pnpm test` | ✅ 55 files, **798 tests passed** (407 at the end of M1, 793 before this review, +5 regression tests) |
| `pnpm test:coverage` | ✅ All files: 95.08% statements, 88.05% branches, 95.96% functions, 97.22% lines. `score/**` stays at the enforced 100%. |

The M2 tests are:
- **Core:** `test/generate/` has validate (a two-sided table for every reason code), save (contract plus every gate), tasks, prompt, verify, run-generate and generate, and `providers/` has anthropic, openai-chat, factory and provider. `store/stores.test.ts` covers the v1→v2 upgrade, the chunkId mismatch, concurrent `update()` and the corrupt-pool error.
- **MCP:** `generation.test.ts`, `save-contract.test.ts` and the extended `safety.test.ts` leak test.
- **CLI:** `generate.test.ts` with an injected provider. It covers the selection order, `--chunk`, `--lang`, `--dry-run`, exit 2 with the MCP hint, the retry and the `--json` key check.

Weakest coverage: `cli/src/commands/generate.ts` (82% statements; some error-printing branches) and `generate/source.ts` (85%; the enclosing-declaration fallbacks).

## Known limitations

- **Refs:**
  - `toAbsoluteLine` exists but nothing displays refs until M3.
  - Some edits keep the hash but shift lines: a comment added *inside* a chunk, then a rescan. Refs of such a chunk can point a few lines off. `chunkLines` is stored so M3 can show `≈ L12` and clamp, but that is not built.
- **Corrupt pool files:** a pool with merge conflicts no longer leaks, but it still makes `get_generation_tasks` fail for the whole repo, because grey chunks are listed first. `save_questions` also fails for that chunk. Skipping and reporting such chunks would be friendlier.
- **Pools are not capped:** `save_questions` does not check pool-full, `minLoc` or the size guard, so repeated calls can grow a pool past its target.
- **Flagged stems:**
  - Flagged stems are hidden from `existingStems` but still count for dedupe. A host can therefore get `duplicate_stored` against a question it cannot see.
  - The `id` and `J` in that response let a client probe for flagged stems. This is documented behaviour.
- **Concurrency:** the lock is in-process only. The CLI `generate` and an MCP server saving to the same chunk at the same moment can lose one batch. The `.lock` from PLAN §10.23 is still deferred.
- **No schema validation on read:** v2 files are not validated against `StoredQuestionSchema`. A hand-edited question without `flagged` would count as usable.
- **Provider rough edges:**
  - Anthropic `APIError` messages include the response body, which is not redacted.
  - Timeouts are reported as "Could not reach …".
  - A 401/403 is retried once per chunk instead of aborting the run.
  - OpenAI's `finish_reason: content_filter` is reported as `invalid_json`.
  - `--chunk X` on a chunk that changed since the scan exits 0.
- **Prompt injection:** this is mitigated, not solved.
  - The code is shown with line-number prefixes, so a ``` inside it cannot close the fence at column 0.
  - The rules mark all repo content as untrusted.
  - The provider path has no tools and its output is schema-validated.
  - In host mode, though, the code goes to a coding agent that *has* tools. The real mitigation is the generating subagent with no tools or with read-only tools, which is to be documented in M5.
- **Design test files** `schema/text/dedupe/chunk-code/context.test.ts` were not created as separate files. Their cases live in `generate.test.ts`, `validate.test.ts`, `prompt.test.ts` and `save.test.ts`.

## Open design questions for M3

1. **Ref drift display:** when the current chunk line count differs from `q.chunkLines`, should refs be shown as approximate (`≈ L12`, clamped), hidden, or should the question be treated as stale?
2. **Colour of "ready but never quizzed":** D8 shows such leaves as red (R = 0), so a freshly generated repo turns from all grey to all red. Is a separate "ready" state (for example ⬜ with a dot) clearer?
3. **Flagged questions:** should there be a `review` command or tool to inspect and unflag them? Who may unflag: the user only, or a second verify?
4. **Verifier model:** should blind verify default to a *different* model than the generator (PLAN §10.21)? Today the same provider and model answers in a fresh request.
5. **Pool cap and gate:** should `save_questions` refuse once the pool is full (`pool_full`), or reject chunks below `minLoc`?
6. **Partial staleness:** now that refs are chunk-relative, should an edit that doesn't touch a question's refs keep it `ok` (M1 open question #6)? That would need a line mapping between the old and new chunk code.
7. **Cross-process lock:** the CLI and MCP now both write question files. Should the `.lock` from PLAN §10.23 come before M3 sessions add more writers?
8. **Mixed-language pools:** should a quiz use only questions in the user's `lang`, or fall back to other languages when there are too few (PLAN §10.26)?

## Dogfooding questions (answer these first; the key is at the bottom)

**Q1.** `src/math.ts#clamp` is a single-range leaf at file lines 10–20 with an `ok` question whose ref is `{start: 3, end: 4}`. You add a new 5-line function above `clamp` and run `gotchea scan`. Nothing inside `clamp` changes. What is stored, and which file lines does M3 highlight for that ref?

- A) The stored ref stays `3–4`, and M3 highlights lines 17–18.
- B) The scan rebases the stored ref to `8–9` so it keeps pointing at the same code, and M3 highlights lines 8–9.
- C) The chunk's lines moved, so the question is marked `stale` and must be regenerated.
- D) The stored ref stays `3–4`, and M3 highlights lines 12–13, because absolute lines were fixed when the question was generated.

**Q2.** A host calls `get_generation_tasks`, then you edit the body of the offered function and run `gotchea scan`. Only then does the host call `save_questions` with the task's `chunkId` and `chunkHash`. What happens?

- A) `chunk_changed_since_scan`: the working tree differs from the task, so the host must run `scan`.
- B) `chunk_hash_mismatch`: the whole call is refused, nothing is written, and the host must call `get_generation_tasks` again. The response does not include the new hash.
- C) The questions are saved but immediately marked `stale`, because their `chunkHash` is old.
- D) The questions are saved with the new hash, which the server stamps, because identity fields are never taken from the input.

**Q3.** A submitted question has three distractors of 10 normalised characters each and a correct option of 18. Nothing else is wrong with it. Does the validator accept it?

- A) No: `length_skew`, because 18 / 10 = 1.8 > 1.4.
- B) Yes: the ratio is above 1.4, but the correct option is only 8 chars longer than the mean, and the rule needs a gap of more than 8 chars.
- C) No: `answer_leak_options`, because the longest option is always treated as a leak.
- D) Yes: length skew only rejects correct options that are *shorter* than the distractors.

<details>
<summary>Answer key (open after answering)</summary>

**Q1: A.** Chunk ids contain no line numbers and the hash ignores position, so the scan reports `clamp` as unchanged and only updates its `ranges` to 15–25. Refs are chunk-relative and never rewritten. At display time `toAbsoluteLine` gives 15 + 3 − 1 = 17 through 15 + 4 − 1 = 18. B describes the rebasing that D1 rejected. C confuses a position change with a content change. D is the M1 behaviour (absolute refs) that caused the drift.

**Q2: B.** After the scan, chunks.json holds the new `contentHash`, so the submitted `chunkHash` no longer matches. The gate refuses the whole call before any read or write, and it does not leak the current hash, so stale questions can't simply be resubmitted. A is the case where the file is edited but *not* rescanned (chunks.json still matches the task, the working tree doesn't). C and D are wrong because refused calls persist nothing.

**Q3: B.** `r = 1.8` is outside [0.71, 1.4], but the rule also requires `|18 − 10| > lengthSkewMinChars (8)`. A gap of exactly 8 is not enough, so the item is accepted. The floor stops the rule from firing on short code-token options. A ignores the floor. C misstates the options-leak rule, which is about a distractor contained in the correct option, or the correct option being the odd one out among near-identical distractors. D is wrong because the bound is symmetric.

</details>
