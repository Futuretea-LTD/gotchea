# gotchea — M3 Summary (Quiz and Score)

M3 is ready for your review. **M4 has not been started** and will wait for your approval.
The design is in [M3_DESIGN.md](M3_DESIGN.md) (decisions D1–D11), and the scope is PLAN.md §9 "M3". Answer-key isolation follows PLAN §6, and the lock follows PLAN §10.23.

## What was built

- **One engine, two front-ends (D1).** `core/ops/quiz.ts` (`startQuiz`, `submitAnswer`, `abandonQuiz`) is the only code that selects, grades and scores. The MCP tools and `gotchea quiz` only render its results.
- **`gotchea-core` — `quiz/`**
  - **`select.ts`** (pure, no I/O, never receives the key):
    - `selectChunk` ranks the leaves under a target with the existing `selectionPriority`. A `mustRepass` leaf counts as R = 0, and the tiebreak is fan-in, then lowest R, then id.
    - `selectQuestions` takes the preferred language first, then questions not asked in the last `excludeRecentSessions` sessions, then the longest-ago asked. It balances question types and shuffles the order.
    - `sessionSize` clamps `count` to `[min(minQuestions, questionCount), questionCount]`.
  - **`session.ts`**:
    - A strict `SessionSchema`.
    - `QuizSessions` (create, get with lazy expiry, `recordAnswer`, `markCompleted`, `expire`, `abandon`, `sweep`, `recover`).
    - `scoreSession`, which scores under the repo lock and is idempotent on the session id.
    - A session file holds the question ids, one permutation per question and `{displayIndex, correct}` per answer. It never holds a stem, an option, the key or an explanation.
  - **`rng.ts`**: `Rng`, `cryptoRng` (`crypto.randomInt`, unbiased), `seededRng` (mulberry32, tests only), Fisher–Yates `makePermutation` and `shuffle`.
  - **`views.ts`**: strict `PublicQuestionViewSchema` and `RevealViewSchema`, `toPublicView` / `toPrivateView` / `toRevealView`, `assertPublicView` (strict parse plus a deep scan for `FORBIDDEN_KEYS`). Refs are shown as absolute lines at display time, split across ranges and marked `≈` when the chunk's line count no longer matches `chunkLines` (D9, resolves M2 open question 1).
- **`ops/`**: `quiz.ts` (above) and `reconcile.ts` (`ensureReconciled`, D10). Reconcile on read costs one JSON read when nothing changed. Otherwise it takes the repo lock and decays progress for leaves whose `lastSeenHash` is behind `chunks.json`, as after a `git pull`. Leaves whose working tree differs from `chunks.json` are **deferred** to the next scan.
- **`store/`**:
  - `repo-lock.ts`, the lockfile (details below).
  - `keyed-lock.ts`, extracted from the question store.
  - `session-store.ts`: `FsSessionStore` (atomic writes, `purgeBroken`) and `InMemorySessionStore`.
- **`map/`**: `palette.ts` (the one presentation table, `HEAT`), `mini-heatmap.ts` (`buildMiniHeatmap`, `renderMiniHeatmapText` in `emoji`/`ansi`/`plain` modes).
- **Wiring**: `scanRepo` runs steps 4–6 under the lock. `saveQuestions` re-checks the hash gate and inserts under the lock. `loadMapTree` and `getStatus` call `ensureReconciled`. `selectionPriority` and `generate/tasks.ts` share `fanInFactor`.
- **MCP**: `start_quiz`, `submit_answer`, and an optional elicitation path. `get_map` and `get_status` now take their emojis from `HEAT`.
- **CLI**: `gotchea quiz [target] [--count] [--lang] [--new]`, driven by an injectable `AnswerSource`.
- **Config** (`quiz`): `minQuestions` 3, `sessionTtlMinutes` 120 (idle, refreshed on every answer), `sessionRetentionDays` 7.

## File map

