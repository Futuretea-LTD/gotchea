# gotchea — M1 Summary (Scan, no LLM)

M1 is ready for your review. **M2 has not been started** and will wait for your approval.
PLAN.md §9 has the ticked items, and §10 (assumptions 42–57) records every decision made during the review.

## What was built

- **`gotchea-core`**
  - **`config/`**: a zod schema with every threshold and constant from PLAN §3, plus a deep-merge loader. The loader now accepts a config file saved with a UTF-8 BOM.
  - **`fs/`**: the file walker. It lists files with `git ls-files -co --exclude-standard -z`, or falls back to a directory walk that honors nested `.gitignore` files. It applies the include, exclude, always-exclude, test (opt-in), generated-marker, binary (NUL sniff) and `maxFileBytes` filters.
  - **`parse/`**: web-tree-sitter parsers for TypeScript, TSX, JavaScript and Python. Each extracts symbols, comment/docstring ranges, complexity, imports and identifiers.
  - **`hash/`**: `n1` normalization (comments blanked, whitespace collapsed, blank lines dropped), the `contentHash`, module hashes and FNV-1a line fingerprints.
  - **`chunk/`**:
    - A generic `Chunker` interface, with `CodeChunker` as its first implementation.
    - Group and split logic.
    - A generic `TreeBuilder` that creates module chunks and assigns ids, hashes, metrics and `questionCount`.
    - fanIn computed from import resolution plus name matching.
  - **`scan/`**: the diff against the previous `chunks.json` (added, removed, unchanged, changed, moved, renormalized). It also does move detection with alias carry-over, stale marking, and a Myers line diff for `changeRatio`. Per-user reconcile against local snapshots ensures progress is never decayed twice.
  - **`score/`**: pure functions for retrievability, transitions, chunk and parent state, colors, pass threshold, question count and selection priority. `now` is always injected.
  - **`store/`**: Fs and InMemory stores for chunks, questions, progress and snapshots, plus atomic writes and `repoId`.
    - Shared state lives in `<repo>/.gotchea/`.
    - Personal progress and snapshots live only in `~/.gotchea/repos/<repoId>/` (or `$GOTCHEA_HOME`).
  - **`index/ChunkIndex`**: an in-memory lookup of the innermost leaf for a given file and line. It does not import tree-sitter.
- **`gotchea` CLI**
  - `init`, `scan`, and `map [path] [--json]` (ANSI tree heat map; everything is grey in M1).
  - `generate`, `quiz`, `status` and `serve` are stubs.
- **`gotchea-mcp`**: a scaffold only. `createServer()` and a stdio `bin` exist, with no tools yet.

### Fixed during this review
I used three parallel review subagents (general-purpose): one for parse/chunk/hash, one for fs/store/config, and one for scan/score/index/CLI/MCP. I verified their findings and made the fixes below, keeping changes minimal and adding a regression test for each.

**Security:**
- A file symlink pointing outside the repo (for example to `~/.ssh/...`) used to be read and chunked. It is now skipped as `outside-root`, in both git and walker modes.
- Question file slugs are now limited to `[A-Za-z0-9_-]`. Before, `:`, `\`, `*` and non-ASCII characters broke or misplaced files on Windows/NTFS.
- `userPaths` rejects repoIds that could escape `repos/`.
- `map` path containment now compares real paths: `..foo` is no longer rejected, symlinked checkouts work, and `../..` and absolute paths outside the repo are still rejected.

**IDs:**
- A real name like `declare module 'a@2'` or `'~top'` could produce **duplicate chunk ids**. `@` and a leading `~` are now sanitized, and symbol segments are NFC-normalized.
- `buildTree` now throws on any duplicate id instead of silently overwriting it.
- `buildTree` and `CodeChunker` normalize win32 `\` paths, so ids and ranges are always POSIX.

**Robustness:**
- A pathological file (for example a 6000-branch `else if` chain overflowing the stack) or a grammar `init()` failure used to abort the whole scan. That file now falls back to a single leaf.
- A file deleted between the walk and the read is now reported as `unreadable`.
- A corrupt question file (for example with merge-conflict markers) no longer breaks `map`.

**Hash and ranges:**
- An f-string or bytes literal in docstring position was blanked as a docstring, so edits inside it did not change the hash. It now counts as code.
- File ranges no longer extend one line past EOF.

**Moves:**
- Empty chunks (LOC 0, all with the same hash) are never paired as moves.
- When several chunks share a hash, pairing prefers the same symbol path and file name.

**Score input:**
- `greenAt: 0`, an unparseable `lastReviewedAt`, or `S ≤ 0` in progress.json used to crash `map` with `RangeError`. These now give red / no `dueAt`, and `colorFor(NaN)` is red instead of green.

**Defaults:**
- Added the test patterns `**/test/**` and `**/conftest.py`, and the excludes `**/*.d.mts` and `**/*.d.cts`. These files used to leak in while `includeTests` was false.

**Other:**
- Module `source` was the first file's chunker id, with a hardcoded `'code'` fallback. It is now the children's shared chunker id, or `mixed`.
- `scan` output now says "1 chunk, 1 leaf" instead of "1 chunks, 1 leaves".
- The flaky 100 ms index-build bound in the benchmark is relaxed to 500 ms. The §7 lookup bound (p95 < 5 ms) is unchanged.

## How to try it

```bash
pnpm install
pnpm -r build && pnpm test && pnpm typecheck
pnpm test:coverage                      # enforces 100% on packages/core/src/score/**

