# gotchea — M2 Design (Question Generation)

Status: **design, approved scope = PLAN §9 "M2"**. No production code is written by this document.
Inputs: PLAN.md §3, §6, §9, §10 (esp. 13, 19, 21, 26, 48, 55, 57), M1_SUMMARY.md, the current tree under `packages/`.

Current state this design builds on (verified in the repo, newer than M1_SUMMARY's "Known limitations"):
- MCP already has `scan`, `get_map`, `get_chunk_for_file`, `get_status` (`packages/mcp/src/tools/*`), strict output schemas (`packages/mcp/src/schemas.ts`) and a leak test (`packages/mcp/test/safety.test.ts`).
- `QuestionPrivate`, `QuestionsFile`, `FsQuestionStore` live behind `gotchea-core/internal` (`packages/core/src/internal.ts`). MCP must keep importing only `gotchea-core`.
- `okQuestionCounts()` and `loadMapTree()` already feed `okQuestions` into the map; `chunkState()` already returns `red / R=0` for a leaf with ok questions and no pass.

---

## 0. Decisions fixed by this document

| # | Decision |
|---|---|
| D1 | **Refs are chunk-relative** (user decision, M1 open question #4). See §2.3. Supersedes PLAN §3 `refs: LineRange[]` and the "M2 must rebase refs on move" note in PLAN §10.48. |
| D2 | **Question format stays PLAN §3**: one stem, exactly 4 options, exactly one correct option (`correctIndex`). `type` is the PLAN topical type (`behavior · edge_case · purpose · impact · bug_detection`). Multi-select / true-false are **not** added in M2: they would change session scoring and permutation (M3) and the leak/skew rules below. |
| D3 | `status` becomes `'ok' \| 'stale'`; flagging moves to a separate `flagged: boolean` (a stale question can also be flagged). |
| D4 | `lang` widens from `'tr' \| 'en'` to a language code (`/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`, e.g. `en`, `tr`, `de`, `pt-BR`). Default stays `en`. |
| D5 | The LLM/host submits a **raw** question; the server stamps every identity/metadata field. The raw and stored schemas use the same names for shared fields (`correctIndex`, `explanation`) so there is one vocabulary. |
| D6 | One write path: CLI `generate` and MCP `save_questions` both call `core/generate/save.ts#saveQuestions`. |
| D7 | MCP never calls an external LLM. Blind verify runs only in CLI `generate`. |
| D8 | Map colours are unchanged in M2: a leaf with ≥1 usable question is `red` (never passed, R = 0) via existing `chunkState`. M3 owns colour work. |

---

## 1. File layout

All new core code is under `packages/core/src/generate/` (PLAN §2 location). Tests mirror `src/` under `packages/core/test/generate/` (PLAN §10.40).

```
packages/core/src/generate/
├─ schema.ts            RawQuestionSchema, RawBatchSchema, StoredQuestionSchema (= QuestionPrivate v2),
│                       QuestionsFileV2Schema, RAW_BATCH_JSON_SCHEMA (provider-facing JSON Schema), LangCodeSchema
├─ chunk-code.ts        readChunkCode(root, chunk) → { lines, lineCount, numbered }, toAbsoluteLine(chunk, ref),
│                       currentChunkHash(root, chunk, cfg)   (re-chunks one file from the working tree)
├─ context.ts           importSignatures(root, chunk, chunks) → ImportSignature[]
├─ tasks.ts             needsGeneration(), prioritizeChunks(), buildGenerationTask()  (shared by CLI + MCP)
├─ prompt.ts            PROMPT_VERSION='p1', buildSystemPrompt(), buildUserPrompt(task), renderHostInstructions(task),
│                       buildVerifyPrompt(...)
├─ text.ts              normalizeText(), contentTokens(), STOPWORDS (en + tr), citations(explanation)
├─ dedupe.ts            trigrams(), jaccard()
├─ validate.ts          validateBatch(input) → ValidationResult  (pure)
├─ verify.ts            blindVerify(provider, task, question, seed) → VerifyOutcome
├─ save.ts              saveQuestions(root, input, opts) → SaveResult   (hash gate + validate + [verify] + persist)
├─ generate.ts          runGenerate(root, opts) → GenerateReport        (CLI orchestration over providers)
└─ providers/
   ├─ provider.ts       LLMProvider, JsonRequest, ProviderError, ProviderName (re-export from config)
   ├─ anthropic.ts      AnthropicProvider (official @anthropic-ai/sdk, injectable client)
   ├─ openai-chat.ts    OpenAIChatProvider: shared Chat Completions-over-fetch implementation (injectable fetch)
   ├─ openai.ts         createOpenAIProvider()            → OpenAIChatProvider(baseURL=api.openai.com)
   ├─ openai-compatible.ts createOpenAICompatibleProvider() → OpenAIChatProvider(baseURL required)
   └─ factory.ts        createProvider(name, { config, env, model?, fetch?, anthropicClient? })
```

Other files touched:

| Path | Change |
|---|---|
| `packages/core/src/model/question.ts` | v2 types (§2.2): `QuestionRef`, `QuestionPrivate`, `QuestionsFile { version: 2 }`, `QuestionLang = string`. |
| `packages/core/src/store/question-store.ts` | v1→v2 upgrade on read, `chunkId` check on read (PLAN §10.55), in-process per-chunk mutex for `update()` (§9). |
| `packages/core/src/store/types.ts` | `QuestionStore.update(chunkId, fn)` (§9). |
| `packages/core/src/config/schema.ts` | `questions.lang` → `LangCodeSchema`; new `questions.leakWordOverlap` (0.6), `questions.leakMargin` (0.25), `questions.lengthSkewMinChars` (8), `questions.maxBatch` (20), `questions.minLoc` (5), `generate.maxChunksPerRun` (10). |
| `packages/core/src/map/question-counts.ts` | usable = `status==='ok' && !flagged && chunkHash === chunk.contentHash` (§9). |
| `packages/core/src/index.ts` | export public generate API (§1.1). |
| `packages/core/package.json` | add dependency `@anthropic-ai/sdk` (loaded with dynamic `import()` from `factory.ts` only). |
| `packages/cli/src/commands/generate.ts` | new; remove `generate` from `commands/stubs.ts`; register in `program.ts`. |
| `packages/cli/src/program.ts` | `createProgram(io, deps?: { createProvider?: typeof createProvider })` for test injection. |
| `packages/cli/src/render/tree-heatmap.ts` | leaves with `okQuestions > 0` print `· N q`. |
| `packages/mcp/src/tools/get_generation_tasks.ts` | new. |
| `packages/mcp/src/tools/save_questions.ts` | new. |
| `packages/mcp/src/schemas.ts` | inputs/outputs for both tools. |
| `packages/mcp/src/server.ts` | register both tools. |
| `packages/mcp/src/tools/get_map.ts` | text renderer shows `Σ N soru` on non-leaf nodes too (§9). |

### 1.1 Public vs internal API (PLAN §6, §10.57)

`gotchea-core` (public) gains: `RawQuestionSchema`, `RawBatchSchema`, `RawQuestion` (type), `LangCodeSchema`, `getGenerationTasks`, `GenerationTask`, `saveQuestions`, `SaveInput`, `SaveResult`, `RejectionReason`, `runGenerate`, `GenerateReport`, `createProvider`, `LLMProvider`, `ProviderError`, `toAbsoluteLine`, `PROMPT_VERSION`.
None of these *return* a stored question. `RawQuestion` contains an answer key but is input-only.

`gotchea-core/internal` gains: `StoredQuestionSchema`, `validateBatch` (tests), `QuestionRef`.

---

## 2. Schemas (`generate/schema.ts`, zod 4)

### 2.1 Raw question (LLM output and `save_questions` input)

```ts
export const QUESTION_TYPES = ['behavior', 'edge_case', 'purpose', 'impact', 'bug_detection'] as const;

export const RefSchema = z.strictObject({
  start: z.number().int(),          // 1-based line inside the numbered chunk code
  end: z.number().int(),            // inclusive; range checks are validator rules, not schema rules (§4)
});

export const RawQuestionSchema = z.strictObject({
  type: z.enum(QUESTION_TYPES),
  stem: z.string().trim().min(10).max(600),
  options: z.tuple([Opt, Opt, Opt, Opt]),          // Opt = z.string().trim().min(1).max(300)
  correctIndex: z.number().int().min(0).max(3),
  explanation: z.string().trim().min(20).max(1200), // must cite lines as L<n> or L<n>-L<m> (§4)
  refs: z.array(RefSchema).min(1).max(5),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const RawBatchSchema = z.strictObject({ questions: z.array(z.unknown()).min(1) });
```

- `RawBatchSchema` keeps items as `unknown` so one malformed item is reported as `schema_invalid` at its index instead of failing the whole batch.
- `RAW_BATCH_JSON_SCHEMA` is a hand-written JSON Schema for providers: `{questions: RawQuestion[]}` with `additionalProperties: false`, every property `required`, enums and `options` as `array` of 4 strings. It has **no** length or numeric bounds, because structured-output engines support only a subset of JSON Schema. zod enforces the bounds after the call. A unit test asserts that the JSON Schema and `RawQuestionSchema` have the same property sets.

### 2.2 Stored question (`QuestionPrivate` v2, internal only)

```ts
export const StoredQuestionSchema = z.strictObject({
  id: z.string().regex(/^q_[0-9a-f]{12}$/),
  chunkId: z.string(),
  chunkHash: z.string(),             // chunk contentHash at generation time
  chunkLines: z.number().int().min(0), // raw line count of the numbered code at generation time (drift detection, §2.3); 0 = unknown (migrated)
  type: z.enum(QUESTION_TYPES),
  stem: z.string(),
  options: z.tuple([z.string(), z.string(), z.string(), z.string()]),
  correctIndex: z.number().int().min(0).max(3),
  explanation: z.string(),
  refs: z.array(RefSchema),          // chunk-relative; [] only for migrated v1 questions (§9)
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  lang: LangCodeSchema,
  generatedBy: z.string(),           // 'host:<mcp client name>' | 'anthropic:<model>' | 'openai:<model>' | 'openai-compatible:<model>'
  promptVersion: z.string(),         // 'p1'
  status: z.enum(['ok', 'stale']),
  flagged: z.boolean(),
  verifiedBy: z.string().nullable(), // '<provider>:<model>' when blind verify ran, else null
  createdAt: z.string().datetime(),
});
export const QuestionsFileV2Schema = z.strictObject({ version: z.literal(2), chunkId: z.string(), questions: z.array(StoredQuestionSchema) });
```

- **id** = `'q_' + sha256(chunkId + '\n' + chunkHash + '\n' + normalizeText(stem)).hex.slice(0, 12)`. It is deterministic, so a retried identical submission collides and is rejected as `duplicate_stored`.
- **Stamped by `saveQuestions`, never taken from the raw input:** `id, chunkId, chunkHash, chunkLines, lang, generatedBy, promptVersion, status='ok', flagged, verifiedBy, createdAt`.
- `QuestionPublic` is unchanged except that `lang: string`.

### 2.3 Chunk-relative refs (decision D1)

1. The **numbered code** of a chunk is the concatenation of its raw source lines over `chunk.ranges` in order, numbered **1..chunkLineCount** with no gaps. `chunkLineCount = Σ (range.end − range.start + 1)`. Line 1 is the chunk's first line, not the file's. For multi-range chunks (`~top`, `~body`), an **unnumbered** separator line `      ┆` is rendered between ranges. It consumes no number.
2. Every question stores `chunkId` and `chunkHash` (§2.2). Refs and explanation citations use the numbered-code coordinates.
3. If a rescan finds the same `contentHash` (unchanged, or moved within/between files, or renormalized), the refs stay valid with no rewrite. Absolute lines are computed **at display time only**: `toAbsoluteLine(chunk, ref)` walks `chunk.ranges`. For a single-range chunk this is exactly `chunk.ranges[0].start + ref − 1`. A move updates `chunk.ranges` in chunks.json, so display follows automatically. `applyScanDiff` needs no change for refs.
4. If the hash changed, the existing scan logic marks the questions `stale`. Refs are **never rebased**. Stale questions are not shown and are replaced by regeneration.

**Known caveat (accepted):** `contentHash` ignores comments, whitespace and blank lines (PLAN §4). An edit that only adds a comment *inside* the chunk keeps the hash but shifts raw lines, so refs can point a few lines off. Mitigation without breaking D1: `chunkLines` is stored. At display time (M3), if the current `chunkLineCount ≠ q.chunkLines`, refs are shown as approximate ("≈ L12") and clamped to the chunk. Refs are never rewritten.

---

## 3. Prompt spec (`generate/prompt.ts`)

`PROMPT_VERSION = 'p1'`, stored on every question. Any wording change bumps it. Prompts are pure functions of `GenerationTask`, so snapshot tests can cover them.

### 3.1 `GenerationTask` (built by `tasks.ts`, also the MCP payload)

```ts
interface GenerationTask {
  chunkId: string; chunkHash: string;
  path: string; title: string; sourceLang: string | null;   // 'typescript' | 'python' | ...
  lineCount: number;
  code: string;                       // numbered code, §2.3 (format: right-aligned number, ' | ', raw line; tabs kept)
  context: { imports: ImportSignature[]; enclosing: string | null };
  existingStems: string[];            // stems of the chunk's usable questions only (PLAN §6: stems only)
  count: number;                      // questions requested
  typePlan: QuestionType[];           // length = count
  questionLang: string;               // D4
}
interface ImportSignature { from: string; name: string; signature: string }
```

- **Import signatures (`context.ts`):** the chunk's file is parsed and its `ImportRef`s are taken. Only names that the chunk's lines reference are kept. Each one is resolved with the existing `resolveImport` to a repo file and then to the symbol chunk with that name. `signature` is that symbol's first non-blank raw line, plus following lines up to the first `{` or `:`, capped at 200 chars. Unresolvable (external) imports become `{from: specifier, name, signature: ''}`. The list is capped at 20 entries and 4000 chars. `enclosing` is the declaration line of the parent symbol for methods (e.g. `class SessionStore {`), else null.
- **Type plan:** cycle through `config.questions.types`, starting with the type least represented among the chunk's usable questions. Ties go to config order. With `count ≥ 3`, the plan must contain at least 3 distinct types.
- **Size guard:** chunks with `lineCount > 800` are not offered for generation (reported as `skipped: too_large` in CLI `--json`).

### 3.2 System prompt (static, so it is cacheable; the same text is embedded in `renderHostInstructions`)

Rules, verbatim intent:
1. Write `count` multiple-choice questions that test **understanding** of the numbered code: behaviour for specific inputs, edge cases, purpose/why, impact of a change, spotting a bug in a plausible modification. Follow `typePlan` order.
2. **No trivia**: never ask about line numbers, counts of lines/params, literal names, file names or formatting. A reader who understands the code must answer correctly, and a reader who only skimmed names must not.
3. Exactly 4 options, exactly one correct. Distractors must be **plausible** (realistic misreadings of the code) and of **similar length and grammatical form** to the correct option. Never use "all/none of the above", "both A and B" or letter references.
4. The stem must not contain or paraphrase the correct answer, and must not hint at which option is correct.
5. `explanation` says why the correct option is right and why each distractor is wrong, and **cites lines** as `L<n>` or `L<n>-L<m>`, using the numbers from the numbered code (1-based, chunk-relative).
6. `refs` lists the 1–5 line ranges a learner should reread, in the same coordinates.
7. Use the import signatures only as context. Questions are about the numbered code.
8. Do not repeat or rephrase any of `existingStems`.
9. Write stem, options and explanation in language `questionLang`. Keep code identifiers verbatim.
10. Output only JSON matching the schema (provider path) or call `save_questions` (host path).

### 3.3 User prompt

Sections in fixed order: `Chunk: <chunkId> (<sourceLang>, <lineCount> lines)` · `Imports:` signature list · `Enclosing:` · `Code:` fenced numbered code · `Existing questions (do not repeat):` stems · `Write <count> questions; types in order: <typePlan>; language: <questionLang>.`

### 3.4 Host instructions (`renderHostInstructions(task)`)

This is the system rules plus: the exact JSON shape of one raw question (the field list from §2.1), "call `save_questions` with `{chunkId, chunkHash, lang, questions}`", "fix rejected items using the returned reason codes and resubmit only those", and the PLAN §6 note: "Generate in a subagent or a separate session; the answers you write stay in your context."

---

## 4. Validator contract (`generate/validate.ts`, pure)

```ts
interface ValidateInput {
  items: unknown[];                    // raw batch items
  chunkLineCount: number;
  existing: { id: string; stem: string }[];  // usable + flagged questions of this chunk at the current hash
  cfg: QuestionsConfig;
}
interface ValidationResult {
  accepted: { index: number; question: RawQuestion }[];
  rejected: { index: number; reason: RejectionReason; detail: string }[];
}
```

Rules are evaluated per item **in the order below**. The first failing rule rejects the item (one reason per item). Batch-level dedupe compares against items already **accepted** earlier in the same batch.

**Text normalisation (`text.ts`):** `normalizeText(s)` = NFKC → lowercase → strip `` ` `` `'` `"` → collapse whitespace → trim → strip trailing `.,;:!?`.
`contentTokens(s)` = tokens matching `/[\p{L}\p{N}_$]+/gu` of the normalised text, minus a fixed stopword list (en + tr, ~150 words). Code identifiers of any length are kept (`n`, `hi`).
`overlap(o, stem) = |contentTokens(o) ∩ contentTokens(stem)| / |contentTokens(o)|`, or 0 when `o` has no content tokens.

| # | Code | Exact rule | `detail` template (never quotes option text or the key) |
|---|---|---|---|
| 1 | `schema_invalid` | `RawQuestionSchema.safeParse(item)` fails. | `"<path>: <zod message>"` of the first issue, e.g. `"options: expected 4 items"`. |
| 2 | `type_not_allowed` | `type ∉ cfg.types`. | `"type <t> is disabled in config"` |
| 3 | `options_not_distinct` | two options have equal `normalizeText`. | `"options <i> and <j> are identical"` |
| 4 | `meta_option` | an option matches `/\b(all|none|both|neither) of the (above|options)\b/i`, `/^(both|neither) [a-d] (and|nor) [a-d]$/i`, `/\boption [a-d]\b/i` (plus tr: `/hepsi|hiçbiri|yukarıdakiler/i`). | `"option <i> refers to other options"` |
| 5 | `answer_leak_marker` | stem matches `/\b(correct|right|true) (answer|option|choice)\b/i`, `/\banswer\s*[:=]/i`, `/\(\s*[a-d]\s*\)\s*$/i` or tr `/doğru (cevap|yanıt|seçenek)/i`. | `"stem names the answer"` |
| 6 | `answer_leak_stem` | **(a)** `normalizeText(correct)` has ≥ 4 chars, is a substring of `normalizeText(stem)`, and no distractor is; **or (b)** `overlap(correct) ≥ cfg.leakWordOverlap (0.6)` **and** `overlap(correct) − max_d overlap(d) ≥ cfg.leakMargin (0.25)`. | `"stem contains <p>% of the correct option's content words (max 60%)"` or `"stem contains the correct option verbatim"` |
| 7 | `answer_leak_options` | **(a)** some distractor `d` with `normalizeText(d).length ≥ 4` is a proper substring of `normalizeText(correct)` (the correct option is "a distractor plus a qualifier"); **or (b)** every distractor pair has trigram Jaccard ≥ 0.8 **and** the correct option has Jaccard < 0.5 to every distractor (odd one out). | `"correct option extends a distractor"` / `"distractors are near-identical; correct option is the odd one out"` |
| 8 | `length_skew` | `L(x) = normalizeText(x).length`, `m = mean(L(distractors))`, `r = L(correct) / max(m, 1)`. Reject if (`r > cfg.maxCorrectLengthRatio (1.4)` **or** `r < 1 / 1.4`) **and** `abs(L(correct) − m) > cfg.lengthSkewMinChars (8)`. | `"correct option is <r>x the mean distractor length (allowed 0.71–1.4)"` |
| 9 | `refs_out_of_range` | some ref has `start < 1`, `end < start` or `end > chunkLineCount`. | `"ref <k> L<s>-L<e> outside 1..<N>"` |
| 10 | `explanation_citation` | `citations(explanation)` is empty, **or** a cited line is outside `1..chunkLineCount`. Citation regex: `/\bL(\d+)(?:\s*[-–]\s*L?(\d+))?\b/g`. | `"explanation cites no line"` / `"explanation cites L<n> outside 1..<N>"` |
| 11 | `trivia` | stem matches any of: `/\b(which|what) line\b/i`, `/\bline number/i`, `/\bhow many (lines|characters|parameters|arguments|imports)\b/i`, `/\bwhat is the name of the (function|method|variable|class|file|module)\b/i`, `/\bwhich file\b/i`, tr `/kaçıncı satır|satır numarası|adı nedir/i`. | `"stem asks for trivia (<matched rule id>)"` |
| 12 | `duplicate_stored` | `jaccard(trigrams(stem), trigrams(e.stem)) ≥ cfg.dedupeJaccard (0.8)` for some stored `e` in `existing`. | `"near-duplicate of stored question <e.id> (J=<x>)"` (ids and stems are public) |
| 13 | `duplicate_batch` | the same test against stems of items accepted earlier in this batch. | `"near-duplicate of item <j> (J=<x>)"` |

**Threshold rationale (PLAN §10.19, all in config so they can be tuned on real output):**
- **Length skew 1.4, symmetric, 8-char floor.** "The longest option is correct" is the best-known test-wiseness cue. 1.4 is the PLAN/config value: a 40% gap is clearly visible when options are read side by side, and a well-written option set rarely exceeds it. "Shortest is correct" is the mirror cue, so the bound is symmetric. The 8-char absolute floor stops the rule from firing on short code-token options (`lo` / `hi` / `NaN`), where ratios are noisy and meaningless.
- **Leak 60% + 0.25 margin.** 60% is from PLAN §9. The margin is needed because questions about code legitimately reuse identifiers from the stem in every option (e.g. stem `"…for n > hi?"` with options `lo/hi/n/NaN`: the correct option `hi` and the distractor `n` both overlap 100%, so it is not a leak). A leak is only a leak if it *discriminates*.
- **Dedupe: character trigrams, Jaccard ≥ 0.8, stem only, compared against both stored questions and the batch.** Character trigrams tolerate small rewordings, punctuation and identifier casing. 0.8 catches paraphrases of the same stem ("returns when n > hi" vs "returns if n > hi"), while different questions about the same function usually land at 0.4–0.6 because they share identifiers but not structure. Stored = `ok` **and** flagged questions with `chunkHash` = current hash. Stale questions are excluded so that equivalent questions can be regenerated for new code. The batch comparison uses only previously accepted items, so a rejected item never blocks a later one.

---

## 5. Blind verify (optional, `generate/verify.ts`)

- Enabled by `config.questions.verify` or `--verify`. It runs only in CLI `generate` (D7), after validation and before persist.
- Provider: `config.provider.verify ?? <generation provider>`, a **fresh** request (no shared conversation).
- Input: `buildVerifyPrompt` = numbered code + import context + stem + options **permuted** with a deterministic permutation seeded by the question id. No `correctIndex`, explanation, refs or type.
- Output schema: `{ answerIndex: 0..3, confidence: 'low'|'medium'|'high' }`.
- After un-permuting: a mismatch with `correctIndex` sets `flagged = true`. Every completed verify sets `verifiedBy = '<provider>:<model>'`. A provider error leaves `flagged=false, verifiedBy=null`, and the CLI warns once per run. A flagged question is **saved** (for review), but it is not counted as usable (§9) and is never quizzed.

---

## 6. Providers (`generate/providers/`)

```ts
export interface JsonRequest {
  system: string; user: string;
  schema: Record<string, unknown>; schemaName: string;   // JSON Schema object
  maxTokens?: number;                                     // default 16000
  effort?: 'low' | 'medium' | 'high';                     // generate: 'medium', verify: 'low'
  signal?: AbortSignal;                                   // default AbortSignal.timeout(120_000)
}
export interface LLMProvider {
  readonly name: ProviderName;            // 'anthropic' | 'openai' | 'openai-compatible'
  readonly model: string;
  completeJson(req: JsonRequest): Promise<unknown>;      // parsed JSON; validation is the caller's job
}
export class ProviderError extends Error {
  code: 'missing_api_key' | 'missing_model' | 'http' | 'refusal' | 'truncated' | 'invalid_json' | 'network';
  status?: number;
}
```

There is no `temperature` (it differs from PLAN §3): Claude Sonnet 5.5 rejects non-default sampling parameters, and one interface is simpler than a provider-specific option.

| Provider | Construction | Env vars | Defaults |
|---|---|---|---|
| `anthropic` | `new AnthropicProvider({ apiKey, model, client? })`. `client` is the minimal structural type `{ beta: { messages: { create(p): Promise<…> } } }` so tests inject a fake. The real client comes from `@anthropic-ai/sdk` (`new Anthropic({ apiKey })`), imported dynamically in `factory.ts`. | `ANTHROPIC_API_KEY` (required). `ANTHROPIC_BASE_URL` is honoured by the SDK. | model `claude-sonnet-5-5` (config `provider.models.anthropic`) |
| `openai` | `OpenAIChatProvider({ baseURL: 'https://api.openai.com/v1', apiKey, model, fetch? })` | `OPENAI_API_KEY` (required), `OPENAI_BASE_URL` (optional) | no default model → `missing_model` (PLAN §10.21) |
| `openai-compatible` | `OpenAIChatProvider({ baseURL, apiKey?, model, fetch?, structured: 'json_schema' })` | `OPENAI_COMPAT_API_KEY` (optional), `OPENAI_COMPAT_BASE_URL` (overrides config `provider.baseUrl`, default `http://localhost:11434/v1`) | no default model → `missing_model` |

The model resolves as `--model` > `config.provider.models[name]` > error.

**Anthropic request** (official SDK, non-streaming, Messages API): `client.beta.messages.create({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema }, effort }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })`.
- Structured outputs are used, **not** forced tool use, because `tool_choice: {type:'tool'}` returns 400 on `claude-sonnet-5-5`.
- `thinking` is omitted (adaptive by default).
- The server-side refusal fallback is on by default.
- Response handling: `stop_reason === 'refusal'` → `ProviderError('refusal')`; `'max_tokens'` → `truncated`; otherwise `JSON.parse` the first text block (failure → `invalid_json`). SDK `APIError` maps to `http` with `status`, connection errors to `network`. The SDK's built-in retries (2) are kept.

**OpenAI / compatible request** (`fetch`): `POST {baseURL}/chat/completions`, `Authorization: Bearer <key>` when a key is set, body `{ model, messages: [{role:'system'},{role:'user'}], response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } } }`.
- `choices[0].finish_reason === 'length'` → `truncated`; `message.refusal` → `refusal`; `content` is parsed with `JSON.parse`.
- **Compatible fallback:** on HTTP 400 whose body mentions `response_format` / `json_schema`, retry once with `{ type: 'json_object' }` and the JSON Schema appended to the system prompt. The chosen mode is remembered for the provider instance.

**Mockability:** every provider takes its transport (`client` or `fetch`) by injection. `createProvider(name, { config, env, model?, fetch?, anthropicClient? })` only reads `env` that is passed in, never `process.env` directly. Tests use `packages/core/test/generate/mock-provider.ts` (`MockProvider` returning recorded fixtures from `test/generate/fixtures/*.json` and recording requests).

---

## 7. CLI: `gotchea generate`

```
gotchea generate [--chunk <id>] [--provider anthropic|openai|openai-compatible] [--model <id>]
                 [--lang <code>] [--limit <n>] [--verify | --no-verify] [--dry-run] [--json]
```

- Requires an initialised and scanned repo (`requireRepoRoot`, then `CliError` "run `gotchea scan` first").
- The provider is created **before** any work. A missing key gives `CliError` (exit 2): `ANTHROPIC_API_KEY is not set. Set it, pick another --provider, or generate from your coding agent through the MCP tools get_generation_tasks/save_questions (no API key needed).`
- `--lang` defaults to `config.questions.lang` and is validated with `LangCodeSchema`. `--verify` overrides `config.questions.verify`. `--limit` defaults to `config.generate.maxChunksPerRun` (10).
- **Chunk selection (`tasks.ts`, shared with MCP):**
  - Candidates are leaves with `metrics.loc ≥ cfg.questions.minLoc (5)` and `lineCount ≤ 800`, whose hash in the working tree still matches chunks.json (§8.3).
  - `target = ceil(poolMultiplier × questionCount)`, `usable` = §9 count, `deficit = target − usable`. Only `deficit > 0` qualifies.
  - Sort key, ascending: `[usable > 0 ? 1 : 0, −(1 + quiz.fanInWeight·ln(1+fanIn)), −deficit, −loc, id]`. Grey (no usable questions) chunks come first, then the most-imported, then the largest gap. The id makes the order deterministic.
  - `count = min(deficit, questionCount)` per request, so the pool is filled over at most two runs per band and each request stays small.
  - `--chunk <id>` restricts to that chunk (aliases resolve). A non-leaf or unknown id gives `CliError`. A full pool prints `pool full (<usable>/<target>)` and exits 0.
- **Per chunk:** build task → `provider.completeJson(system, user, RAW_BATCH_JSON_SCHEMA)` → `saveQuestions(root, {chunkId, chunkHash, lang, questions}, { generatedBy: '<provider>:<model>', verifier? })`. If `accepted < count`, there is **one** retry: the same prompt plus `Previous attempt rejected: <index: reason>…` and the stems accepted so far appended to `existingStems`. Chunks run sequentially. A `ProviderError` on one chunk is reported and the run continues; `missing_*` aborts.
- `--dry-run` prints the selected tasks (ids, counts, type plans) without calling a provider.
- **Output:** one line per chunk, `✓ src/math.ts#clamp  4 saved · 1 rejected (length_skew) · 0 flagged`, then totals. `--json`: `{ chunks: [{ chunkId, requested, saved, flagged, rejected: [{index, reason}], skipped?: 'too_large'|'pool_full'|'error', error?: string }], totals: { saved, rejected, flagged } }`. There are no stems, options, keys or explanations in the output.
- Exit codes: 0 when the run finished, even with rejections; 1 when every chunk errored; 2 for config/credential errors.

---

## 8. MCP tools (priority path, no API key)

Both tools follow the existing conventions: `guarded()`, `textResult()`, the `ReadinessShape` fields, strict zod outputs that copy fields explicitly (never by spread), and `INIT_MESSAGE` / `SCAN_MESSAGE` when the repo is not ready.

### 8.1 `get_generation_tasks`

- Input: `z.strictObject({ limit: z.number().int().min(1).max(10).optional() /* default 3 */, lang: z.string().optional() /* default config.questions.lang */ })`.
- Behaviour: `getGenerationTasks(root, { limit, lang })` applies the §7 selection, then `buildGenerationTask` for each chunk. Read-only (`readOnlyHint: true`).
- Output (strict):
  ```ts
  { initialized, scanned,
    tasks: [{ chunkId, chunkHash, path, title, sourceLang: string|null, lineCount, code,
              context: { imports: [{ from, name, signature }], enclosing: string|null },
              existingStems: string[], count, typePlan: QuestionType[], questionLang, instructions }],
    remaining: number }          // leaves still needing questions beyond this page
  ```
- **Never included:** existing options, `correctIndex`, explanations, refs, flagged state. Only stems of usable questions (PLAN §6).
- Text content: a short summary (`3 tasks · 41 more chunks need questions`) followed by `instructions` of the first task. Clients that ignore `structuredContent` can still act on it.

### 8.2 `save_questions`

- Input: `z.strictObject({ chunkId: z.string().min(1), chunkHash: z.string().min(1), lang: z.string().optional(), questions: z.array(z.record(z.string(), z.unknown())).min(1).max(20) })`.
  - Items are deliberately loose so that one bad item gives a per-index `schema_invalid` instead of an SDK-level failure of the whole call. The item shape is described in `.describe()` and in each task's `instructions`.
  - `annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false }`.
- **Call-level gate** (before validation; nothing is persisted when it fails; `status: 'rejected'`):

  | `reason` | Rule |
  |---|---|
  | `unknown_chunk` | `chunkId` is not in chunks.json (aliases resolve to the current id). |
  | `not_leaf` | The chunk is not a leaf. |
  | `chunk_hash_mismatch` | `chunkHash ≠ chunk.contentHash` in chunks.json. The message says: "code changed since the task was issued; call get_generation_tasks again". The current hash is **not** returned, so stale questions can't simply be resubmitted. |
  | `chunk_changed_since_scan` | `currentChunkHash(root, chunk)` (re-chunks only that file from the working tree) ≠ chunks.json hash. The message says to run `scan`. |
  | `lang_invalid` | `lang` fails `LangCodeSchema`. |

- Then `saveQuestions` runs:
  1. `validateBatch` (§4) against the chunk's current pool.
  2. Stamp the accepted items (§2.2) with `generatedBy = 'host:' + (server.server.getClientVersion()?.name ?? 'unknown')`, `flagged=false`, `verifiedBy=null`.
  3. `QuestionStore.update(chunkId, pool => [...pool, ...stamped])`. The id is re-checked inside the lock.
- Output (strict):
  ```ts
  { initialized, scanned,
    status: 'saved' | 'rejected',              // 'saved' even when 0 items were accepted; 'rejected' = call-level gate
    reason: CallRejectReason | null,
    chunkId: string,
    accepted: { index: number; id: string }[],
    rejected: { index: number; reason: RejectionReason; detail: string }[],
    usableQuestions: number, target: number }  // after the save
  ```
- **§6 boundary:** the response contains indices, ids, reason codes and the fixed-template `detail` (§4) only. It never echoes a stem, an option, `correctIndex`, an explanation or refs. This includes the host's own submission (PLAN §6 already accepts that the host context holds what it wrote).

### 8.3 Freshness

Both tools read chunks.json from disk on each call (as `get_map` does). After a successful save, MCP calls `ctx.reloadIndex()` only if chunks.json mtime changed. Questions do not live in the index.

---

## 9. Storage, migration, map

- **File format v2.** `.gotchea/questions/<slug>--<sha1>.json` = `{ version: 2, chunkId, questions: StoredQuestion[] }`. `stableStringify`, questions sorted by id (unchanged).
- **Migration v1 → v2 (pure `upgradeQuestionsFile()`, applied on read in `FsQuestionStore.list`):** each question gets:
  - `flagged = (status === 'flagged')`, and `status` becomes `'ok'` if it was `'flagged'`;
  - `verifiedBy = null`, `promptVersion = 'p0'`, `chunkLines = 0` (unknown);
  - `refs = []`, because absolute v1 refs can't be converted without the chunk's old ranges.

  No real v1 question files exist (M1 never generated any; PLAN §10.43), so dropping the refs is safe. The stored schema therefore allows `refs: []` and `chunkLines: 0`. The "≥ 1 ref" rule applies only to raw input (§2.1). The file is rewritten as v2 on the next save. Unknown versions still throw.
- **`FsQuestionStore.list`** returns `[]` and does not throw when `file.chunkId !== chunkId` (PLAN §10.55 fix). A corrupt file still throws from `list`, and `save_questions` reports it as `isError`.
- **`QuestionStore.update(chunkId, fn)`**: read → `fn` → atomic write, serialised by an in-process per-chunk promise chain (MCP can receive concurrent calls). A cross-process `.lock` stays deferred (PLAN §10.23, §10.38).
- **Usable count (`okQuestionCounts(root, chunks)`)**: `status === 'ok' && !flagged && chunkHash === chunk.contentHash`. The new `chunks` argument comes from `loadMapTree` / `getStatus`, which already load it. Callers without chunks keep the old behaviour (no hash check). Counts only, as before.
- **`get_map` / `map` behaviour after a save** (no score change, D8):
  - The leaf's `okQuestions` = usable count > 0 → `chunkState` returns `red`, R = 0 → the leaf is **no longer grey**.
  - The MCP text line shows `· N soru` (existing), and parents now show `· Σ N soru`.
  - CLI `map` prints `· N q` on such leaves.
  - `map --json` and `get_map` structured output already carry `okQuestions`; the schema is unchanged.
  - Parents aggregate R=0 → red, which is PLAN §3/§10.39 behaviour.
  - Colour semantics beyond this are M3.
- **Scan:** `applyScanDiff` is unchanged in logic. Moves keep refs (D1). Renormalised chunks rewrite `chunkHash`. Changed chunks → `stale`. Only the type imports change to v2.

---

## 10. Test plan

All tests are hermetic: no network, a temp repo plus `GOTCHEA_HOME` as in the existing helpers, and an injected `now`.

**Core (`packages/core/test/generate/`)**
- `schema.test.ts`: raw accept/reject cases. Stamping produces a valid `StoredQuestionSchema`. `RAW_BATCH_JSON_SCHEMA` has the same keys as `RawQuestionSchema`. Id is deterministic.
- `validate.test.ts`: a **table with one failing and one passing near-threshold case per reason code**, all 13. It must include:
  - `answer_leak_stem` (a) verbatim, (b) 60% overlap, and a negative case with the margin (`lo/hi/n/NaN` fixture stem).
  - `answer_leak_options` (a) and (b).
  - `length_skew` at r = 1.41 vs 1.39, at r < 0.71, and a short-token case under the 8-char floor.
  - `refs_out_of_range` for 0, `end > N` and `start > end`.
  - `explanation_citation` with no citation and with `L999`.
  - `duplicate_stored` (J ≥ 0.8 vs 0.79) and `duplicate_batch`, where a rejected earlier item does not block a later one.
  - Rule order: one item that breaks rules 6 and 8 reports 6.
  - `detail` never contains any option text or the stem (asserted for every row).
- `dedupe.test.ts`, `text.test.ts`: trigram/Jaccard values, normalisation, tr/en stopwords.
- `chunk-code.test.ts`: numbering starts at 1. Multi-range separators are unnumbered. `toAbsoluteLine` for single and multi-range chunks. **After a move** (fixture: insert 10 lines above a function, rescan, same hash) the stored refs map to the new absolute lines. `currentChunkHash` detects a working-tree edit.
- `context.test.ts`: import signatures resolve within the `ts-basic` / `py-basic` fixtures, the caps apply, and external imports have an empty signature.
- `tasks.test.ts`: the priority order (grey first, fanIn, deficit, id tiebreak), `minLoc`, the size guard, `typePlan` coverage, `count` capping.
- `prompt.test.ts`: snapshot of system, user and host instructions for one fixture task. `PROMPT_VERSION` appears.
- `save.test.ts` (**contract**):
  - accepted items persisted with stamped fields, and rejected items not persisted;
  - `chunk_hash_mismatch` persists nothing and the pool file is byte-identical before and after (**hash-mismatch rejection test**);
  - `chunk_changed_since_scan`, `unknown_chunk`, `not_leaf`;
  - an identical resubmission gives `duplicate_stored`;
  - two concurrent `saveQuestions` on one chunk keep both batches (mutex).
- `verify.test.ts`: a MockProvider answering correctly → `flagged=false, verifiedBy` set; wrong → `flagged=true`; a throw → `verifiedBy=null`. The verify request contains no `correctIndex`, explanation or refs (asserted on the recorded request), and the options are permuted.
- `providers/anthropic.test.ts`: a fake `client.beta.messages.create` asserts the request (model `claude-sonnet-5-5`, `output_config.format.type === 'json_schema'`, no `tool_choice`, no `temperature`, `fallbacks`). Maps `refusal`, `max_tokens`, non-JSON and `APIError` to their codes.
- `providers/openai-chat.test.ts`: an injected `fetch` asserts the URL (`baseURL` respected, trailing slash normalised), the auth header present or absent, and `response_format`. Covers the `json_object` fallback on a 400, `finish_reason: length`, and `refusal`.
- `providers/factory.test.ts`: env var resolution, `missing_api_key`, `missing_model`, and the `--model` override.
- `store/stores.test.ts` (extend): v1→v2 upgrade (`'flagged'` → `ok+flagged`), the `chunkId` mismatch case, and `update()`.
- `map/ops.test.ts` (extend): after `saveQuestions`, `loadMapTree` shows the leaf with `okQuestions = n` and colour `red` (not grey). A flagged-only pool stays grey. A stale-hash question is not counted.

**CLI (`packages/cli/test/generate.test.ts`)**: `createProgram(io, { createProvider: () => mock })` on the `small-repo` fixture. Covers the default selection order, `--chunk`, `--lang tr` stamped, `--dry-run` making no provider call, the missing key giving exit 2 with the MCP hint, the retry on rejections, and `--json` shape. The **leak assertion** walks the `--json` output keys and checks for no `correctIndex/explanation/options/stem/refs`.

**MCP (`packages/mcp/test/generation.test.ts`)**:
- `get_generation_tasks` returns prioritised tasks with numbered code and context, and `existingStems` contains the seeded stem.
- A `save_questions` round-trip: valid + invalid items → per-index reasons. Then `get_map` shows the leaf with `okQuestions` and not grey, and `get_generation_tasks` no longer offers a full chunk.
- Hash mismatch → `status: 'rejected'`, `reason: 'chunk_hash_mismatch'`, and the file is unchanged.
- `generatedBy` = `host:test` (from the test client's name).

**Extending the leak test (`packages/mcp/test/safety.test.ts`)**
1. Seed the fixture question with **sentinel values**: options `SEED-OPT-A..D`, explanation `EXPLANATION` (existing). Seed a second, flagged question with sentinel stem `SEED-FLAGGED-STEM`.
2. Add to `CALLS`: `['get_generation_tasks', {}]`, `['get_generation_tasks', { limit: 10 }]`, and two `save_questions` calls (resolve `chunkHash` from chunks.json in the test):
   - one with a valid item whose options/explanation are sentinels `SUBMIT-OPT-*` / `SUBMIT-EXPL`;
   - one with a leaking item (correct option text inside its stem) whose sentinels must also not come back.
   Add both tools to the "not initialised" loop.
3. Assertions:
   - **Key check:** recursively collect every object key in every `structuredContent` and in every tool's `outputSchema` (from `listTools`). The set must not contain `correctIndex`, `explanation`, `options`, `refs`.
   - **Value check:** the concatenated text + structured content of every call, plus `JSON.stringify(listTools)`, contains none of `EXPLANATION`, `SEED-OPT-`, `SUBMIT-OPT-`, `SUBMIT-EXPL`, `SEED-FLAGGED-STEM` (flagged stems are not exposed either).
   - **Name check:** the existing substring check for `correctIndex` / `explanation` stays for every tool *except* `get_generation_tasks.instructions` and the `save_questions` description/input schema, which must name those fields to describe the submission format. Those two are excluded by path, not by tool.
4. CLI: extend `map.test.ts` and `e2e-fixtures.test.ts` key checks to `generate --json`.

---

## 11. Implementation order (suggested subtasks)

1. Model + schema + store v2 + config (§2, §9 storage). Tests: schema, store.
2. `text.ts`, `dedupe.ts`, `validate.ts` (§4). Validator table tests.
3. `chunk-code.ts`, `context.ts`, `tasks.ts`, `prompt.ts` (§3). Snapshot and priority tests.
4. `save.ts` + `okQuestionCounts` hash filter + map text (§8.2 core, §9). Contract and map tests.
5. MCP tools + schemas + leak-test extension (§8, §10). **Ship point: host-mode generation works without an API key.**
6. Providers + factory (§6). Mock tests.
7. `verify.ts` + `generate.ts` + CLI command (§5, §7).