```
packages/core/src/
├─ quiz/        select.ts  session.ts  rng.ts  views.ts
├─ ops/         quiz.ts  reconcile.ts
├─ store/       repo-lock.ts  keyed-lock.ts  session-store.ts   (+ SessionStore in types.ts, lockBreak in paths.ts)
├─ map/         palette.ts  mini-heatmap.ts
├─ scan/scan.ts, generate/save.ts, generate/source.ts, map/load.ts, ops/status.ts, score/state.ts   (modified)
packages/mcp/src/
├─ tools/       start_quiz.ts  submit_answer.ts  quiz-text.ts  elicit.ts   (+ get_map.ts, get_status.ts)
├─ schemas.ts, context.ts, server.ts                                         (modified)
packages/cli/src/
├─ commands/quiz.ts   quiz/{answer-source,scripted-source,clack-source}.ts   render/quiz.ts   target.ts
├─ render/tree-heatmap.ts (paintFor → HEAT), program.ts, commands/map.ts      (modified)
tests: core/test/{quiz,ops/reconcile,store/repo-lock,workers}  mcp/test/quiz*.test.ts  cli/test/quiz*.test.ts
```

## MCP tool contracts

Both descriptions contain **"Ask the question to the user, do not guess the answer yourself."** and the multiple-choice UI hint ("If your client can show a multiple-choice or selection UI, present the options as choices there; otherwise list them as A–D…"). Both come from the constants `ASK_USER` and `CHOICE_UI` in `quiz-text.ts`, and a test checks them. All outputs are strict zod schemas. Refusals are `isError` results that are re-parsed with the strict schema, because the SDK skips output validation on `isError`.

**`start_quiz`**
- Input: `{ path?, chunkId?, count? (1–10), lang? }`. `path` and `chunkId` together are refused as `both_targets`.
- Output: `{ initialized, scanned, status: started | resumed | completed | cancelled | refused | null, reason, session: { id, chunkId, chunkTitle, path, total, answered, needed, expiresAt } | null, question: PublicQuestionView | null, result | null }`.
- Refusal reasons: `both_targets`, `unknown_chunk`, `not_leaf`, `no_match`, `no_quizzable_chunk`, `not_enough_questions`, `lang_invalid`.
- `completed` and `cancelled` occur only on the elicitation path.
- Resume-or-create: an active session of the same origin in scope with ≥ 1 answer is resumed (`count` and `lang` are ignored). An untouched one is abandoned and replaced.
- `PublicQuestionView = { questionId, position, total, stem, options: [{ index, label, text } ×4] }`. It has no type, difficulty, language, refs, explanation or key.

**`submit_answer`**
- Input: `{ sessionId (/^qs_[0-9a-f]{16}$/), questionId, displayIndex (0–3) }`.
- Output: `{ initialized, scanned, status: answered | completed | refused | null, reason, repeat, sessionId, reveal | null, progress: { answered, total, correct } | null, next | null, result | null }`.
- `reveal` is `{ questionId, correct, selectedDisplayIndex, correctDisplayIndex, correctText, explanation, refs: [{ path, startLine, endLine, approximate }] }`. It is the only place those fields may appear.
- `result` is `{ passed, correct, total, needed, chunk, before/after: { color, R, dueAt }, stabilityDays, heatmap }`.
- Refusal reasons: `unknown_session`, `session_expired`, `session_completed`, `chunk_changed`, `unknown_question`, `out_of_order`, `already_answered`, `invalid_index`, `question_unavailable`. Refusal texts are fixed templates.
- Answers are final and sequential. An identical resend is idempotent (`repeat: true`). A different index for an answered question is `already_answered`.

## CLI usage

```bash
gotchea quiz                      # the chunk that most needs review in the whole repo
gotchea quiz src/math.ts          # best chunk under a path (relative to the working directory)
gotchea quiz 'src/math.ts#clamp'  # one leaf (chunk id or alias); falls back to path if it is a container
gotchea quiz --count 3 --lang tr --new
```

- Needs a TTY (`ClackAnswerSource`, `@clack/prompts`). Without one it exits 2 with `quiz needs an interactive terminal.`, unless an `AnswerSource` is injected.
- An unfinished CLI session is offered for resume (`confirm`). `--new` abandons it instead. Ctrl-C quits: the session is abandoned and nothing is scored.
- When there are too few questions the command offers "Generate now?", runs `generate --chunk` and retries once.
- After the last answer it prints the verdict, the colour change `before → after` with R, the next-due date and the mini heatmap. With colours off, the heatmap shows `[R 0%]`-style letters, so state never depends on colour alone.
- Exit codes: 0 finished or quit, 1 refused (nothing to quiz, lock timeout), 2 usage or config. There is no `--json`.

