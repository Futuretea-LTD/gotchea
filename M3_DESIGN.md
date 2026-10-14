# gotchea — M3 Design (Quiz and Score)

Status: **design, approved scope = PLAN §9 "M3"**. No production code is written by this document.
Inputs: PLAN.md §3, §5, §6, §9, §10 (esp. 15, 16, 20, 23, 26, 38, 50, 57), M1_SUMMARY.md, M2_DESIGN.md, M2_SUMMARY.md, and the current tree under `packages/` (verified, not assumed).

Facts about the current code that this design builds on:
- `core/score/` already has everything the quiz needs: `chunkState`, `parentState`, `colorFor`, `passThreshold`, `questionCount`, `selectionPriority`, `onSessionResult`, `emptyProgress`, `computeTreeStates`. M3 adds **no new scoring math**.
- `core/scan/reconcile.ts` has the pure `reconcileProgress`, but it only runs inside `scanRepo`. `loadMapTree`, `getStatus`, `get_map` and `get_status` read `progress.json` without reconciling, so a `git pull` is not reflected until the next scan (§6.3).
- `userPaths(repoId)` already reserves `sessionsDir` and `lock` (`~/.gotchea/repos/<id>/sessions`, `.lock`). Nothing writes them yet (PLAN §10.38).
- `FsQuestionStore.update()` serialises writers with a private in-process `KeyedLock`. There is no cross-process protection (M2_SUMMARY, open question 7). The CLI and the MCP server can write the same files today.
- `generate/tasks.ts` computes the fan-in weight inline (`1 + fanInWeight·ln(1+fanIn)`), duplicating `score/state.ts#selectionPriority`. M3 removes that duplication (§2.3).
- The CLI renders colours with picocolors (`render/tree-heatmap.ts#paintFor`) and the MCP renders emoji (`tools/get_map.ts#EMOJI`): two tables, no shared source (§9).
- `@modelcontextprotocol/sdk` is 1.32.1 and `@clack/prompts` ^1.8.1 is already a CLI dependency.
- `gotchea quiz` is a stub in `cli/src/commands/stubs.ts`; `QuestionPublic` in `model/question.ts` is exported but unused.

---

## 0. Decisions fixed by this document

| # | Decision |
|---|---|
| D1 | **One engine, two front-ends.** `core/ops/quiz.ts` (`startQuiz`, `submitAnswer`, `abandonQuiz`) is the only code that selects, grades and scores. The MCP tools and the CLI command are thin renderers over it, like `saveQuestions` (M2 D6). |
| D2 | **Permutations are key-agnostic.** They are generated at session start from an injectable RNG, without reading `correctIndex`, and persisted. Because the permutation is independent of the key, the correct display index is uniform for *any* distribution of stored keys (§3.4). |
| D3 | **The public view is minimal:** `{ questionId, position, total, stem, options: [{ index, label, text }] }`. `type`, `difficulty`, `lang`, refs, explanation and key never appear before submit (§4). This replaces the unused `QuestionPublic`. |
| D4 | **One question at a time, answered in order, answers final.** `start_quiz` returns question 1; each `submit_answer` returns the reveal for that question and the public view of the next one. A resend of an identical answer is idempotent; a different `displayIndex` for an answered question is refused. |
| D5 | **Only a completed session scores.** Abandoned, expired or invalidated sessions (chunk changed mid-quiz) never touch `progress.json`. |
| D6 | **Locking lives in the ops layer, not in the stores.** Stores stay primitives. Every operation that read-modify-writes shared state takes `withRepoLock`; a static test lists the allowed call sites (§5.4). |
| D7 | **Colour semantics are unchanged from PLAN §3 / M2 D8.** `colorFor` is the one classifier. M3 adds a shared *presentation* table (`map/palette.ts`) and nothing else (§9). A never-quizzed leaf with questions stays red (R = 0); a separate "ready" state is deferred (open question 2). |
| D8 | **MCP elicitation is optional, experimental and off by default** (§7.4). The two-tool flow is the primary, universal path, and it is also the fallback. |
| D9 | **Ref drift is displayed, not hidden:** when the chunk's current line count differs from `q.chunkLines`, refs are shown as approximate (`≈ L12`) and clamped to the chunk. Resolves M2 open question 1. |
| D10 | **Reconcile runs on read.** Every command or tool that loads progress first calls `ensureReconciled` (§6.3). Resolves PLAN §9 "reconcile wired into every command". |
| D11 | **User-facing quiz text is English**, centralised in one module per front-end (`mcp/src/tools/quiz-text.ts`, `cli/src/render/quiz.ts`). `get_map` keeps its existing Turkish count strings (`soru`); localisation is an open question (§12). |

New config (all optional, `quiz` object in `config/schema.ts`):

```jsonc
"quiz": {
  "passRatio": 0.75, "excludeRecentSessions": 2, "fanInWeight": 0.5,   // existing
  "minQuestions": 3,            // smallest allowed session size
  "sessionTtlMinutes": 120,     // idle timeout; refreshed on every answer
  "sessionRetentionDays": 7     // finished/expired session files are deleted after this
}
```

---

## 1. File layout

Core code is under `packages/core/src/quiz/` (PLAN §2). Orchestration that touches several stores lives in `ops/`, next to `ops/scan.ts` and `ops/status.ts`. Tests mirror `src/` under `packages/core/test/…`.

```
packages/core/src/
├─ quiz/
│  ├─ select.ts        PURE. selectChunk(), selectQuestions(), sessionSize(), QuizSelectError.
│  │                   Imports only model/, score/, map/tree#matchesFilter and config types.
│  │                   No parse/, chunk/, generate/ or store/ imports (PLAN §2). 100% coverage (PLAN §8).
│  ├─ session.ts       Session type + strict SessionSchema, Rng + cryptoRng + seededRng, makePermutation(),
│  │                   QuizSessions (lifecycle: create, get, recordAnswer, abandon, sweep) over a SessionStore.
│  └─ views.ts         PublicQuestionView, PrivateQuestionView, RevealView, SessionResultView (types + strict zod
│                      schemas), toPublicView(), toPrivateView(), toRevealView(), assertPublicView(), FORBIDDEN_KEYS.
├─ store/
│  ├─ repo-lock.ts     withRepoLock(), LockTimeoutError, inspectRepoLock()   (the lockfile module, §5)
│  ├─ keyed-lock.ts    KeyedLock, extracted from question-store.ts (in-process, per key)
│  └─ session-store.ts FsSessionStore, InMemorySessionStore   (SessionStore interface lives in store/types.ts)
├─ map/
│  ├─ palette.ts       HEAT: Record<ChunkColor, { emoji, ansi, label }>   (presentation data only, §9)
│  └─ mini-heatmap.ts  buildMiniHeatmap(chunks, states, chunkId) → MiniHeatmap (pure), renderMiniHeatmapText()
└─ ops/
   ├─ quiz.ts          startQuiz(), submitAnswer(), abandonQuiz(), QuizOpsDeps   (the engine, D1)
   └─ reconcile.ts     ensureReconciled(root, opts) → { changes, deferred }
```

**Why session persistence is a `store/` file, not inside `session.ts`:** every other persistence primitive (`progress-store.ts`, `snapshot-store.ts`) is a `store/` file with an `Fs*` and an `InMemory*` class behind an interface in `store/types.ts`. `session.ts` keeps the type, the schema, the permutation logic and the lifecycle rules, which are pure apart from the injected store, clock and RNG. The in-memory store the MCP server uses is `InMemorySessionStore` wrapped as a write-through cache over `FsSessionStore` (§3.2).

**Where the lockfile lives:** `packages/core/src/store/repo-lock.ts`, with its path from the existing `userPaths(repoId).lock` (`~/.gotchea/repos/<id>/.lock`). It depends only on `node:` modules, `store/paths.ts` and `store/keyed-lock.ts`, so it can be bundled and unit-tested in child processes (§10.5).

### 1.1 Public vs internal API (PLAN §6, §10.57)

`gotchea-core` (public) gains:
- Views and schemas that may cross an interface boundary: `PublicQuestionView`, `RevealView`, `SessionResultView`, `MiniHeatmap` (+ their `*Schema`), `assertPublicView`, `FORBIDDEN_KEYS`.
- Ops: `startQuiz`, `submitAnswer`, `abandonQuiz`, `ensureReconciled`, with result types that contain **only views** (never `QuestionPrivate`).
- Lock: `withRepoLock`, `LockTimeoutError`.
- Palette and heatmap: `HEAT`, `buildMiniHeatmap`, `renderMiniHeatmapText`.
- Session types without answer data: `Session`, `SessionStatus`, `Rng`, `seededRng`, `cryptoRng`, `QuizSessions`, `SessionStore`, `InMemorySessionStore`, `FsSessionStore`. A `Session` holds `permutations` and `answers` (display indexes and a `correct` boolean) but **never** `correctIndex`, stem text or explanations.

`gotchea-core/internal` gains: `PrivateQuestionView`, `toPrivateView` (tests only).

`select.ts` is exported publicly. Its question-level inputs are typed `Pick<QuestionPrivate, 'id' | 'type' | 'lang' | 'status' | 'flagged' | 'chunkHash'>`, so it compiles without the answer key by construction.

---

## 2. `quiz/select.ts` — choosing a chunk and its questions

Pure functions over plain data. The caller (`ops/quiz.ts`) loads chunks, states, progress and pools; `select.ts` never does I/O, never imports a store and never receives `correctIndex`.

### 2.1 Types