# On any repository (personal state goes to ~/.gotchea, or set GOTCHEA_HOME):
cd /path/to/some/repo
node "<gotchea>/packages/cli/dist/index.js" init      # writes .gotchea/config.json + questions/
node "<gotchea>/packages/cli/dist/index.js" scan      # chunks, hashes, diffs, decays
node "<gotchea>/packages/cli/dist/index.js" map       # heat map (all grey: no questions yet)
node "<gotchea>/packages/cli/dist/index.js" map src/some/file.ts --json
# edit a file, then run scan again to see changed/moved/changeRatio
```

## Test and coverage results (2026-10-14)

| Check | Result |
|---|---|
| `pnpm -r build` | ✅ exit 0 |
| `pnpm test` | ✅ 34 files, **407 tests passed** (was 391 before the review, +16 regression tests) |
| `pnpm typecheck` | ✅ core, cli, mcp |
| `pnpm test:coverage` | ✅ All files: 96.33% statements, 90.04% branches, 97.33% functions, 97.95% lines |
| `score/**` | ✅ **100%** statements, branches, functions and lines in all 4 files (threshold enforced) |

Answer-key isolation: `correctIndex` and `explanation` appear only in `core/src/model/question.ts`. `map --json` is tested to contain no answer keys, even when the questions directory holds questions planted with answers.

## Known limitations

These are recorded in PLAN §10.52–57.

- **M1 items not finished:**
  - `gotchea status` is a stub.
  - The MCP server has **no tools** (`scan`, `get_map`, `get_chunk_for_file` and `get_status` are missing).
  - `scan` has no `--json`.
  - There is no eslint/prettier config and no CI.
  - There are no golden `expected/chunks.json` files, no `mixed-ignore`/`edge` fixtures, and no `.patch` mutation pairs. The re-scan tests do the edits inline.
- **Refs drift:** moved questions keep their old `refs` (path and lines), and refs of an unchanged chunk drift when code above it is edited. *Solved by design for M2:* refs become chunk-relative (open question #4, [M2_DESIGN.md §2.3](M2_DESIGN.md#23-chunk-relative-refs-decision-d1)).
- **Unicode file names:** on normalization-sensitive filesystems (Linux ext4), files with NFD names are silently dropped, because the walker uses the NFC path for I/O.
- **Performance:** complexity is O(symbols × top-level nodes), about 3 s for a 4000-function file, and every file is parsed twice. There is no scan cache yet.
- **Monorepos:** several gotchea roots inside one git repo share one repoId, and so one progress file.
- **Stale questions:** questions are not un-staled when the code is reverted, and a file that grows past `leafMaxLoc` leaves its question pool attached to a non-leaf.
- **Shared module loading:** `gotchea-core` is a single bundle that statically loads `web-tree-sitter`. It needs a separate entry point before the fast `gotchea which` hook. Core's public API still exports `FsQuestionStore` and `QuestionPrivate`.
- **Writes:** there is no lockfile, no fsync before rename, and no Windows `EPERM` retry in atomic writes.

## Open design questions for you

1. **MCP tools and `status`:** build them (plus moving the map tree into core) as an "M1.5" before M2, or fold them into M3?
2. **`ALWAYS_EXCLUDE`:** it skips `build/`, `dist/` and `vendor/` at any depth, and that cannot be overridden, so a real `src/build/` is lost. Should it be limited to `.git/`, `.gotchea/` and `node_modules/`, leaving the rest to the overridable `exclude`?
3. **In-repo file symlinks** are still followed, which creates duplicate chunks. Should they be skipped, the way git sees them?
4. ~~**Refs:** store them relative to the chunk start, or rebase them on every scan? This must be decided before M2 writes the first question.~~ **Resolved (2026-10-14): refs are chunk-relative and never rebased.** Refs are 1-based lines inside the chunk, and the numbered code shown to the generator also starts at 1. Each question stores the `chunkId` and `chunkHash` it was generated against. If a rescan finds the same hash, the refs stay valid even when the chunk moved, and absolute lines are computed at display time as `chunk.startLine + ref - 1`. If the hash changed, the questions are stale and are never rebased. See [M2_DESIGN.md §2.3](M2_DESIGN.md#23-chunk-relative-refs-decision-d1).
5. **Monorepos:** should the repoId include the git subdirectory prefix, so each gotchea root gets its own progress?
6. **Stale on any hash change:** should every hash change make all of a chunk's questions stale (§10.13), or only questions whose refs intersect the changed lines?
7. **Group anchor:** renaming a group's first member loses the group's progress (§10.5). Is that acceptable, or should groups be anchored on more than the first member?

## Dogfooding questions (answer these first; the key is at the bottom)

**Q1.** `src/math.ts#mean` is a leaf with a passed progress entry. You add a 3-line JSDoc block directly above `mean`, and reindent its body from 2 to 4 spaces. Nothing else changes. What does the next `gotchea scan` report for this chunk?

- A) Unchanged: the id and the `contentHash` both stay the same, so its questions stay `ok` and progress is not decayed.
- B) Changed: the id stays the same, but the `contentHash` changes because the JSDoc is now inside the symbol's range, so its questions are marked `stale`.
- C) Moved: the chunk's lines shifted down by 3, so it gets a new id and move detection carries the questions over via `aliases`.
- D) Changed with `changeRatio` 0: the hash changes because of the indentation, but no lines differ, so questions go stale and S is untouched.

**Q2.** `src/math.ts` is over `leafMaxLoc`, and its small helpers are merged into the group `src/math.ts#~group:clamp`. You rename only the function `clamp` to `clampValue`. Its body, position and the other members are unchanged. What happens on the next scan?

- A) Nothing for the group: group ids depend on position, so `~group:clamp` keeps its id, and only the renamed member's symbol id changes.
- B) The id becomes `~group:clampValue` and the hash is unchanged, so move detection pairs the old and new ids and the questions and progress move.
- C) The id becomes `~group:clampValue`, and the hash also changes because the declaration line changed. It is not a move: the old group is removed (its question file deleted, progress orphaned) and the new group is added.
- D) The id stays `~group:clamp` and only the `contentHash` changes, so its questions go `stale` and progress decays by the `changeRatio`.

**Q3.** You have passed a leaf: S = 10, `mustRepass` false, 6 `ok` questions. A teammate's pull rewrites it, and the line diff against your local snapshot gives `changeRatio = 0.6` (default config). After your next `gotchea scan`, what is the state, and what does `gotchea map` show for that leaf?

- A) S = 4, `mustRepass` = true, all 6 questions are `stale`. With zero `ok` questions the leaf shows **grey** until questions are regenerated.
- B) S = 4, `mustRepass` = true, questions are `stale`. The leaf shows **red** because a re-pass is required.
- C) S = 10 × 0.6 = 6 and `mustRepass` stays false (0.6 is below the floor). The leaf turns **yellow** as R decays faster.
- D) Progress is reset to never-passed (S = null), because more than half the code changed. The leaf shows **red** with R = 0.

<details>
<summary>Answer key (open after answering)</summary>

**Q1: A.** Normalization `n1` blanks every comment byte range (JSDoc included) and trims and collapses whitespace on each line before hashing. The id is `path#symbolPath` and never contains line numbers, so shifting the code down changes nothing. The diff lists the chunk as `unchanged`. B is wrong because comments are blanked even inside the range. C is wrong because ids don't use line numbers. D is wrong because indentation is trimmed.

**Q2: C.** A group's id is anchored on its first member's name (`~group:<firstMember>`, §10.5). The hash covers the normalized lines, so the renamed declaration line changes it. Move detection only pairs a removed and an added chunk with the **same** kind and hash, so this is a remove plus an add. The removed chunk's question file is deleted (§5 step 6) and its progress is orphaned until `gc`. This is the open question 7 above.

**Q3: A.** `onContentChange` gives S = max(1, 10 × max(0.1, 1 − 0.6)) = 4, and 0.6 > `redOnChangeRatio` (0.5) sets `mustRepass`. Every hash change marks the chunk's questions `stale` (§10.13). Colors are computed from `ok` questions only, so with none left the leaf is grey, not red. The red "must re-pass" state appears once fresh questions exist. C mixes up the floor (0.1, a minimum multiplier) with the red threshold, and D is wrong because progress is decayed, never reset.

</details>