## Lockfile behavior (`store/repo-lock.ts`)

- **Path and holder:** `~/.gotchea/repos/<id>/.lock`, created with `open(…, 'wx')`. It holds `{ pid, host, token, startedAt, cmd }`. A heartbeat touches the file every 5 s on an `unref()`ed timer.
- **Scope:** `withRepoLock(repoId, fn, opts)` is re-entrant per async context (`AsyncLocalStorage`), so a nested call for the same repo runs directly and cannot deadlock. A per-process `KeyedLock` queues callers first, so only one caller per process polls the file.
- **Stale rules:**
  - The holder is on this host and its pid is dead.
  - The mtime is older than 30 s.
  - The file is empty or unparseable and older than 5 s.
- **Breaking:** serialised by a second `O_EXCL` file `.lock.break` (stale after 10 s). The staleness is re-checked on the current contents before the `unlink`.
- **Release:** in `finally`, and only if the token is still ours. A synchronous `exit` hook removes any lock still held. SIGKILL falls back to staleness.
- **Timeout:** `LockTimeoutError` after 30 s (`GOTCHEA_LOCK_TIMEOUT_MS` overrides). The message names the holder pid and command and the lock path.
- **Coverage of writers:**
  - `scanRepo` (non-dry-run, steps 4–6, so the reconcile inside a scan is under the lock).
  - `saveQuestions` (hash re-check plus insert).
  - `ensureReconciled`.
  - `scoreSession`.
  - Session files are private per session, written atomically, and not locked.
  - Parsing, walking and blind-verify calls run outside the lock.

## Elicitation evaluation result

- **Supported:** yes, in `@modelcontextprotocol/sdk` 1.32.1. `server.server.elicitInput({ mode: 'form', message, requestedSchema }, { timeout })` takes a flat schema, and a single-choice field is a string with `oneOf: [{ const, title }]`.
- **Detection:** per call, not at registration, because capabilities are known only after the handshake. `clientCanElicit` is `server.server.getClientCapabilities()?.elicitation?.form !== undefined`. The SDK normalises an empty `elicitation: {}` to `{ form: {} }`.
- **Flow:** `start_quiz` creates or resumes the session, then loops over the questions. Each question is an `elicitInput` with the previous reveal in the message and the options as a titled enum. The timeout is 10 min instead of the SDK's 60 s. `accept` calls `submitAnswer`. `decline` or `cancel` abandons the session and returns `Quiz cancelled. Nothing was scored.` After the last answer it returns one result with all reveals and the completed text. The model never sees a question before it is answered.
- **Fallback:** if the capability is missing, `elicitInput` throws (method not found, timeout, transport) or the answer is unparseable, `start_quiz` returns the plain two-tool result for the next unanswered question. Reveals already collected are prepended and `status` becomes `resumed`. This works because sessions are server-side. `elicitation: 'off'` or `GOTCHEA_MCP_ELICIT=off` never elicits. Tests cover the full flow, decline, fallback and `off`, with an in-memory client.
- **Deviation from the design:** M3_DESIGN D8 said the default would be `off`. The implementation defaults to **`auto`** (capability-gated). I did not change it, and I did **not** verify it against any real client (Claude Code, Codex, Claude Desktop, Cursor). See the limitations and M4 follow-ups.

## Test and coverage results (2026-10-14)

| Check | Result |
|---|---|
| `pnpm biome check` | ✅ 0 errors, 4 warnings, all in M1 code or a deliberate fixture string (the same 4 as at the end of M2) |
| `pnpm typecheck` | ✅ core, cli, mcp |
| `pnpm test` | ✅ 67 files, **886 tests passed** (798 at the end of M2; +88, of which +3 are the regression tests added in this review) |
| `pnpm test:coverage` | 93.15% statements, 84.83% branches, 94.75% functions, 95.48% lines, measured before the reconcile test was added. `score/**` stays at the enforced 100%. |