```ts
export type QuizTarget =
  | { path: string; chunkId?: undefined }   // a directory, file, or '#symbol' prefix (same grammar as `map [path]`)
  | { chunkId: string; path?: undefined }   // one leaf, id or alias
  | { path?: undefined; chunkId?: undefined };  // whole repo

export type QuizSelectErrorCode =
  | 'unknown_chunk'          // chunkId not in chunks.json (aliases resolve to the current id)
  | 'not_leaf'               // chunkId names a module/file/group container: hint "pass it as `path`"
  | 'no_match'               // path matches no chunk
  | 'no_quizzable_chunk'     // matches exist but no leaf has enough usable questions
  | 'not_enough_questions';  // explicit chunkId with fewer than the session size usable questions

export class QuizSelectError extends Error {
  readonly code: QuizSelectErrorCode;
  /** Only for not_enough_questions / no_quizzable_chunk: usable questions of the best candidate, and how many it needs. */
  readonly have?: number;
  readonly need?: number;
  readonly chunkId?: string;
}

export interface SelectChunkInput {
  chunks: readonly Pick<Chunk, 'id' | 'parentId' | 'isLeaf' | 'aliases' | 'metrics' | 'questionCount'>[];
  /** Usable questions per leaf (okQuestionCounts): ok, not flagged, current hash. Missing = 0. */
  usable: ReadonlyMap<string, number>;
  /** computeTreeStates output, computed at the caller's injected `now`. */
  states: ReadonlyMap<string, ChunkState>;
  progress: Readonly<Record<string, Pick<Progress, 'mustRepass'>>>;
  target: QuizTarget;
  /** Requested session size; undefined = the chunk's questionCount. */
  count: number | undefined;
  cfg: Pick<GotcheaConfig['quiz'], 'fanInWeight' | 'minQuestions'>;
}

export interface ChunkSelection {
  chunkId: string;
  /** Session size actually used (§2.2). */
  size: number;
  /** selectionPriority of the winner; null when the chunk was named explicitly. */
  priority: number | null;
  /** True when every candidate was green: the pick is a "keep it fresh" review, not a due one. */
  allGreen: boolean;
}

export function selectChunk(input: SelectChunkInput): ChunkSelection;   // throws QuizSelectError
```

### 2.2 Session size

```ts
export function sessionSize(
  chunk: Pick<Chunk, 'questionCount'>,
  requested: number | undefined,
  cfg: Pick<QuizConfig, 'minQuestions'>,
): number
// size = clamp(requested ?? chunk.questionCount, min(cfg.minQuestions, chunk.questionCount), chunk.questionCount)
```

- Default = the chunk's `questionCount` (3/5/7 from the bands, PLAN §10.15).
- A smaller `count` is allowed down to `minQuestions` (3), never larger than `questionCount`. **Why not larger:** a session larger than the band would need reuse of questions inside one session. **Why a floor of 3:** the pass rule multiplies S by 2.5; a one-question session passed by a lucky guess would be a cheap way to inflate S (open question 3). `passThreshold(size, quiz.passRatio)` (existing) gives the number needed: 3→3, 4→3, 5→4, 7→6 at 0.75.
- A chunk is **quizzable** when `usable.get(id) ≥ size`. Below that: `not_enough_questions` for an explicit target, skipped for a path.

### 2.3 Which chunk — reusing `score/` priority, not duplicating it

`selectChunk` calls only existing score functions:

```
candidates = leaves matching the target (matchesFilter(id, path) from map/tree.ts, or the one chunkId)
             with usable ≥ sessionSize(chunk, count)
R_eff(c)   = progress[c.id]?.mustRepass ? 0 : (states.get(c.id)?.R ?? 0)
priority(c) = selectionPriority(R_eff(c), c.metrics.fanIn, { fanInWeight })      // (1 − R)·(1 + w·ln(1+fanIn))
winner     = max by [priority, fanIn, lowest R, id ascending]   // id is the final, deterministic tiebreak
allGreen   = every candidate has state.color === 'green'
```

- `states` comes from `computeTreeStates` (existing); a never-passed leaf already has R = 0, so it gets the maximum `(1 − R)`.
- `R_eff` forces `mustRepass` leaves to R = 0 so a chunk that must be re-passed outranks a high-R one. `selectionPriority`'s existing contract (`null` counts as 0) is untouched.
- For an explicit `chunkId` there is no ranking: it must be a leaf (`not_leaf` otherwise) and quizzable (`not_enough_questions` otherwise), and `priority` is `null`.
- Aliases resolve before the lookup (`c.aliases?.includes(chunkId)`), like `save_questions`.
- A `path` that is itself an exact leaf id (contains `#`) is treated as that one leaf.
- Grey leaves can't win: they have no usable questions and so are never candidates.

**Remove the duplication (modifies `score/state.ts` and `generate/tasks.ts`):** add `export function fanInFactor(fanIn, cfg) { return 1 + cfg.fanInWeight * Math.log1p(Math.max(0, fanIn)); }` to `score/state.ts` and make `selectionPriority = (1 − (R ?? 0)) · fanInFactor(...)`. The inline `const weight = 1 + …` in `generate/tasks.ts` becomes `fanInFactor(chunk.metrics.fanIn, cfg.quiz)`. Both stay at 100% coverage (`score/**` threshold), and generation order is unchanged, which the existing `tasks.test.ts` proves.

### 2.4 Which questions

```ts
export interface SelectQuestionsInput {
  pool: readonly Pick<QuestionPrivate, 'id' | 'type' | 'lang' | 'status' | 'flagged' | 'chunkHash'>[];
  chunkHash: string;
  size: number;
  /** Preferred language (config questions.lang or the `lang` input). */
  lang: string;
  /** Oldest-first session history of this chunk (Progress.history): the question ids of each session. */
  history: readonly { questionIds: readonly string[] }[];
  excludeRecentSessions: number;
  rng: Rng;
}
export function selectQuestions(input: SelectQuestionsInput): string[];   // ordered ids, length = size; throws not_enough_questions
```

Algorithm (deterministic for a given `rng`):

1. `usable = pool.filter(isUsable at chunkHash)` (`store/question-pool.ts`). Fewer than `size` → `QuizSelectError('not_enough_questions')`.
2. For each question compute `askedAgo` = index of the most recent session in `history` (0 = the last one) that contains it, or `Infinity` if never asked.
3. Sort key, ascending: `[langTier (0 = preferred lang, 1 = other), recent (askedAgo < excludeRecentSessions ? 1 : 0), −askedAgo (never asked first, then the longest ago), rng tiebreak]`. The preferred language wins first (PLAN §10.26; resolves M2 open question 8: other languages only fill the session), then fresh questions, then the least recently asked (PLAN §10.15).
4. **Type balance:** walk the sorted list taking a question while `takenOfType[type] < ceil(size / distinctTypesAvailable)`; then fill the remainder in sorted order without the cap.
5. Shuffle the chosen ids with `rng` (Fisher–Yates) so the question order doesn't follow the type plan or the sort.

`history` is `progress.chunks[chunkId]?.history ?? []`. It is already persisted by `onSessionResult`, so selection needs no session files.

---

## 3. `quiz/session.ts` — server-side sessions

### 3.1 Types

```ts
export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'expired';
export type SessionOrigin = 'mcp' | 'cli';

export interface Answer {
  displayIndex: 0 | 1 | 2 | 3;
  correct: boolean;
  answeredAt: string;           // ISO
}

export interface Session {
  version: 1;
  id: string;                   // 'qs_' + 16 lowercase hex (8 random bytes); validated before any fs access
  origin: SessionOrigin;
  chunkId: string;
  chunkHash: string;            // contentHash when the quiz started; a change ends the session (D5)
  lang: string;
  questionIds: string[];        // in presentation order
  /** questionId → permutation: perm[displayIndex] = originalIndex. Always a bijection of [0,1,2,3]. */
  permutations: Record<string, [number, number, number, number]>;
  /** questionId → the answer. Sequential: the answered ids are always a prefix of `questionIds`. */
  answers: Record<string, Answer>;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;            // lastActivityAt + quiz.sessionTtlMinutes
  completedAt?: string;
}
```

`SessionSchema` is a `z.strictObject`, so a hand-edited file or a future writer can't smuggle `correctIndex` in, with refinements that every permutation is a bijection and that `answers` is a prefix of `questionIds`. A session file that fails the schema is treated as corrupt: `get` returns `null`, `sweep` deletes it, and nothing throws into a tool call. The file never contains stems, options, explanations or the key.

The session id is the only client-supplied value used in a file path. `SESSION_ID = /^qs_[0-9a-f]{16}$/` is checked in `QuizSessions.get` and in the Fs store before any path is built (the same hardening as `userPaths`).

### 3.2 Stores

```ts
// store/types.ts
export interface SessionStore {
  get(id: string): Promise<Session | null>;     // null when missing or corrupt
  put(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Session[]>;                   // skips corrupt files
}
```

- **`InMemorySessionStore`**: a `Map`, structured-cloned on every get/put (tests, and the cache layer below).
- **`FsSessionStore(repoId, env)`**: `~/.gotchea/repos/<id>/sessions/<sessionId>.json`, written with the existing `writeFileAtomic` (tmp + rename) and `canonicalJson`. Leftover `*.tmp` files (a crash mid-write) are ignored by `list` and removed by `sweep`.
- **MCP uses a write-through cache:** `QuizSessions` keeps an in-memory `Map<string, Session>` in front of the Fs store. A `get` hits memory first, then disk. A server restart therefore loses nothing: the next `submit_answer` finds the session on disk with the same permutations (§10.4).
- **CLI** uses the same class without relying on the cache; the persisted file is what makes an interrupted quiz resumable.

Per-session writes are serialised in-process by `KeyedLock` (key = session id). Sessions do **not** take the repo lock: each file is private to one session, written atomically, and two processes answering the same session is not a supported flow. Only the progress write on completion takes `withRepoLock` (§5.3).

### 3.3 Lifecycle

```
            start (create)                 answer (×N, in order)            last answer
  (none) ───────────────▶ active ─────────────────────────────────▶ active ─────────────▶ completed
                            │  ▲                                        │                   (progress written,
                            │  └──── resume (start_quiz, same chunk) ───┘                    under repo lock)
                            ├─ abandon (CLI quit / start_quiz replaces an untouched session) ─▶ abandoned
                            ├─ idle > ttl (lazy on get, eager in sweep) ─────────────────────▶ expired
                            └─ chunk contentHash ≠ session.chunkHash at answer time ─────────▶ expired ("chunk_changed")
```

`QuizSessions` API:

```ts
export interface QuizSessionsOptions {
  store: SessionStore;
  now: () => Date;
  rng: Rng;                       // default cryptoRng
  ttlMs: number;                  // quiz.sessionTtlMinutes · 60_000
  retentionMs: number;            // quiz.sessionRetentionDays · 86_400_000
  cache?: boolean;                // true for MCP
}
class QuizSessions {
  create(i: { origin; chunkId; chunkHash; lang; questionIds: string[] }): Promise<Session>;
  get(id: string): Promise<Session | null>;     // applies lazy expiry; never throws on corrupt/missing
  findActive(f: { origin: SessionOrigin; inChunks?: ReadonlySet<string> }): Promise<Session[]>;   // newest first
  recordAnswer(id: string, questionId: string, displayIndex: number, grade: (originalIndex: number) => boolean):
    Promise<{ session: Session; answer: Answer; repeat: boolean }>;   // throws SessionError(code)
  markCompleted(id: string): Promise<Session>;
  abandon(id: string): Promise<void>;
  sweep(): Promise<{ expired: number; deleted: number }>;
}
```