Coverage of the M3 files (statements / branches), same run: `select.ts` 95 / 79, `session.ts` 94 / 82, `views.ts` 100 / 94, `repo-lock.ts` 81 / 73, `session-store.ts` 90 / 85, `ops/quiz.ts` 88 / 79, `start_quiz.ts` 79 / 75, `submit_answer.ts` 89 / 70, `reconcile.ts` was 34 % before this review's test. The weakest spots are the `repo-lock.ts` stale and break branches (lines 214–215, 251–252 and others), the elicitation refusal branch of `start_quiz.ts`, and `mini-heatmap.ts` truncation.

**Tests added by M3 (core):**
- `quiz/quiz.test.ts`: selection, permutation uniformity and RNG injection, views and the reveal ref mapping, session rules, scoring.
- `quiz/lock-concurrency.test.ts` and `store/repo-lock.test.ts`: child-process mutual exclusion with a no-lock control run, stale handling, re-entrancy, release on throw.
- `ops/reconcile.test.ts`: new in this review.

**MCP:**
- `quiz.test.ts`.
- `quiz-e2e.test.ts`: red → green, the failing variant, decay by clock, pull simulation.
- `quiz-noleak.test.ts`: sentinel and key scan over every pre-submit output, tool descriptions and schemas.
- `quiz-uniformity.test.ts`: χ² over 4000 sessions for adversarial key distributions.
- `quiz-recovery.test.ts`: restart mid-session, crash between scoring and completion, corrupt and tmp files, expiry, `chunk_changed`.
- `quiz-concurrency.test.ts`.

**CLI:** `quiz.test.ts` and `quiz-heatmap.test.ts`, with a `ScriptedAnswerSource` that probes stdout for explanation and refs at every `ask()`.

One flaky test seen: `mcp/test/stdio.test.ts` ("round trip < 100 ms", built `dist/bin.js`) failed once under the coverage run at 274 ms, and passed in the other runs (the plain `pnpm test` runs included). It is an M1 latency assertion that is sensitive to machine load. It is unrelated to this review's edits.

## Review findings

I reviewed the whole M3 surface myself and used **no subagents**: the code is a handful of tightly coupled files, so splitting it would have cost more context than it saved. Every finding below was checked against the code before I acted on it.

### Checked and found sound

1. **Answer leakage.**
   - Pre-submit values (`start_quiz`, `next`, every refusal) are built only from `toPublicView`, which takes `Pick<…, 'id'|'stem'|'options'>`. They run through `assertPublicView` (strict schema and deep key scan), and the SDK validates `structuredContent` again.
   - Refusal texts are fixed templates. They echo only the client's own `sessionId`, `chunkId` or `path`. `QuizSelectError` details contain ids and counts only.
   - `guarded()` passes a message through only for unexpected errors. Corrupt pool files already throw without an excerpt (M2 fix), and a `ZodError` from `assertPublicView` names keys, not values.
   - There are no `console` or stderr writes in quiz, ops, store or MCP code.
   - Out-of-order and `already_answered` refusals happen before grading, so a wrong index can't be used to probe a question.
   - The session file is strict, so no stem, option, key or explanation can be persisted in it. After an answer it records `correct` for that question only.
   - Elicitation: the reveal text goes to the client UI only after that answer was recorded. The model receives reveals only in the final result.
2. **Session integrity.**
   - `SESSION_ID` is checked in `QuizSessions.get` and again in `FsSessionStore.pathFor`/`get`, before any path is built. `../x`, uppercase and wrong lengths yield `null` or throw, never a read.
   - `questionId` is checked with `includes`, so prototype keys like `constructor` are refused as `unknown_question`.
   - `displayIndex` is validated three times (tool schema, `submitAnswer`, `recordAnswer`).
   - A double submission is idempotent when identical and refused when different.
   - Completed sessions give `session_completed`, expired ones `session_expired` (lazy and by sweep), and a chunk change gives `chunk_changed` and scores nothing.
   - Writes to one session are serialised in-process, and the last answer scores idempotently by session id, so S is never multiplied twice.
3. **Permutation and RNG.**
   - The permutation is an unbiased Fisher–Yates over `crypto.randomInt`, drawn independently of the key and per question. Correct display slots are therefore uniform for any key distribution.
   - `seededRng` is never the default.
   - The tie-break key in `selectQuestions` uses `int(1 << 30)`, which is fine for `randomInt`.
4. **Colours.**
   - Every colour comes from `colorFor` via `chunkState` / `parentState` at the injected `now`, and none is stored. `greenAt` / `yellowAt` are applied only in `score/state.ts`.
   - `HEAT` is the only emoji and ANSI table, and the CLI's picocolors names (`gray` 90, `red` 31, `yellow` 33, `green` 32) match it.
   - The result's `after` and the mini heatmap use the same state calls as `get_map`.
5. **Tool descriptions:** both contain the "Ask the question to the user, do not guess the answer yourself." instruction and the multiple-choice UI hint.
6. **Style:** `pnpm biome check` is clean apart from the 4 pre-existing warnings. Code and comments follow the existing density and idiom.

### Defects fixed

1. **Busy loop in lock breaking (`store/repo-lock.ts`).** When a lock was stale but another waiter held `.lock.break`, `acquire` looped back to `tryCreate`/`readHolder` with no sleep and without checking the timeout. It spun on the filesystem for up to the break file's 10 s staleness. `breakStale` now reports whether it did the breaking. If not, the waiter backs off with a short jittered sleep and the timeout is honoured.
2. **Reconcile used a stale chunk list under the lock (`ops/reconcile.ts`).** `chunks.json` was read before `withRepoLock`, so a scan that ran while the call waited was not seen. The leaf list is now re-read inside the lock. The `currentHash` gate already made this unlikely to corrupt anything, but the lock is only useful if its inputs are fresh.
3. **Hard-coded emojis in `get_status` (`mcp/src/tools/get_status.ts`).** The text had its own `⬜🟥🟨🟩` literals, a second colour table next to `HEAT`. It now uses `HEAT[c].emoji`.
4. **No regression test for reconcile on read** (the module was at 34% coverage). Added `core/test/ops/reconcile.test.ts`:
   - a no-op when progress matches;
   - a pulled change decays S once and a second call changes nothing;
   - a leaf whose working tree differs from `chunks.json` is deferred and left untouched.

### Left open

1. **Elicitation defaults to `auto`, not `off` as D8 specified.** It is capability-gated, falls back cleanly and is tested with an in-memory client. But it makes `start_quiz` a long-running call, and I have not verified any real client. Decide before release: keep `auto` and test on Claude Code and Codex, or flip the default to `off` (a one-line change in `mcp/src/context.ts`).
2. **Scoring a deferred leaf drops its decay.** If a leaf was deferred by `ensureReconciled` (the working tree differs from `chunks.json`), `onSessionResult` overwrites `lastSeenHash` with the session's hash. The pending content-change decay is then lost. It needs an uncommitted edit plus a pulled `chunks.json` for the same leaf, so it is rare, and the fix needs a decision: refuse to quiz deferred leaves, or reconcile at scoring time.
3. **A failed chunk contributes R = 1 to its parents.** After a failed session `lastReviewedAt` is now, so `chunkState` returns R ≈ 1 (shown as `R 100%`) while the leaf is red because of `mustRepass`. `parentState` averages R, so parents can look healthier than the failed leaf. This is M1/M2 scoring semantics that M3 exposes in the result text. Not changed. It is an owner decision on what R should mean while `mustRepass` is set.
4. **A lost final response cannot be recovered.** If the last `submit_answer` succeeds but its response is lost, a resend returns `session_completed`, not the result. The score is saved, so only the display is lost. Recovery works only for the crash window before `markCompleted`.
5. **Lock gaps:**
   - Callers queued behind a same-process holder wait with no timeout.
   - The MCP lock wait is the core default of 30 s, not the 15 s the design suggested for client tool timeouts.
   - The stalled-holder window the design accepted is unchanged.
   - The heartbeat does not check that the file is still ours before touching it.
6. **Missing guards from the design and PLAN §8:**
   - There is no `lock-coverage` static test.
   - There is no 100% coverage threshold on `quiz/select.ts`; it is at 95% / 79%, so adding it needs more tests first.
   - There are no separate core `permutation-uniformity` or `session-recovery` test files. That coverage lives in `mcp/test/quiz-uniformity` and `quiz-recovery`.
7. **Smaller items:** `heatColor` in `map/palette.ts` is exported but unused. `get_map`'s description still spells the emojis in static text. No changeset for M3 was added.

## Known limitations