- **create:** generates `permutations` (§3.4), `id`, timestamps; `put`s before returning (write-before-reply: a client can only learn the id after it is on disk).
- **recordAnswer** rules, in order; each failure is a typed `SessionError` and changes nothing:
  1. unknown/corrupt id → `unknown_session`; status ≠ `active` → `session_completed` / `session_expired`; `now > expiresAt` → persist `expired`, `session_expired`.
  2. `questionId ∉ questionIds` → `unknown_question`.
  3. Already answered: same `displayIndex` → return the stored answer with `repeat = true` (idempotent resend after a lost response); different → `already_answered`.
  4. Not the first unanswered id → `out_of_order` (D4).
  5. `originalIndex = permutations[questionId][displayIndex]`; `correct = grade(originalIndex)`. `grade` is supplied by the ops layer, which holds the private question; `session.ts` itself never sees the key.
  6. Store the answer, refresh `lastActivityAt`/`expiresAt`, `put`.
- **complete:** done by `ops/quiz.ts#submitAnswer` after the last answer: score under the lock, then `markCompleted` (crash window in §5.3).
- **expire:** lazy in `get`, eager in `sweep`.
- **cleanup (`sweep`):** called at the start of every `startQuiz`, at MCP server start and at CLI `quiz` start. It (1) marks active sessions past their `expiresAt` as `expired`, (2) deletes `completed | abandoned | expired` sessions whose `lastActivityAt` is older than `retentionMs`, (3) deletes corrupt files and stray `.tmp` files older than 1 h. The scored outcome lives in `progress.history`, so deleting a completed session loses nothing.

**Resume-or-create (used by `startQuiz`):** before selecting, `findActive({ origin })` is filtered to sessions whose chunk lies in the target scope. If one has ≥ 1 answer it is **resumed** (`status: 'resumed'`, its next unanswered question is returned, `count`/`lang` are ignored and the text says so). Active sessions with no answers are `abandon`ed and replaced, so a client that retries `start_quiz` after a timeout doesn't leave orphans. A CLI never resumes an `mcp` session, and vice versa (an agent may be mid-conversation).

### 3.4 Permutations: uniform correct display index, injectable RNG

```ts
export interface Rng { int(maxExclusive: number): number }            // uniform integer in [0, maxExclusive)
export const cryptoRng: Rng = { int: (n) => crypto.randomInt(n) };    // unbiased (rejection sampling inside Node)
export function seededRng(seed: number): Rng;                         // mulberry32; tests and debugging only

export function makePermutation(rng: Rng): [number, number, number, number] {
  const p = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {                                       // Fisher–Yates
    const j = rng.int(i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p as [number, number, number, number];
}
```

- `perm[d] = o` means "display slot `d` shows original option `o`". The display options of a question are `[0,1,2,3].map((d) => q.options[perm[d]])`, and the correct display index is `perm.indexOf(q.correctIndex)`.
- **Why this is uniform.** The permutation is drawn uniformly from all 24 orderings and is **independent of `correctIndex`**. For any fixed original index `o`, `P(perm⁻¹(o) = d) = 6/24 = 1/4` for every `d`, however skewed the generator's keys are (LLMs favour B/C). No post-hoc balancing is needed, and the key is not needed at session start.
- **One independent permutation per question** (not per session), so questions in a session don't share a pattern.
- **Not reshuffled on resume:** permutations are persisted in the session, so a reconnecting client sees the same order and a resent answer maps identically.
- **Injection:** `QuizSessionsOptions.rng` defaults to `cryptoRng`. `selectQuestions` takes the same `Rng`, so one seeded RNG makes an entire `startQuiz` reproducible. The MCP `ServerOptions.rng` and the CLI `ProgramDeps.rng` exist for tests only.
- `seededRng` uses `Math.floor(next() * n)`, a bias of ≈ 2⁻³² per draw: irrelevant for tests, and never the default.

---

## 4. `quiz/views.ts` — public vs private views

Three shapes, each with a strict zod schema (zod 4 `z.strictObject`, as in `mcp/src/schemas.ts`):

```ts
export const LABELS = ['A', 'B', 'C', 'D'] as const;

const OptionView = z.strictObject({ index: z.number().int().min(0).max(3), label: z.enum(LABELS), text: z.string() });

// Crosses the interface boundary BEFORE submit. Nothing else may.
export const PublicQuestionViewSchema = z.strictObject({
  questionId: z.string().regex(/^q_[0-9a-f]{12}$/),
  position: z.number().int().min(1),                    // 1-based position in the session
  total: z.number().int().min(1),
  stem: z.string(),
  options: z.tuple([OptionView, OptionView, OptionView, OptionView]),   // refined: options[i].index === i, label === LABELS[i]
});

// INTERNAL. Never exported from the public barrel; produced only inside ops/quiz.ts.
export interface PrivateQuestionView extends PublicQuestionView {
  correctDisplayIndex: 0 | 1 | 2 | 3;
  explanation: string;
  refs: QuestionRef[];                                  // chunk-relative
  chunkLines: number;
}

// Crosses the boundary only AFTER the answer for that question was recorded.
export const RevealViewSchema = z.strictObject({
  questionId: z.string(),
  correct: z.boolean(),
  selectedDisplayIndex: z.number().int().min(0).max(3),
  correctDisplayIndex: z.number().int().min(0).max(3),
  correctText: z.string(),
  explanation: z.string(),
  refs: z.array(z.strictObject({ path: z.string(), startLine: z.number().int(), endLine: z.number().int(), approximate: z.boolean() })),
});
```

Builders copy fields explicitly (never `{...q}`), like `get_map`'s `toOut`:

```ts
// The parameter type is Pick<…, 'id'|'stem'|'options'>: the builder can't even name the key.
export function toPublicView(q: Pick<QuestionPrivate, 'id' | 'stem' | 'options'>, perm: Permutation, position: number, total: number): PublicQuestionView;
export function toPrivateView(q: QuestionPrivate, perm: Permutation, position: number, total: number): PrivateQuestionView;
export function toRevealView(pv: PrivateQuestionView, selected: number, chunk: Pick<Chunk, 'ranges'>): RevealView;
```

- **Refs → absolute lines (display time only, M2 D1):** each `QuestionRef {start, end}` is mapped with the existing `toAbsoluteLine(chunk, ref)`; a ref that spans a multi-range boundary (`~top`, `~body`) becomes one reveal ref per range. `approximate = pv.chunkLines > 0 && chunkLineCount(chunk) !== pv.chunkLines`, and approximate refs are clamped to the chunk (D9). v1-migrated questions have `refs: []` and show no lines.
- **The guard.**
  ```ts
  export const FORBIDDEN_KEYS = ['correctIndex', 'correctDisplayIndex', 'correctOptionIndex', 'correctText', 'explanation', 'refs', 'answer', 'key'] as const;
  export function assertPublicView(v: unknown): PublicQuestionView;
  // 1) PublicQuestionViewSchema.parse(v): strict, so any extra key throws ("Unrecognized key").
  // 2) deep key scan: throws if any object key at any depth is in FORBIDDEN_KEYS (defence in depth: covers a future field).
  ```
  `ops/quiz.ts` calls `assertPublicView` on **every** pre-submit value it returns, and each MCP output schema re-validates it (a third layer: the SDK validates `structuredContent` against `outputSchema`). A test feeds each layer a view carrying `correctIndex` and expects a throw (§10.3).
- **Deliberately not in the public view:** `type` (a `bug_detection` label tells the user what to look for), `difficulty`, `lang`, refs, explanation, key. `position`/`total` describe the session, not the question.
- The M2 export `QuestionPublic` (id/type/stem/options/difficulty/lang) is removed from the public barrel; it was unused.

---

## 5. Lockfile — `store/repo-lock.ts`

PLAN §10.23 / §10.38 / M2 open question 7. After M3 there are three writers of shared state (CLI, MCP server, `generate`), and sessions add progress writes on completion. One lock per repoId, held only for read-modify-write sections.

### 5.1 API

```ts
export interface LockHolder { v: 1; pid: number; host: string; token: string; startedAt: string; cmd: string }

export interface RepoLockOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;     // total wait. Default 30_000 (CLI), 15_000 (MCP: under typical client tool timeouts). Env override GOTCHEA_LOCK_TIMEOUT_MS.
  staleMs?: number;       // lock file mtime older than this ⇒ stale. Default 30_000.
  heartbeatMs?: number;   // the holder touches the file this often. Default 5_000 (6 missed beats ⇒ stale).
  label?: string;         // stored as `cmd`: 'scan', 'quiz', 'save_questions', …
  onWait?: (holder: LockHolder | null, waitedMs: number) => void;   // called once after 1 s (CLI prints "waiting for pid N (scan)…")
  signal?: AbortSignal;
  // Test seams:
  now?: () => number; sleep?: (ms: number) => Promise<void>; isPidAlive?: (pid: number) => boolean; pid?: number; host?: string;
}

export async function withRepoLock<T>(repoId: string, fn: () => Promise<T>, opts?: RepoLockOptions): Promise<T>;
export class LockTimeoutError extends Error { readonly holder: LockHolder | null; readonly waitedMs: number }
export function inspectRepoLock(repoId: string, env?: NodeJS.ProcessEnv): Promise<{ holder: LockHolder | null; ageMs: number; stale: boolean } | null>;
```

### 5.2 Acquisition strategy

Path: `userPaths(repoId).lock` (`~/.gotchea/repos/<id>/.lock`); `repoDir` is created first (`mkdir -p`).

1. **Re-entrancy.** An `AsyncLocalStorage<Set<string>>` records the repoIds this async context already holds. A nested `withRepoLock` for the same repoId runs `fn` directly (`scanRepo` inside `ensureReconciled` must not deadlock).
2. **In-process queue.** A `KeyedLock` keyed by repoId serialises callers inside one process first (concurrent MCP tool calls), so only one caller per process polls the file.
3. **Create:** `fs.open(path, 'wx')` (`O_CREAT | O_EXCL | O_WRONLY`; atomic on local filesystems and NTFS). On success write the `LockHolder` JSON (`pid`, `host = os.hostname()`, random 128-bit `token`, ISO `startedAt`, `cmd`), `fsync`, `close`. Then start the heartbeat: `utimes(path, now, now)` every `heartbeatMs` on an `unref()`ed timer.
4. **`EEXIST` → inspect the holder** (read + parse; a missing file means retry immediately):
   - **Stale** if any of:
     a. `host === os.hostname()` and the pid is not alive (`process.kill(pid, 0)` throws `ESRCH`; `EPERM` counts as alive);
     b. `now − mtime > staleMs` (the heartbeat stopped: crash, `kill -9`, laptop sleep, or another host through a synced home directory);
     c. the file is empty/unparseable **and** older than 5 s (a writer died between create and write; the grace period avoids breaking a lock that is still being written).
   - **Not stale** → backoff and retry (step 6).