- **Answers are on disk by design.** `.gotchea/questions/*.json` holds the key, and a session file holds the permutations. An agent with file access can compute the correct slot. This is the accepted leak of PLAN §6, and the tool descriptions and the elicitation path are the mitigation.
- **Sessions are single-reader.** An MCP session and a CLI session are never mixed (origin-scoped). Two processes answering the same session are not supported.
- **A session fixes its questions and chunk hash at start.** If the code changes mid-quiz (a new `chunks.json`), the session expires and nothing is scored.
- **English only.** The quiz text is English, while `get_map` keeps its Turkish counts. (M3_DESIGN open question 1.)
- **Never-quizzed leaves are red.** There is no separate "ready" state. (M3_DESIGN open question 2.)
- **Short sessions still multiply S by 2.5.** The `minQuestions` floor is 3. (Open question 3.)
- **Session TTL is 120 minutes idle**, retention 7 days.
- **Flagged-question review, the verifier model, the pool cap and partial staleness** are untouched (M2 open questions).

## Follow-ups for M4 and later

1. Decide the elicitation default and test on Claude Code, Codex, Claude Desktop and Cursor (open item 1).
2. Decide what R and the colour mean while `mustRepass` is set, and how a failed leaf should feed its parents. M4's treemap will make this visible (open item 3).
3. Make scoring reconcile-aware for deferred leaves (open item 2).
4. Add the `lock-coverage` static test and the `select.ts` 100% threshold (open item 6).
5. Reuse `buildMiniHeatmap` and `HEAT` for the web treemap, so the web UI shares the same colour source. `gotchea serve` should read through `loadMapTree`, which already reconciles.
6. Add a "ready, never quizzed" marker if you want it before the treemap, which needs a field on `MapNode` and the MCP map schema.
7. M5 docs: the generating-subagent advice (M2), the two quiz tools and `gotchea quiz`, the lock timeout and `GOTCHEA_LOCK_TIMEOUT_MS`, and a changeset for M3.

## Dogfooding questions (answer these first; the key is at the bottom)

**Q1.** A client calls `submit_answer` for question 2 of a 5-question session, but question 1 is still unanswered. What happens?

- A) The answer is recorded, and question 1 stays open.
- B) It is refused as `out_of_order`. Nothing is graded and nothing is revealed.
- C) It is refused as `unknown_question`.
- D) The session expires and nothing is scored.

**Q2.** The final `submit_answer` of a session scores the chunk and writes `progress.json`. The server then crashes before the session file is marked `completed`. The client resends the same final answer. What happens?

- A) `session_completed`, so the result is lost.
- B) The answer is graded again, and S is multiplied a second time.
- C) The session is still `active` and fully answered, so the resend takes the repeat path. It finds the history entry with this session id, skips scoring, marks the session completed and returns the same result.
- D) `already_answered`, because the answer differs.

**Q3.** `.lock` belongs to a process on this host that was killed with `kill -9`, and its heartbeat file is 3 s old. Another command wants the lock. What happens?

- A) It waits until the file's mtime is 30 s old.
- B) It breaks the lock at once, because the pid is dead on this host, after taking `.lock.break` and re-checking the staleness.
- C) It fails with `LockTimeoutError` immediately.
- D) It deletes the lock without taking `.lock.break`.

<details>
<summary>Answer key (open after answering)</summary>

**Q1: B.** `recordAnswer` checks the unknown question first, then an already-answered one, then the order. Question 2 is a member of the session, so it is not `unknown_question`. It is not the first unanswered one, so it is refused as `out_of_order` before `grade` is ever called, and nothing is revealed. A is wrong because answers must be a prefix. C describes ids outside the session. D mixes up expiry.

**Q2: C.** Scoring is idempotent on the session id inside the repo lock. After the crash the session is still `active` and every question is answered, so the resend hits the `repeat` branch, then the scoring path. `scoreSession` sees the history entry and returns `alreadyScored` without writing. A is the case after `markCompleted` succeeded. B is the bug the design prevents. D is wrong because the resend has the same display index.

**Q3: B.** `isStale` is true when the holder host equals this host and `process.kill(pid, 0)` reports `ESRCH`, regardless of the mtime. The waiter takes `.lock.break`, re-reads `.lock`, re-checks the staleness on the current contents, unlinks and retries. A is the cross-host rule. C ignores the stale rules. D skips the serialisation that stops two waiters from deleting each other's fresh lock.

</details>