5. **Break a stale lock, serialised.** Breaking is guarded by a second `O_EXCL` file `.lock.break` (same holder format, stale after 10 s by mtime). The breaker, holding `.lock.break`:
   1. re-reads `.lock` and re-checks the stale condition on its *current* contents (it may have been released and re-acquired meanwhile);
   2. `unlink`s `.lock`;
   3. loops back to step 3 and releases `.lock.break` in `finally`.

   Only breakers delete a lock they don't own, and breakers are mutually exclusive, so two waiters can't both judge the same file stale and then each delete the *other's fresh* lock. **Residual risk, accepted:** a holder that was merely stalled for more than 30 s (not dead) and then resumes and releases while a breaker is between its re-check and its `unlink` can lose the lock to the breaker. That sub-millisecond window needs a 30 s stall first, and every critical section re-reads its inputs inside the lock, so the failure mode is the pre-M3 status quo (a rare lost update), not corruption: all writes stay atomic renames.
6. **Backoff:** `delay = min(250, 25 · 1.6^attempt)` ms with full jitter (`random() · delay`), until `timeoutMs`. Then `LockTimeoutError`: `Another gotchea process (pid 4242, "scan", 12 s ago) holds the lock for this repository. Wait for it to finish, or delete <path> if that process is gone.`
7. **Release (`finally`):** stop the heartbeat; read the file and `unlink` it **only if `token` matches ours** (never delete someone else's lock); ignore `ENOENT`. A process `exit` hook (registered once) synchronously unlinks any lock this process still holds (best effort; SIGKILL falls back to staleness). The CLI maps SIGINT to an `AbortController` so `finally` blocks run.
8. **Windows:** `utimes` and `unlink` after `close` work; `EPERM` on `unlink` (antivirus) is retried 3 × 20 ms. `isPidAlive` has the same `process.kill(pid, 0)` semantics.

**What is protected:** the critical section runs while the file exists and its mtime is fresh. A hung-but-alive holder keeps its heartbeat and blocks others until they time out with a clear message, which is preferable to silently breaking a live scan.

### 5.3 Wiring: every mutating path goes through the lock

The lock is taken in the **core operation**, so every entry point (CLI, MCP, tests) is covered by construction. Slow, read-only work (walking and parsing the tree, blind-verify provider calls, reading source for hashes) stays **outside** the lock; the lock covers only the read-modify-write.

| Operation (core) | Reached from | Lock scope | Writes protected |
|---|---|---|---|
| `scanRepo` (non-dry-run) | CLI `scan`, MCP `scan`, `ensureReconciled` | steps 4–6 only (load previous `chunks.json`, diff, `applyScanDiff`, `reconcileProgress`, persist). Steps 1–3 (walk, parse, tree) run before the lock. | `chunks.json`, question pools, `progress.json`, snapshots |
| `saveQuestions` | CLI `generate`, MCP `save_questions` | gate re-check + insert only. Gate, validate and blind verify run first; inside the lock `chunk_hash_mismatch` is re-checked against `chunks.json` (a scan may have run during verify), then `insertQuestions`. | question pool |
| `ensureReconciled` | `loadMapTree`, `getStatus`, `startQuiz`; so CLI `map`/`status`/`quiz`, MCP `get_map`/`get_status`/`start_quiz` | only when a mismatch exists (§6.3); progress is reloaded inside the lock | `progress.json`, snapshots |
| `submitAnswer` → completion | CLI `quiz`, MCP `submit_answer` | scoring: reload progress, `onSessionResult`, save | `progress.json` |
| `FsQuestionStore.update` | callers above | the in-process per-chunk lock stays as a second, finer layer | question pool |
| `init` (`initConfig`) | CLI `init` | not locked: it writes only `<repo>/.gotchea/config.json` and `questions/`, before any repoId state exists. Documented in the command's header comment. | |
| session files | `QuizSessions` | not locked (§3.2) | `sessions/*.json` |

**Completion and the crash window.** `submitAnswer` on the last question does, in order:
1. `withRepoLock`: reload `progress.json`; if `progress.chunks[id].history` already has an entry with this `sessionId` → skip (idempotent); else `onSessionResult` and save progress.
2. `markCompleted` (session file), outside the lock.

A crash after (1) and before (2) leaves an `active`, fully answered session. Resending the last answer takes the `repeat` path, finds the history entry, skips scoring, marks the session completed and returns the same result (§10.4). S is never multiplied twice.

### 5.4 Keeping it that way

- `store/*-store.ts` mutators (`save`, `put`, `remove`, `update`, `move`) never lock; they are primitives.
- **Static test** `test/store/lock-coverage.test.ts` (the same style as the existing "chunk-index imports no tree-sitter" source test): it scans `packages/*/src/**/*.ts` for calls to the progress/chunk/snapshot/question store mutators and fails if one appears outside an allow-list of files that wrap it in `withRepoLock` (`scan/scan.ts`, `generate/save.ts`, `ops/reconcile.ts`, `ops/quiz.ts`) or the stores themselves.

---

## 6. Engine — `ops/quiz.ts`, `ops/reconcile.ts`

### 6.1 `startQuiz`

```ts
export interface StartQuizInput { path?: string; chunkId?: string; count?: number; lang?: string }
export interface QuizOpsDeps {
  sessions: QuizSessions;          // shared per process (MCP server) or per command (CLI)
  origin: SessionOrigin;
  config?: GotcheaConfig; env?: NodeJS.ProcessEnv; now?: () => Date; rng?: Rng;
}
export type StartQuizResult =
  | { status: 'started' | 'resumed'; session: SessionHeader; question: PublicQuestionView }
  | { status: 'refused'; reason: QuizSelectErrorCode | 'both_targets' | 'not_scanned' | 'lang_invalid'; message: string };
export interface SessionHeader { id; chunkId; chunkTitle; path: string | null; total; answered; needed; expiresAt }
```

Steps (no write happens before step 7):
1. `path` and `chunkId` both given → `refused / both_targets`. `lang` validated with `LangCodeSchema`. No `chunks.json` → `not_scanned`.
2. `sessions.sweep()`.
3. `ensureReconciled(root)` (D10), then load chunks, `okQuestionCounts(root, chunks)`, progress, `computeTreeStates(now)`.
4. Resume check (§3.3). If resumed, jump to step 8.
5. `selectChunk(...)` (§2.3) → `{ chunkId, size }`.
6. Read the chunk's pool from the question store, `selectQuestions` (§2.4) with `history` and `rng`.
7. `sessions.create({ origin, chunkId, chunkHash: chunk.contentHash, lang, questionIds })`: permutations are generated and persisted.
8. Build the first unanswered question's `PublicQuestionView` from the pool + permutation, run `assertPublicView`, return.

### 6.2 `submitAnswer`

```ts
export interface SubmitAnswerInput { sessionId: string; questionId: string; displayIndex: number }
export type SubmitAnswerResult =
  | { status: 'answered'; repeat: boolean; sessionId: string; reveal: RevealView; progress: { answered; total; correct }; next: PublicQuestionView }
  | { status: 'completed'; repeat: boolean; sessionId: string; reveal: RevealView; progress: { answered; total; correct }; result: SessionResultView }
  | { status: 'refused'; reason: SessionErrorCode | 'question_unavailable'; message: string };

export interface SessionResultView {
  passed: boolean; correct: number; total: number; needed: number;
  chunk: { id: string; title: string; path: string | null };
  before: { color: ChunkColor; R: number | null };
  after: { color: ChunkColor; R: number | null; dueAt: string | null };
  stabilityDays: number | null;
  heatmap: MiniHeatmap;
}
```

1. `displayIndex ∈ 0..3` is validated by the tool schema; the engine re-checks.
2. Load the session; **chunk-changed check:** `chunks.json` hash for `session.chunkId` ≠ `session.chunkHash` (or the chunk is gone) → persist `expired`, refuse `chunk_changed`, score nothing (D5).
3. Load the question from the pool by id. Missing or no longer usable at `chunkHash` → refuse `question_unavailable` (the session stays active; `abandon` is the way out).
4. `sessions.recordAnswer(..., grade = (o) => o === q.correctIndex)`. A repeat re-derives the reveal from the stored answer.
5. Build `PrivateQuestionView` → `toRevealView`. Only now may explanation/refs/key leave the engine.
6. Not the last question → `status: 'answered'` with `next` (public view of the next question, through `assertPublicView`).
7. Last question → score (§5.3), compute `before` (state from the progress *before* applying the result) and `after` (`chunkState` after, at `now`), rebuild the tree states, `buildMiniHeatmap` (§9.3), `markCompleted`, return `completed`. `passed = correct ≥ passThreshold(total, quiz.passRatio)`; the `SessionResult` handed to `onSessionResult` carries `hash = session.chunkHash`, `questionIds`, `correct`, `total`.

### 6.3 `ensureReconciled(root, opts)` (D10)

Today `reconcileProgress` only runs inside `scanRepo`; every other command shows pre-pull progress. New shared op:

```ts
export async function ensureReconciled(root: string, opts?: { config?; env?; repoId?; now?: () => Date }):
  Promise<{ changes: ReconcileChange[]; deferred: string[] }>
```
1. Load `chunks.json` and `progress.json` (no scan). If `reconcileSnapshotHashes(chunks, progress)` is empty (the common case; it also covers aliases) → return. **No lock, no write, no parsing:** one JSON read, so `get_map`/`get_status` stay fast.
2. Otherwise, for each affected leaf compute current fingerprints with a new `SourceReader.fingerprints(chunk)` (re-chunks that file only; `null` unless the working-tree hash and ranges equal `chunks.json`, the same gate as `currentHash`). Leaves whose working tree diverges from `chunks.json` are **deferred** to the next scan (returned in `deferred`, not decayed with a wrong diff).
3. `withRepoLock`: reload progress, `reconcileProgress({ chunks, progress, oldFingerprints: snapshots by lastSeenHash, newFingerprints, cfg })`, write progress, `snapshots.put` the new fingerprints, return `changes`.

A missing snapshot gives `changeRatio = 1` (pessimistic, PLAN §10.11), same as scan. The function is idempotent: afterwards `lastSeenHash === contentHash`.

Wiring: `loadMapTree` and `getStatus` call it first (option `reconcile?: boolean`, default `true`, so tests can opt out); `startQuiz` calls it; the CLI `quiz` goes through `startQuiz`. `get_chunk_for_file` uses only `chunks.json` and needs nothing.

---

## 7. MCP tool contracts

Conventions follow M2: `guarded()`, `textResult()`, strict output schemas that copy fields explicitly, `INIT_MESSAGE` / `SCAN_MESSAGE`, refusals as `isError` results re-parsed with the strict schema (the SDK skips output validation on `isError`). Both tools are registered in `server.ts`; one `QuizSessions` (write-through cache, `origin: 'mcp'`) is created in `createToolContext` and swept at server start.

All strings below live in `mcp/src/tools/quiz-text.ts`. `{…}` are placeholders.

### 7.1 `start_quiz`

**Description (exact):**
> Start a comprehension quiz on one chunk of this repository. Pass `path` (a directory, file or symbol: the chunk that most needs review under it is picked) or `chunkId`; with neither, the whole repo is considered. Optional `count` shortens the quiz (default: the chunk's size, 3–7). Returns the first multiple-choice question. Ask the question to the user, do not guess the answer yourself. If your client can show a multiple-choice or selection UI, present the options as choices there; otherwise list them as A–D and let the user reply with a letter. Then call `submit_answer` with the option the user picked. The correct answer and explanation are revealed only after you submit.

**Input** (`z.strictObject`; the path/chunkId exclusivity is checked in the handler, because zod refinements are lost in the JSON Schema the client sees):
```ts
{ path?: string;      // describe: 'Directory, file or chunk-id prefix, relative to the repo root'
  chunkId?: string;   // describe: 'Exact leaf chunk id (aliases accepted)'
  count?: number;     // int 1..10; describe: 'Questions in this quiz; clamped to [quiz.minQuestions, the chunk size]'
  lang?: string }     // describe: 'Preferred question language, e.g. en, tr; default config questions.lang'
```
Annotations: `{ readOnlyHint: false, idempotentHint: false, openWorldHint: false }` (it persists a session file).

**Output** (`z.strictObject`):
```ts
{ initialized: boolean; scanned: boolean;
  status: 'started' | 'resumed' | 'refused' | null;
  reason: 'both_targets'|'unknown_chunk'|'not_leaf'|'no_match'|'no_quizzable_chunk'|'not_enough_questions'|'lang_invalid'|null;
  session: { id; chunkId; chunkTitle; path: string|null; total; answered; needed; expiresAt } | null;
  question: PublicQuestionView | null }
```

**Text, `started` / `resumed` (exact template):**
```
Quiz {started|resumed}: {path} › {chunkTitle}  (session {sessionId})
Question {position} of {total} · {needed} correct to pass · expires {expiresAt}
{resumed only: "Resumed an unfinished quiz: {answered} of {total} already answered. count and lang were ignored."}

{stem}

A) {options[0].text}
B) {options[1].text}
C) {options[2].text}
D) {options[3].text}

Ask the question to the user, do not guess the answer yourself. If your client can show a multiple-choice UI, present the four options as choices there; otherwise list them and let the user reply with A, B, C or D.
Then call submit_answer with { "sessionId": "{sessionId}", "questionId": "{questionId}", "displayIndex": <0-3> } (A=0, B=1, C=2, D=3).
```
`path` is omitted (with its ` › `) for chunks that have none.

**Text, refused:** `gotchea: no quiz started ({reason}). {message}`, where `message` is:
- `both_targets`: `Pass either path or chunkId, not both.`
- `unknown_chunk`: `No chunk with id "{chunkId}". Use get_map to list chunk ids.`
- `not_leaf`: `"{chunkId}" is a container, not a leaf. Pass it as path to quiz the best chunk inside it.`
- `no_match`: `No chunks match "{path}".`
- `no_quizzable_chunk`: `No chunk under "{path}" has enough questions yet (best candidate: {have} of {need}). Generate questions first: run "gotchea generate", or use the get_generation_tasks and save_questions tools.`
- `not_enough_questions`: `{chunkId} has {have} usable questions and needs {need}. Generate more first (see get_generation_tasks).`
- `lang_invalid`: `"{lang}" is not a valid language code.`
- not initialised / not scanned: the existing `INIT_MESSAGE` / `SCAN_MESSAGE`.

### 7.2 `submit_answer`

**Description (exact):**
> Submit the user's answer to the current quiz question. `displayIndex` is the position of the option the user picked, as shown by `start_quiz` or the previous `submit_answer` (A=0, B=1, C=2, D=3). Answers are final and must be given in order. Returns whether it was correct, the correct option, the explanation and the line references, then the next question. Ask the question to the user, do not guess the answer yourself. If your client can show a multiple-choice UI, present the options as choices there. After the last question this returns the result: pass/fail, the chunk's new colour and an updated mini heatmap.

**Input** (`z.strictObject`): `{ sessionId: string (regex qs_[0-9a-f]{16}), questionId: string, displayIndex: number (int 0..3) }`.
Annotations: `{ readOnlyHint: false, idempotentHint: true, openWorldHint: false }` (a resend of the same answer returns the same result).

**Output** (`z.strictObject`):
```ts
{ initialized: boolean; scanned: boolean;
  status: 'answered' | 'completed' | 'refused' | null;
  reason: 'unknown_session'|'session_expired'|'session_completed'|'chunk_changed'|'unknown_question'
        |'out_of_order'|'already_answered'|'question_unavailable'|null;
  repeat: boolean;
  sessionId: string | null;
  reveal: RevealView | null;                       // the question just answered; the ONLY place explanation/refs/correct* may appear
  progress: { answered: number; total: number; correct: number } | null;
  next: PublicQuestionView | null;                 // present iff status === 'answered'
  result: SessionResultView | null }               // present iff status === 'completed'
```

**Text, `answered`:**
```
{✅ Correct.|❌ Incorrect.} You chose {label(selected)}.
{incorrect only: "Correct answer: {label(correct)}) {correctText}"}
Explanation: {explanation}
{refs non-empty: "Look at: {formatRefs(refs)}"}

Score so far: {correct}/{answered} · question {answered} of {total} done

Next — question {next.position} of {next.total}:

{next.stem}

A) … B) … C) … D) …

Ask the question to the user, do not guess the answer yourself. If your client can show a multiple-choice UI, present the four options as choices there. Then call submit_answer with { "sessionId": "{sessionId}", "questionId": "{next.questionId}", "displayIndex": <0-3> }.
```
`formatRefs`: `src/math.ts L15–L18` (en dash), `src/math.ts ≈ L15–L18` when `approximate`; several refs joined by `, `.

**Text, `completed`** (after the same ✅/❌ + explanation block):
```
Quiz complete: {correct}/{total} correct (needed {needed}) — {PASSED|NOT PASSED}
{path} › {chunkTitle}: {emoji(before.color)} → {emoji(after.color)}  (R {pct(before.R)} → {pct(after.R)}){after.dueAt: " · green until {date(after.dueAt)}"}
{passed: "Next review is due when retrievability falls below {greenAt%}." | failed: "This chunk must be passed again; it stays red until then."}

Heatmap ({path}):
{renderMiniHeatmapText(result.heatmap, 'emoji')}
```
`pct(null)` is `–`. `renderMiniHeatmapText` is the shared layout used by the CLI and the MCP (§9.3). Example:
```
Quiz complete: 4/5 correct (needed 4) — PASSED
src/math.ts › clamp: 🟥 → 🟩  (R 0% → 100%) · green until 2026-10-19
Next review is due when retrievability falls below 85%.

Heatmap (src/math.ts):
► 🟩 clamp   🟥 mean   🟥 lerp   ⬜ round
Up: 🟨 src/math.ts · 🟥 src · 🟥 .
```

**Text, refused:** `gotchea: answer not recorded ({reason}). {message}`, where `message` is:
- `unknown_session`: `No active quiz session "{id}". Start one with start_quiz.`
- `session_expired`: `This quiz session expired after {ttl} minutes without an answer. Nothing was scored. Call start_quiz again.`
- `session_completed`: `This quiz is already complete. Call start_quiz for a new one.`
- `chunk_changed`: `The code in {chunk} changed during the quiz. Nothing was scored. Call start_quiz again.`
- `unknown_question`: `Question "{id}" is not part of this session.`
- `out_of_order`: `Answer question {position} of {total} first (questionId {id}).` (question ids are public)
- `already_answered`: `Question "{id}" was already answered; answers are final.`
- `question_unavailable`: `A question of this session is no longer available. Call start_quiz again.`

No refusal text contains a stem, option, explanation or key.

### 7.3 Other MCP changes
- `get_map`'s summary "next step" mentions the tool: `quiz çöz` → `quiz çöz (start_quiz)`. `EMOJI` is replaced by `HEAT[color].emoji` (§9).
- `get_status` and `get_map` call `ensureReconciled` through core (§6.3); no schema change.

### 7.4 Elicitation — evaluation of an optional path (D8)

**SDK support (read in `@modelcontextprotocol/sdk@1.32.1`):**
- `server.server.elicitInput(params, options?)` sends `elicitation/create`. Form mode takes `{ mode?: 'form', message, requestedSchema }`, where `requestedSchema` is a flat `{ type: 'object', properties, required }` of primitives. A single-choice field is a string with `oneOf: [{ const, title }]` (titled enum; `enum` + `enumNames` is the legacy form). The result is `{ action: 'accept' | 'decline' | 'cancel', content? }`, and the SDK validates `content` against `requestedSchema`.
- **Capability detection:** `server.server.getClientCapabilities()?.elicitation`. The SDK's schema normalises an empty `elicitation: {}` to `{ form: {} }` (backwards compatibility), and `elicitInput` throws `Client does not support form elicitation.` when `elicitation.form` is absent. Capabilities are known only after the `initialized` handshake, so detect **per call**, not at registration. A URL mode exists and is irrelevant here.

**Design, if enabled.** `ServerOptions.elicitation: 'off' | 'auto'` (default `'off'`; env `GOTCHEA_MCP_ELICIT=auto`). In `start_quiz`, when `'auto'` and `getClientCapabilities()?.elicitation?.form` is truthy:
1. Create or resume the session exactly as above.
2. Loop over the unanswered questions: `elicitInput({ message: "{previous reveal}\n\nQuestion {p} of {t}\n{stem}", requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Your answer', oneOf: [{ const: '0', title: 'A) …' }, …] } }, required: ['answer'] } }, { timeout: 600_000 })`.
3. `accept` → `submitAnswer` with `displayIndex = Number(content.answer)`; `decline`/`cancel` → `abandonQuiz` and return `Quiz cancelled. Nothing was scored.`
4. Return one final tool result: all reveals plus the §7.2 completed text.

*Pros:* the user answers in the client's native UI, and the model never sees a question before it is answered (a stronger guarantee than "please don't guess"). *Cons:* a long-running tool call (clients have tool timeouts, and the per-request `timeout` must be raised above the SDK's short default); hosts differ in how they render option titles and long stems; the agent can't discuss a question mid-quiz.

**Fallback (seamless, because sessions are server-side):** if the capability is missing, or `elicitInput` throws (method not found, timeout, transport error), return the standard §7.1 result for the *next unanswered question* with `status: 'resumed'`. The description's instructions then apply and nothing is lost.

**Verdict:** worth building as an experiment *after* the two-tool path is stable (implementation step 9). I have **not** verified which clients (Claude Code, Codex, Claude Desktop, Cursor) implement `elicitation/create` today, so it ships off by default and flips to `'auto'` only after a manual check on the target clients. The tool descriptions and the primary flow never depend on it.

---

## 8. CLI: `gotchea quiz [path|chunkId]`

```
gotchea quiz [target] [--count <n>] [--lang <code>] [--new]
```
- `target`: a path relative to the working directory, or a chunk id (contains `#`). It uses the same grammar and the same `toFilter` helper as `map [path]` (moved from `commands/map.ts` to `cli/src/target.ts`). A leaf chunk id (or alias) selects that chunk; anything else is a path. With no `target`, the whole repo.
- `--new`: don't resume an unfinished CLI session.
- No `--json`: a quiz is interactive, and an answer-free machine output has no use.
- Exit codes: 0 finished or quit by the user, 1 refused (nothing to quiz, lock timeout), 2 usage/config errors (as `generate`).

### 8.1 `AnswerSource`: the testable seam

```ts
export type AnswerChoice = { kind: 'answer'; displayIndex: 0 | 1 | 2 | 3 } | { kind: 'quit' };

export interface AnswerSource {
  /** The presenter has already printed the position; this shows the prompt and returns the choice. */
  ask(question: PublicQuestionView): Promise<AnswerChoice>;
  confirm(message: string, initial?: boolean): Promise<boolean>;   // resume? generate now?
}
```
- **`ClackAnswerSource`** (`cli/src/quiz/clack-source.ts`): `ask` = `@clack/prompts#select({ message: stem, options: options.map((o) => ({ value: o.index, label: `${o.label}) ${o.text}` })) })`; `isCancel(v)` → `{ kind: 'quit' }`. `confirm` = `clack.confirm`. It is chosen when `process.stdin.isTTY && process.stdout.isTTY`; otherwise the command fails with `quiz needs an interactive terminal.` Clack writes to the real stdout, so the presenter uses `clack.log` / `note` in interactive mode and `ctx.out` otherwise.
- **`ScriptedAnswerSource`** (`cli/src/quiz/scripted-source.ts`, exported for tests): `new ScriptedAnswerSource(steps)`, where each step is a display index, `'quit'`, or a function `(question) => index` (so a test can pick the correct option by text). It records every question it was asked and every `confirm`.
- Injection: `ProgramDeps.answerSource?: AnswerSource` and `ProgramDeps.rng?: Rng`, the same pattern as `createProvider` for `generate`.

### 8.2 Flow (`cli/src/commands/quiz.ts`)
1. `requireRepoRoot`, `loadConfig`, build `QuizSessions` over `FsSessionStore` (`origin: 'cli'`), `sweep()`.
2. Unless `--new`: an active CLI session for the target scope with answers → `source.confirm('Resume your unfinished quiz on {chunk}? ({answered}/{total} answered)')`; yes → resume; no → `abandon` it.
3. `startQuiz(...)`. On `no_quizzable_chunk` / `not_enough_questions`, if the source is interactive: `confirm('"{chunk}" has {have} of {need} questions. Generate now?')` → run the existing `generateCommand` for that chunk (`--chunk`) and retry once; otherwise print the hint and exit 1.
4. Loop: the presenter prints `Question {p} of {t}` + stem; `source.ask(question)`; `quit` → `abandonQuiz`, print `Quiz abandoned, nothing was scored.`; `answer` → `submitAnswer`; the presenter prints ✅/❌, the correct option, the explanation and `Look at: src/math.ts L15–L18` (shown only now), then the next question.
5. On completion: the §7.2 summary with the CLI palette and `renderMiniHeatmapText(heatmap, 'ansi')`.

The presenter takes its painter from `HEAT[color].ansi` (§9.2). Everything user-visible goes through `ctx.out` in non-interactive mode so tests capture it; the interactive prompts are the only direct-stdout writers.

---

## 9. Heatmap colours

### 9.1 One classifier, derived from real retrievability
`colorFor(R, flags, { greenAt, yellowAt })` in `score/state.ts` stays the **only** place thresholds are applied (`chunkState` and `parentState` both call it). Colours are **computed at read time from R at the injected `now`**, never stored. R is `retrievability(S, t) = (1 + t / (9·S))⁻¹`, with `t` = days since `lastReviewedAt`.

| Colour | Condition (defaults `greenAt` 0.85, `yellowAt` 0.5) | Typical meaning |
|---|---|---|
| grey | no usable questions (`R = null`) | not quizzable yet |
| red | never passed (R = 0), or `mustRepass`, or `R < yellowAt` | new, failed, changed a lot, or forgotten |
| yellow | `yellowAt ≤ R < greenAt` | fading |
| green | `R ≥ greenAt` | fresh |

Time to leave green after a pass: S = 3 (first pass) → R = 0.85 after `9·3·(1/0.85 − 1) ≈ 4.8 d`, and 0.5 after `27 d`; S = 7.5 (second pass) → 11.9 d and 67.5 d. A pass shows **green at once** (R = 1), a fail shows red at once (`mustRepass`). Parents use `parentState`: the LOC-weighted mean of the children's R, with grey children skipped.

A static test asserts that `greenAt` / `yellowAt` are used as thresholds only in `score/state.ts` (plus config and the legend text in `render/tree-heatmap.ts`).

### 9.2 Presentation table: `map/palette.ts` (data only)
```ts
export const HEAT: Record<ChunkColor, { emoji: string; ansi: 'gray' | 'red' | 'yellow' | 'green'; label: string }> = {
  grey:   { emoji: '⬜', ansi: 'gray',   label: 'no questions' },
  red:    { emoji: '🟥', ansi: 'red',    label: 'red' },
  yellow: { emoji: '🟨', ansi: 'yellow', label: 'yellow' },
  green:  { emoji: '🟩', ansi: 'green',  label: 'green' },
};
```
- **MCP** (`get_map`, `submit_answer`): `HEAT[c].emoji`.
- **CLI** (`render/tree-heatmap.ts#paintFor`, the quiz presenter): `pc[HEAT[c].ansi]` (picocolors: `green` = ANSI 32, `yellow` = 33, `red` = 31, `gray` = 90) with the existing `●` glyph. With colours disabled (`--no-color`, `NO_COLOR`) the quiz heatmap appends the label letter and R (`●G 100%`), so state never depends on colour alone.
- Both existing tables (`EMOJI` in `get_map.ts`, the `paintFor` switch) are deleted and replaced by lookups. A test asserts that every `ChunkColor` has an entry and that the CLI and MCP renderers list the same colours in the same order for the same tree.

### 9.3 Mini heatmap (`map/mini-heatmap.ts`, pure)
```ts
export interface MiniHeatmap {
  focus: { id: string; title: string; path: string | null; color: ChunkColor; R: number | null };
  /** Leaves of the focus chunk's file in line order; at most 12, `omitted` counts the rest (the focus is always kept). */
  fileLeaves: { id: string; title: string; color: ChunkColor; R: number | null; isFocus: boolean }[];
  omitted: number;
  /** Ancestors, nearest first: the file, then modules up to the repo root. */
  ancestors: { id: string; title: string; kind: ChunkKind; color: ChunkColor; R: number | null }[];
}
export function buildMiniHeatmap(chunks: readonly Chunk[], states: ReadonlyMap<string, ChunkState>, chunkId: string): MiniHeatmap;
export function renderMiniHeatmapText(h: MiniHeatmap, mode: 'emoji' | 'ansi' | 'plain', paint?: (c: ChunkColor) => (s: string) => string): string;
```
The states passed in are the ones computed **after** scoring, from the same `computeTreeStates` call that `get_map` uses. That is why the e2e test can assert that the mini heatmap equals the next `get_map` (§10.6).

---

## 10. Test plan

All tests are hermetic: temp repo + `GOTCHEA_HOME`, injected `now`, injected `Rng`, no network, as in the existing helpers.

### 10.1 Unit tests (core)
- `quiz/select.test.ts` (**a 100% threshold for `packages/core/src/quiz/select.ts` is added to `vitest.config.ts`**, per PLAN §8): every error code; path vs chunkId vs alias; `sessionSize` clamps (below `minQuestions`, above `questionCount`, undefined); priority ordering (never passed > mustRepass > low R; fanIn weighting; deterministic id tiebreak; the result equals `selectionPriority` recomputed); `allGreen`; question selection (language tier, recent exclusion, oldest-asked first, reuse when too few fresh, type cap and fill, `not_enough_questions`, determinism under a seeded RNG, order shuffled).
- `quiz/session.test.ts`: schema strictness (extra key rejected, non-bijective permutation rejected, `answers` not a prefix rejected); every `recordAnswer` rule (order, repeat, already_answered, out_of_order, expiry); `sweep` rules; the session-id regex (`../x`, uppercase, wrong length → `null`, no fs access, asserted with a spy store).
- `quiz/views.test.ts`: the `toPublicView` key set is exactly the schema's; `assertPublicView` throws for an extra key (`correctIndex`, `explanation`, a nested `refs`, an unknown key); `toRevealView` ref mapping for single-range, multi-range (split), approximate (`chunkLines ≠` current) and v1-migrated (`refs: []`).
- `map/palette.test.ts`, `map/mini-heatmap.test.ts`: exhaustive palette; the focus is kept when truncating; ancestor order; text snapshots for emoji/ansi/plain.
- `score/` (extend): `fanInFactor`, and `selectionPriority` results unchanged (old vs new value table); `generate/tasks.test.ts` still green with `fanInFactor`.
- Colour boundary table through the real stack (`chunkState`): R exactly `greenAt` → green, `greenAt − ε` → yellow, exactly `yellowAt` → yellow, below → red; `mustRepass` with R = 0.99 → red; grey without questions. Plus the static test that thresholds are applied only in `score/state.ts` (§9.1).

### 10.2 Statistical uniformity of the correct display index (D2)
`test/quiz/permutation-uniformity.test.ts`:
1. **Unit:** for each stored key `o ∈ {0,1,2,3}`, draw `N = 20 000` permutations with `seededRng(0xC0FFEE + o)` and count `perm.indexOf(o)` per display slot. Pearson `χ² = Σ (obs − N/4)² / (N/4)` with 3 degrees of freedom must be `< 16.27` (p = 0.001). The seed is fixed, so the test is deterministic and never flaky; the threshold documents the significance.
2. **Joint:** all 24 permutations over `N = 48 000` draws, `χ²(23) < 49.73` (p = 0.001); and every output is a bijection of `[0..3]`.
3. **Real RNG:** the same as (1) with `cryptoRng`, `N = 40 000`, threshold `χ² < 25` (false-failure probability ≈ 1.5·10⁻⁵ per key).
4. **End to end, adversarial keys:** a fixture whose 20 questions all have `correctIndex = 0`, then all `= 3`, then a heavy skew (`[1,1,1,2,…]`). Run `startQuiz` 4 000 times with a seeded RNG (5 questions per session), compute `correctDisplayIndex` from each session's permutation and the pool, and require `χ²(3) < 16.27` over all questions in all sessions. This is the contract: uniform for *any* key distribution.
5. **Injection works:** an RNG stub that always returns 0 yields exactly the permutation that Fisher–Yates produces with `j = 0` at every step (asserted literally), proving the RNG is consulted; `int` is called 3 times per permutation with arguments 4, 3, 2.
6. **Per-question independence:** across 5 000 sessions of 5 questions, the display indexes of questions 1 and 2 are independent (`χ²(9) < 27.88`, p = 0.001, on the 4×4 contingency table).

### 10.3 No-leak test over all pre-submit outputs (PLAN §6; extends `mcp/test/safety.test.ts`)
1. **Seed with sentinels:** the fixture pool gets questions with stem `STEM-SENT-n`, options `OPT-n-A..D`, explanation `EXPL-SENT-n`, and refs that map to known lines (so an `L<n>` citation or an absolute line is detectable).
2. **Pre-submit surface:** every result of `start_quiz` (by path, by chunkId, with `count`, resumed, and every refused variant), every `next` block of `submit_answer`, every refused `submit_answer` (unknown session, unknown question, out of order, bad index, expired, chunk changed), `get_map`, `get_status`, `get_generation_tasks`, and `listTools` (descriptions, input and output schemas).
3. **Assertions:**
   - **Key check:** collect every object key at any depth in each `structuredContent`; none may be in `FORBIDDEN_KEYS`, **except** under the `reveal` subtree of a `submit_answer` result whose `status` is `answered`/`completed` (a path-based exemption, not a tool-based one).
   - **Schema check:** each tool's `outputSchema` property tree contains no forbidden key outside `submit_answer.reveal`.
   - **Value check:** the concatenated text and structured content of the pre-submit surface contains no `EXPL-SENT-` and none of the `Look at` / ref-derived line strings; flagged and stale sentinel questions never appear in a quiz.
   - **Timing:** the transcript is split at each `submit_answer`; the reveal for question *k* appears in no result returned before the answer to *k*.
   - **Positional sanity:** over 200 seeded sessions the correct option's text appears at ≥ 3 distinct display indexes, and the option order differs from the stored order in at least one question.
   - **Strict-layer injection:** with `toPublicView` patched to add `correctIndex`, `assertPublicView`, the ops layer and the SDK's output validation each fail the call (three separate tests, one per layer).
   - **Description check:** both tool descriptions contain the sentence `Ask the question to the user, do not guess the answer yourself` and the word "multiple-choice". The existing name check for `correctIndex` / `explanation` skips only `submit_answer`'s output schema, by path (`reveal`).
4. **CLI:** a `ScriptedAnswerSource` with a leak probe: at every `ask()` it snapshots the captured stdout so far and asserts there is no `EXPL-SENT-` and no `Look at`. The scripted run answers wrongly at least once, so the reveal path is exercised after the probe.
5. **Session file:** after `startQuiz`, the persisted `sessions/<id>.json` passes `SessionSchema` and contains no sentinel, no `correctIndex`, and no stem or option text.

### 10.4 Crash recovery (`core/test/quiz/session-recovery.test.ts`, `mcp/test/quiz-recovery.test.ts`)
1. **Restart mid-session:** manager A (`FsSessionStore`) starts a 5-question session and answers 2; discard A (empty cache: a crash/restart); manager B with the same store answers questions 3–5. The options B renders for question 3 equal what A would have shown (permutation persisted), the final `progress.history` has one entry, and `S = initialStability`.
2. **Crash between scoring and completion mark:** an injected store that throws on the `completed` `put` (once). The last `submitAnswer` fails after `progress.json` was written; resending it returns `repeat: true` with the same result, `history.length === 1`, and S not multiplied twice.
3. **Torn/corrupt files:** a leftover `qs_….json.123.tmp`, a truncated session JSON and a non-schema JSON in `sessions/`: `startQuiz` and `sweep` succeed, `get` returns `null`, `submit_answer` reports `unknown_session`, and corrupt/tmp files are removed once older than 1 h.
4. **Expiry and invalidation:** advance the injected clock past `sessionTtlMinutes` → `session_expired`, progress untouched. Edit the chunk and rescan mid-session → `chunk_changed`, session `expired`, progress untouched.
5. **Retention:** completed and abandoned sessions older than `sessionRetentionDays` are deleted by `sweep`; younger ones and active ones stay.
6. **Real process kill (skipped until `pnpm -r build`, like `stdio.test.ts`):** spawn `dist/bin.js` via `StdioClientTransport`, `start_quiz`, answer one question, `SIGKILL` the child, spawn a new server on the same `GOTCHEA_HOME`, call `submit_answer` for question 2 with the old `sessionId`. It succeeds.
7. **Resume-or-create:** `start_quiz` twice with no answers → the first session is `abandoned` and one active session remains; with ≥ 1 answer → `status: 'resumed'`, same id.

### 10.5 Concurrent CLI + MCP lock test (`core/test/store/repo-lock.test.ts`, `core/test/quiz/lock-concurrency.test.ts`)
Child processes can't import TypeScript sources under vitest, so `packages/core/scripts/build-test-workers.mjs` (a vitest `globalSetup` entry next to `copy-wasm.mjs`) bundles `src/store/repo-lock.ts` and a tiny worker into `packages/core/test/.workers/*.mjs` with esbuild (added as an explicit root devDependency; it is already allow-listed in `pnpm-workspace.yaml`).
1. **Mutual exclusion across processes:** 6 child processes × 25 iterations each take `withRepoLock`, read a counter file, sleep a random 0–5 ms, write counter + 1, and append `enter`/`exit` timestamps to a log opened with `O_APPEND`. Expect counter = 150 and **no overlapping `[enter, exit]` intervals**. A **control run** with the lock disabled (`--no-lock`) must lose updates (counter < 150), proving the test can fail.
2. **Stale handling:** a `.lock` with a dead pid on this host → acquired immediately; a fresh mtime and a live pid → `LockTimeoutError` after a short `timeoutMs`, `holder` populated; an old mtime and a live pid (heartbeat stopped) → broken and acquired; an empty file < 5 s old → waits, > 5 s → broken; two waiters racing to break the same stale lock → exactly one wins and neither deletes the other's fresh lock (`.lock.break`); release never deletes a lock whose token isn't ours.
3. **Re-entrancy and release:** nested `withRepoLock` for one repoId doesn't deadlock; `fn` throwing releases the lock; the heartbeat timer is `unref()`ed (the process exits); an `AbortSignal` aborts a wait.
4. **Real operations, interleaved:** in one process, `Promise.all` of (a) `runScan` (the CLI path) after editing a file, (b) MCP `save_questions` for another chunk, (c) a completing MCP `submit_answer` for a third; plus (d) a **child process** running the same scan through the built `dist/index.js` when present (`describe.skipIf(!built)`). Afterwards: `chunks.json` parses and matches a fresh scan, both new questions are in their pools, `progress.history` has the session entry, no `.lock` remains, and no operation saw a `LockTimeoutError`.
5. **Hold-time bound:** `scanRepo` on a 200-file fixture holds the lock for less than 25 % of its wall time (walking and parsing run outside the lock; this guards against regressing to a coarse lock).
6. **Lock coverage (static):** `lock-coverage.test.ts` per §5.4.
7. **Reconcile under contention:** two `ensureReconciled` calls racing after a simulated pull apply the decay once (`lastSeenHash` updated, S decayed once), not twice.

### 10.6 End to end (`mcp/test/quiz-e2e.test.ts`, `cli/test/quiz.test.ts`)
**MCP flow** on the `small-repo` fixture, with an in-memory client/server, injected `now` and seeded `rng`:
1. `initConfig` (init), then the `scan` tool.
2. `get_map` → the target leaf is ⬜ grey (`okQuestions: 0`).
3. `get_generation_tasks` → `save_questions` with a valid batch (the test knows each stem's correct option **text**) → `get_map` → the leaf is 🟥 red, R = 0 (M2 D8).
4. `start_quiz({ chunkId })` → public question 1 (`assertPublicView` passes; no forbidden keys).
5. Loop: pick the option whose `text` equals the known correct text; `submit_answer` → `reveal.correct === true`; the last call returns `status: 'completed'`, `passed: true`, `before.color === 'red'`, `after.color === 'green'`, `after.R === 1`, `result.heatmap.focus.color === 'green'`.
6. `get_map` → the leaf is now 🟩, **a changed colour versus step 3**; the file/module/root ancestors equal `result.heatmap.ancestors` (one colour function, the same states); `get_status` shows one fewer red leaf.
7. **Failing variant:** answer enough questions wrongly to miss `passThreshold` → `passed: false`, `after.color === 'red'`, `progress.chunks[id].mustRepass === true`, `stability = max(minStability, …)`.
8. **Decay over time:** advance the injected clock by 10 days → `get_map` shows the leaf 🟨 (S = 3: R(10) ≈ 0.73); by 40 days → 🟥 (R ≈ 0.40). These come from real retrievability; no colour is stored.
9. **Pull simulation:** change the leaf's hash in `chunks.json` (as a teammate's pull would) and call `get_map` without scanning: `ensureReconciled` decays progress (`lastSeenHash` updated) and the colour reflects it.

**CLI flow** (`createProgram(io, { answerSource: scripted, rng })`): `init → scan → (seed questions through core) → map` shows the leaf red with `· N q`; `quiz src/math.ts#clamp` with a `ScriptedAnswerSource` choosing the correct options by text → the output contains `Quiz complete` and `PASSED`, and under `--no-color` the `●R 0% → ●G 100%` marks; then `map --json` shows `state.color === 'green'`. Additional cases: `quit` mid-way → exit 0, session `abandoned`, progress untouched; `quiz` again with a leftover active session → the scripted `confirm` is asked; no questions → exit 1 with the generate hint; non-TTY without an injected source → a clear error.

### 10.7 Elicitation (only when step 9 is built)
An in-memory client declaring `capabilities: { elicitation: { form: {} } }` with a `setRequestHandler(ElicitRequestSchema, …)` that answers from a script: a full quiz in one `start_quiz` call; `decline` mid-way abandons the session; a handler that throws falls back to the §7.1 result with `status: 'resumed'`; a client without the capability never receives `elicitation/create` (spy); `elicitation: 'off'` ignores the capability.

---

## 11. Files to create or modify, and implementation order

### 11.1 Create
```
packages/core/src/store/repo-lock.ts
packages/core/src/store/keyed-lock.ts
packages/core/src/store/session-store.ts
packages/core/src/quiz/select.ts
packages/core/src/quiz/session.ts
packages/core/src/quiz/views.ts
packages/core/src/map/palette.ts
packages/core/src/map/mini-heatmap.ts
packages/core/src/ops/reconcile.ts
packages/core/src/ops/quiz.ts
packages/core/scripts/build-test-workers.mjs
packages/core/test/store/repo-lock.test.ts
packages/core/test/store/lock-coverage.test.ts
packages/core/test/store/session-store.test.ts
packages/core/test/helpers/lock-worker.ts            (bundled to test/.workers/ by the script above)
packages/core/test/quiz/select.test.ts
packages/core/test/quiz/session.test.ts
packages/core/test/quiz/views.test.ts
packages/core/test/quiz/permutation-uniformity.test.ts
packages/core/test/quiz/session-recovery.test.ts
packages/core/test/quiz/lock-concurrency.test.ts
packages/core/test/map/palette.test.ts
packages/core/test/map/mini-heatmap.test.ts
packages/core/test/ops/reconcile.test.ts
packages/core/test/ops/quiz.test.ts
packages/mcp/src/tools/start_quiz.ts
packages/mcp/src/tools/submit_answer.ts
packages/mcp/src/tools/quiz-text.ts
packages/mcp/src/tools/quiz-elicit.ts                (step 9)
packages/mcp/test/quiz.test.ts
packages/mcp/test/quiz-e2e.test.ts
packages/mcp/test/quiz-recovery.test.ts
packages/mcp/test/quiz-elicit.test.ts                (step 9)
packages/cli/src/commands/quiz.ts
packages/cli/src/target.ts                           (toFilter extracted from map.ts)
packages/cli/src/quiz/answer-source.ts               (AnswerSource, AnswerChoice)
packages/cli/src/quiz/clack-source.ts
packages/cli/src/quiz/scripted-source.ts
packages/cli/src/render/quiz.ts                      (presenter + mini heatmap rendering)
packages/cli/test/quiz.test.ts
.changeset/<name>.md                                 (minor: gotchea, gotchea-core, gotchea-mcp)
M3_SUMMARY.md                                        (at the end of the milestone, like M2_SUMMARY.md)
```

### 11.2 Modify
```
packages/core/src/score/state.ts                     + fanInFactor(); selectionPriority uses it
packages/core/src/generate/tasks.ts                  use fanInFactor instead of the inline weight
packages/core/src/store/question-store.ts            import KeyedLock from keyed-lock.ts
packages/core/src/store/types.ts                     + SessionStore
packages/core/src/store/paths.ts                     + lockBreak (`.lock.break`) in UserPaths
packages/core/src/config/schema.ts                   quiz.minQuestions, sessionTtlMinutes, sessionRetentionDays
packages/core/src/scan/scan.ts                       steps 4-6 inside withRepoLock; steps 1-3 outside
packages/core/src/generate/save.ts                   re-check the hash gate + insert inside withRepoLock
packages/core/src/generate/source.ts                 + SourceReader.fingerprints(chunk)
packages/core/src/map/load.ts, ops/status.ts         call ensureReconciled (option reconcile, default true)
packages/core/src/model/question.ts                  remove QuestionPublic (unused)
packages/core/src/index.ts, internal.ts              exports per §1.1
packages/core/test/generate/tasks.test.ts            order unchanged (guards the refactor)
packages/core/test/score/score.test.ts               + fanInFactor
packages/core/test/map/ops.test.ts                   reconcile-on-read cases
vitest.config.ts                                     100% threshold for packages/core/src/quiz/select.ts; globalSetup + build-test-workers
package.json (root)                                  devDependency: esbuild
packages/mcp/src/schemas.ts                          StartQuiz*/SubmitAnswer* input and output schemas
packages/mcp/src/server.ts                           register both tools
packages/mcp/src/context.ts                          QuizSessions (cache), rng/elicitation options, sweep at start
packages/mcp/src/tools/get_map.ts                    HEAT palette; next-step text mentions start_quiz
packages/mcp/test/safety.test.ts                     extended leak test (§10.3)
packages/mcp/README.md, packages/cli/README.md, README.md   document the two tools and `gotchea quiz`
packages/cli/src/program.ts                          register `quiz`; ProgramDeps { answerSource?, rng? }
packages/cli/src/commands/stubs.ts                   remove the `quiz` stub
packages/cli/src/commands/map.ts                     use target.ts
packages/cli/src/render/tree-heatmap.ts              paintFor → HEAT[c].ansi
packages/cli/test/e2e-fixtures.test.ts, map.test.ts  key checks extended
PLAN.md                                              tick M3 in §9; §10 new assumptions (lock design, session TTL, count rules)
```

### 11.3 Implementation order
Each step ends green on `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test`, and each is a reviewable commit.

1. **Lock first.** `keyed-lock.ts` (extract), `repo-lock.ts`, `paths.ts`, the worker build script, `repo-lock.test.ts`. Then wire `scanRepo` and `saveQuestions` and add `lock-coverage.test.ts`. This closes M2's cross-process gap before M3 adds more writers.
2. **Shared colour and priority.** The `fanInFactor` refactor (score + tasks), `map/palette.ts`, replace the two existing colour tables, `map/mini-heatmap.ts`. Tests: palette, mini-heatmap, colour boundaries.
3. **Reconcile on read.** `SourceReader.fingerprints`, `ops/reconcile.ts`, wiring into `loadMapTree` / `getStatus`; tests including the pull simulation and the race (§10.5 item 7).
4. **Views and selection.** `quiz/views.ts` (types, schemas, guard) and `quiz/select.ts` with 100% coverage; the config additions.
5. **Sessions.** `store/types.ts`, `session-store.ts`, `quiz/session.ts` (types, schema, `Rng`, permutations, `QuizSessions`); the uniformity tests (§10.2 items 1–3, 5) and the session tests.
6. **Engine.** `ops/quiz.ts` (`startQuiz`, `submitAnswer`, `abandonQuiz`, `QuizOpsDeps`); engine tests including recovery (§10.4 items 1–5, 7), end-to-end uniformity (§10.2 items 4, 6) and the lock-interleaving test (§10.5 items 4–5). Exports in `index.ts` / `internal.ts`.
7. **MCP tools.** `schemas.ts`, `quiz-text.ts`, `start_quiz.ts`, `submit_answer.ts`, `server.ts`, `context.ts`, `get_map.ts`; the extended leak test (§10.3) and the MCP e2e (§10.6). **Ship point: an agent can quiz a user end to end with no API key.**
8. **CLI.** The `target.ts` extraction, `answer-source.ts`, `scripted-source.ts`, `clack-source.ts`, `render/quiz.ts`, `commands/quiz.ts`, `program.ts`; CLI tests (§10.3 item 4, §10.6), and the generate-now offer last.
9. **Elicitation experiment (optional).** `quiz-elicit.ts`, the `elicitation` option, tests (§10.7), and a manual check on the target clients before changing the default.
10. **Docs and close-out.** READMEs, changeset, PLAN.md ticks and new §10 assumptions, the built-dist tests (§10.4 item 6, §10.5 item 4d) run after `pnpm -r build`, M3_SUMMARY.md.

---

## 12. Open questions for the owner

1. **Chrome language.** The new quiz text is English, while `get_map` prints Turkish counts (`soru`, `quiz çöz`). Should interface strings follow `questions.lang`, a separate `ui.lang`, or stay English? D11 centralises them, so it is one file either way.
2. **"Ready but never quizzed".** D7 keeps such leaves red (R = 0), so a freshly generated repo flips from all grey to all red. A distinct marker (a dot or `new`) without a fifth colour needs a field on `MapNode` and the MCP map schema. Worth doing before M4's treemap?
3. **Short sessions.** `count` can shorten a quiz to `minQuestions` (3), and a pass still multiplies S by 2.5. Is a floor of 3 enough, or should sub-band sessions count as "practice" (a history entry, no S change)?
4. **Session TTL and retention.** 120 minutes idle and 7 days retention are guesses; an agent that stops mid-quiz for a day loses the session. Acceptable?
5. **Worktrees.** The lock and progress are per repoId, so two worktrees of one remote share both, which is right for progress and slightly coarse for question files (the monorepo repoId question, PLAN §10.55, is unchanged). Keep?
6. **Flagged-question review.** There is still no tool to inspect or unflag them (M2 open question 3). It isn't needed for M3's flow; confirm it stays deferred.
7. **Elicitation default.** Stay `off` until verified on Claude Code and Codex, or ship `auto` from day one given the seamless fallback?
8. **Still open from M2 and untouched by M3:** the blind-verify model, the pool cap, and partial staleness (M2 open questions 4–6).
