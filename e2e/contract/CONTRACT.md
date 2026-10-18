# gotchea MCP contract for Orchestea

This document describes the current implementation, including nullable readiness responses and optional elicitation. The companion `tools.snapshot.json` records the server `instructions` and, per tool, the name, description and the exact advertised input and output JSON Schemas returned by a real MCP SDK client's `listTools()` call. The snapshot is the executable wire contract; this document explains response semantics and integration rules.

## Transport and compatibility

Start `gotchea mcp` in the target repository and connect using MCP stdio, for example `Client` and `StdioClientTransport` from `@modelcontextprotocol/sdk`. Complete the SDK handshake before calling `listTools()` or `callTool({ name, arguments })`. Stdout is JSON-RPC only; diagnostics belong on stderr. The server identifies itself as `gotchea` with the installed package version.

The server exposes exactly these eight tools:

| Tool | Purpose | Required arguments |
| --- | --- | --- |
| `scan` | Build/update chunks | None |
| `get_map` | Hierarchical comprehension map | None |
| `get_status` | Repository totals and leaf colors | None |
| `get_chunk_for_file` | Resolve file/line to chunks | `path` |
| `get_generation_tasks` | Obtain host generation work | None |
| `save_questions` | Validate and store generated questions | `chunkId`, `chunkHash`, `questions` |
| `start_quiz` | Start/resume one chunk's quiz | None |
| `submit_answer` | Record one displayed answer | `sessionId`, `questionId`, `displayIndex` |

All input objects are strict: unknown top-level arguments fail schema validation. Omit optional fields rather than passing `null`. Empty-input tools accept `{}`. Numbers are JSON numbers; the integer restrictions below are enforced. Output objects are also strict and recursively validate their declared structures.

Normal results have this MCP envelope:

```ts
{
  content: [{ type: 'text', text: string }],
  structuredContent: ToolOutput,
  isError?: boolean
}
```

Use `structuredContent` for application logic. Text is intended for people and may be localized; do not parse it for counts, identifiers, or status. Tool refusals can return `isError: true` **and** a structured refusal object. Unexpected failures are guarded and return `isError: true` with diagnostic text, potentially without `structuredContent`. Invalid arguments may be rejected by the SDK before the handler. Check both SDK errors and `isError`; never assume every result has structured data.

Every normal structured output contains `initialized: boolean` and `scanned: boolean` (abbreviated `Ready` below). Initialization is performed outside MCP with `gotchea init`; no MCP initialization tool exists. Before initialization, normal handlers report both flags false with empty arrays, zero counts, or null data. Before the first scan, initialized tools report `initialized: true, scanned: false`. These readiness responses are not populated success data; guide the user to initialize/scan first.

## Shared types

```ts
type Ready = { initialized: boolean; scanned: boolean };
type Color = 'grey' | 'red' | 'yellow' | 'green';
type Kind = 'module' | 'file' | 'group' | 'symbol';
type QuestionType = 'behavior' | 'edge_case' | 'purpose' | 'impact' | 'bug_detection';
type State = { color: Color; R: number | null; dueAt: string | null };
type Lines = { start: number; end: number };
```

Chunk file ranges are 1-based and inclusive. Paths and chunk IDs use repository-relative POSIX paths; symbol IDs can contain `#`, so preserve IDs verbatim. Some tools resolve aliases from moved chunks; consume the current ID returned by the server. `R` is retrievability, not a percentage. Grey means no usable questions. A leaf with usable questions and no pass is red. Passing a complete quiz raises its state to green immediately; time and code changes can lower it later. Parent states aggregate children and skip grey children, so evaluate leaf coverage separately from parent colors.

Language arguments default to `config.questions.lang`. Valid language codes match `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, for example `en`, `tr`, `pt-BR`. Advertised inputs accept strings; semantic language validation occurs inside the handlers.

## `scan`

Input: `{}`. Runs synchronously; large repositories may need a longer client timeout. It detects chunk additions, code changes, moves and removals, updates shared state and reloads the MCP index. It does not initialize the repository or generate questions.

```ts
type ScanOutput = Ready & {
  summary: null | { added: number; changed: number; moved: number; removed: number; total: number };
};
```

`summary` is null before initialization; otherwise a successful scan sets both readiness flags true. `total` counts all tracked chunks, including hierarchy nodes, rather than only quiz leaves. Scanning a code change can invalidate the affected question pool and reconcile personal progress.

## `get_map`

Input: `{ path?: string, depth?: number }`. `path` filters to a directory, file or chunk ID; omit it for the whole repository. `depth` is an integer >= 0, counting levels below the filtered root; omit it for unlimited depth. `depth: 0` retains the root and removes its children from the response.

```ts
type MapNode = {
  id: string; kind: Kind; title: string;
  path: string | null; lines: Lines | null;
  loc: number; complexity: number; fanIn: number;
  isLeaf: boolean; questionCount: number; okQuestions: number;
  state: State; children: MapNode[];
};
type GetMapOutput = Ready & {
  filter: string | null; depth: number | null; root: MapNode | null;
};
```

The filter is normalized; no filter is null. An unmatched filter returns `scanned: true` and `root: null`. Before readiness, filter/depth/root are null. `questionCount` is a leaf's intended quiz size; `okQuestions` is its usable pool count. A depth cut does not change `isLeaf`; a truncated hierarchy node with `children: []` is not necessarily a leaf. This MCP wrapper does not add the CLI/HTTP `version` or `generatedAt` fields.

## `get_status`

Input: `{}`.

```ts
type GetStatusOutput = Ready & {
  chunks: number; leaves: number; questions: number; due: number;
  colors: { grey: number; red: number; yellow: number; green: number };
};
```

Counts are zero before readiness. `colors` counts leaves, and its four values sum to `leaves`. There is **no coverage-percentage field**. Orchestea can calculate current green coverage as `100 * colors.green / leaves`, and generated-question coverage as `100 * (leaves - colors.grey) / leaves`; explicitly handle `leaves === 0` (for example display 0%). A successful quiz increases green coverage when the chunk was previously red. Generating questions increases generated-question coverage. `questions` counts usable questions; `due` counts leaves due for review. Do not confuse total hierarchy chunks with the leaf denominator.

## `get_chunk_for_file`

Input: `{ path: string, line?: number }`. `path` must be nonempty; use a repository-relative file path (absolute paths inside the root are also normalized). `line`, if present, is an integer >= 1.

```ts
type ChunkInfo = {
  id: string; kind: Kind; title: string; parentId: string | null;
  ranges: { path: string; start: number; end: number }[];
  loc: number; complexity: number; fanIn: number;
  isLeaf: boolean; questionCount: number;
};
type GetChunkForFileOutput = Ready & { chunks: ChunkInfo[] };
```

With `line`, returns at most one chunk: the innermost chunk containing that position. Without `line`, returns the file chunk followed by its leaf chunks, without repeating a file that is itself a leaf. An unknown/excluded file or unmatched line returns `chunks: []`; it is not a question-generation error. The lookup uses the loaded scan index, so run `scan` for new/changed source. No question stems, options or keys are included.

## `get_generation_tasks`

Input: `{ limit?: number, lang?: string }`. `limit` is an integer 1–10, default 3. This retrieves work for a host generator; it does not call a provider or save questions.

```ts
type GenerationTask = {
  chunkId: string; chunkHash: string; path: string; title: string;
  sourceLang: string | null; lineCount: number; code: string;
  context: {
    imports: { from: string; name: string; signature: string }[];
    enclosing: string | null;
  };
  existingStems: string[]; count: number; typePlan: QuestionType[];
  questionLang: string; instructions: string;
};
type GetGenerationTasksOutput = Ready & {
  tasks: GenerationTask[]; remaining: number; changedSinceScan: string[];
};
```

Tasks prioritize chunks needing questions. Code is numbered relative to the chunk starting at line 1; references in submitted questions use those numbers, not original file lines. `existingStems` contains only usable question stems for deduplication, never existing options or answers. `count`, `typePlan`, `questionLang` and `instructions` guide generation. Instruction text describes the submission schema, including names of private fields; these schema names are not an existing answer key. `remaining` counts further chunks needing questions beyond returned tasks. `changedSinceScan` lists skipped chunk IDs whose source changed; scan again before generating/saving them. Empty tasks can indicate a full pool or skipped changed chunks. An invalid language yields an error text response.

## `save_questions`

Input: `{ chunkId: string, chunkHash: string, lang?: string, questions: RawQuestion[] }`. Both ID/hash must be nonempty; copy them from the generation task unchanged. `questions` is an array of 1–20 objects. Items are deliberately loose in the advertised schema so malformed object items produce per-item rejections; each accepted item must satisfy the stricter raw schema:

```ts
type RawQuestion = {
  type: QuestionType;
  stem: string;                         // trimmed length 10–600
  options: [string, string, string, string]; // each trimmed, length 1–300
  correctIndex: 0 | 1 | 2 | 3;          // index in these submitted options
  explanation: string;                  // trimmed length 20–1200; cites L<n>
  refs: { start: number; end: number }[]; // 1–5 chunk-relative inclusive ranges
  difficulty: 1 | 2 | 3;
};
type SaveQuestionsOutput = Ready & {
  status: 'saved' | 'rejected' | null;
  reason: string | null; chunkId: string | null; savedCount: number;
  accepted: { index: number; id: string }[];
  rejected: { index: number; reason: string; detail: string }[];
  usableQuestions: number | null; target: number | null;
};
```

Raw items reject unknown fields: do not add IDs, language or storage metadata to individual questions. `refs` and explanation citations must fall within `1..task.lineCount`. References require `1 <= start <= end <= lineCount`. The validator also checks configured question types, distinct options, meta-options, answer clues, option length balance, trivia and duplicate stems.

Whole-call refusal reasons: `not_scanned`, `unknown_chunk`, `not_leaf`, `chunk_hash_mismatch`, `chunk_changed_since_scan`, `lang_invalid`, `batch_too_large`. `not_scanned` becomes the normal unscanned readiness response with null status/reason; other refusals return `isError: true`, `status: 'rejected'`, and save nothing. The configured batch limit may be lower than the advertised limit of 20.

Per-item rejection reasons: `schema_invalid`, `type_not_allowed`, `options_not_distinct`, `meta_option`, `answer_leak_marker`, `answer_leak_stem`, `answer_leak_options`, `length_skew`, `refs_out_of_range`, `explanation_citation`, `trivia`, `duplicate_stored`, `duplicate_batch`. Indices are zero-based positions in the submitted batch. A processed batch can have `status: 'saved'` and `savedCount: 0`; inspect the accepted/rejected arrays. Resubmit only corrected rejected items. `target` is the desired pool size, which may exceed one quiz's size. `usableQuestions` is the usable pool after saving. The server stamps metadata, including `generatedBy: 'host:<client-name>'`. Replies contain counts, IDs and diagnostic reason codes, never submitted question text or answers.

## `start_quiz`

Input: `{ path?: string, chunkId?: string, count?: number, lang?: string, includeCode?: boolean }`. Supply either a path scope or an exact leaf chunk ID (aliases accepted); supplying both is refused. With neither, select from the repository. `count` is an integer 1–10; actual size is clamped by `quiz.minQuestions` and the selected chunk's size. A quiz always concerns one chunk; finish and start again to review other chunks. `includeCode` (boolean, optional) controls the `code` preview. For a new session, omitted means `quiz.showCode` (default `true`), and the session stores the resulting value for its later `submit_answer` responses. For a resumed session, omitted means the session's stored value (`true` for a 0.1.x session file without one), not the current config; an explicit value applies to that response only and does not change the stored value. Elicitation prompts inside the same `start_quiz` call follow an explicit value too.

```ts
type PublicQuestion = {
  questionId: string; // q_ followed by 12 lowercase hexadecimal digits
  position: number; total: number; // position starts at 1
  stem: string;
  options: [Option, Option, Option, Option];
  code?: CodePreview; // the quizzed chunk's current source; omitted when unavailable
};
type CodePreview = {
  path: string;       // repository-relative POSIX path
  startLine: number;  // 1-based, inclusive
  endLine: number;    // 1-based, inclusive; the last line actually in `text`
  language: string;   // e.g. 'typescript'; 'text' when unknown
  text: string;       // exactly lines startLine..endLine (sanitized), joined with '\n'
  truncated?: true;   // present only when the chunk was cut to 60 lines
};
type Option = { index: number; label: 'A' | 'B' | 'C' | 'D'; text: string };
type SessionHeader = {
  id: string; chunkId: string; chunkTitle: string; path: string | null;
  total: number; answered: number; needed: number; expiresAt: string;
};
type StartQuizOutput = Ready & {
  status: 'started' | 'resumed' | 'completed' | 'cancelled' | 'refused' | null;
  reason: string | null; session: SessionHeader | null;
  question: PublicQuestion | null; result: SessionResult | null;
};
```

Options are always displayed in index order 0–3 with labels A–D. Their texts are shuffled per question/session; never interpret display position as the stored key. The public question has exactly these fields, with no correctness, explanation or refs.

`code` is the source of the chunk being quizzed, so the user can read the question against the code. It is a strict object with exactly the fields above (unknown fields fail the output schema). Lines are 1-based and inclusive and refer to the original file; `text` holds exactly `endLine - startLine + 1` lines. A chunk longer than 60 lines (`CODE_PREVIEW_MAX_LINES`) is cut to its first 60 lines and marked `truncated: true`; otherwise `truncated` is absent, never `false`. The 60-line cap, `endLine >= startLine` and the line-count match are enforced server-side; they are not expressible in the advertised JSON Schema. `code` is omitted, not null, when previews are off for the response (an explicit `includeCode: false`, or the session's stored setting is off; see the `includeCode` rules above) or when the source cannot be shown faithfully: the chunk is stale (the working-tree file no longer hashes to the scanned chunk, e.g. edited since the last `scan`), the file is missing or resolves outside the repository or inside `.gotchea/`, the chunk spans several ranges, or the resulting preview would fail its schema (e.g. a hand-edited chunk with an empty `lang`). Staleness is per chunk; other chunks keep their preview. The same rule applies to `next` in `submit_answer`, and the text content renders the preview as a fenced block above the stem. The preview is the working-tree source, so a quiz with previews is open book; it is built only from the chunk's source and never carries the explanation, refs, the correct option or any other answer hint. The source may legitimately contain words such as `correctIndex` or `explanation`; leak checks inspect object keys, not snippet text. In the CLI, `gotchea quiz` prints the same preview above each question; `--code` / `--no-code` override `quiz.showCode`; `gotchea quiz` has no `--json` output, and the `--json` outputs of `scan`, `status`, `map` and `generate` never contain quiz views or previews. `gotchea serve` has no quiz route and rejects a `code` key in API responses.

`path`, `language` and every line of `text` are sanitized on the server before the view is built, so `structuredContent` already carries the safe form. Tab and newline are kept and CRLF becomes LF; other C0/C1 control characters and DEL become visible stand-ins (U+2400–U+241F, `␡`, `�`), and bidi controls (U+061C, U+200E/F, U+202A–U+202E, U+2066–U+2069) become the literal text `\u{XXXX}`. Lines are split before sanitizing, so a lone `\r` becomes `␍` rather than a line break: `text` keeps exactly `endLine - startLine + 1` lines but can differ byte-for-byte from the file. Stem and options differ: `structuredContent` keeps them as stored, and only the text content sanitizes them.

`started` creates a server-side persisted session and returns its first question. An unfinished session with at least one recorded answer in the target scope may return `resumed`, preserving its permutations and returning the next unanswered question. A completely untouched active session is abandoned/replaced on a repeated start; the replacement draws fresh permutations. Random permutations may coincide across independent sessions, so clients must not require each consecutive order to differ.

Start refusal reasons: `both_targets`, `unknown_chunk`, `not_leaf`, `no_match`, `no_quizzable_chunk`, `not_enough_questions`, `lang_invalid`. A refusal is an error result with structured status/reason and null question/result. Before scanning, the ordinary readiness response has null status/reason instead. Question pools must contain enough usable questions in the requested language.

### Text display contract

The default flow uses `start_quiz` and `submit_answer`. Every question presented in tool-result text, including a next question or an elicitation fallback, is enclosed between the exact marker lines `<<<SHOW TO USER VERBATIM` and `SHOW TO USER VERBATIM>>>`. The marked passage contains the code preview (when available) as a fenced block (language-tagged when `language` is a single word, and longer than any backtick run in the source) under a localized header such as `Code: path:startLine-endLine`, with ` (truncated)` added when cut, then the stem and every option in full, labeled A–D in display order. The agent must show the entire passage verbatim and ask for the user's answer; it must not answer the question itself. A selection widget may use only A–D as labels after the full text is shown. Any reveal of the previous answer stays outside the question markers.

A reveal in tool-result text is enclosed in its own pair, the exact lines `<<<SHOW ANSWER FEEDBACK TO USER VERBATIM` and `SHOW ANSWER FEEDBACK TO USER VERBATIM>>>`. It holds the verdict, the correct option (only after a wrong answer), the explanation and a `Cited code:` section: one `path:startLine-endLine` header per ref (` (approximate)` / ` (truncated)` appended when they apply) followed by the excerpt as a fenced block when the ref has one. The agent must show it verbatim as well. A question block holds exactly one question and never a reveal; the two marker pairs never nest. Multi-line option, correct-answer and explanation text has its continuation lines indented by four spaces, and `<<<` / `>>>` inside any marked passage are replaced by `‹‹‹` / `›››`, so model-written text can neither open a Markdown fence, pose as a labelled line nor forge a marker. When a question has no `code`, one line outside the markers says that no preview is available (previews turned off, or the file changed since the last scan). The server also sends these rules as MCP `instructions` (`DISPLAY_INSTRUCTIONS`), because clients may truncate tool descriptions. These markers are a stable text contract for relaying questions; continue to use `structuredContent` for identifiers and application logic.

### Optional elicitation

Form elicitation is disabled by default. `GOTCHEA_MCP_ELICIT=on` or `auto` opts in for clients advertising `elicitation.form`; `off` explicitly selects the two-tool text flow. Each form message includes the code as plain numbered lines without Markdown fences, the stem and all options in full. `requestedSchema.answer.oneOf` uses display letters `A`, `B`, `C`, `D` as `const` values, with short, single-line titles: the label plus option text collapsed to one line and clipped to at most 24 code points (`ELICIT_TITLE_MAX`); the full text is in the form message. Numeric strings `"0"`–`"3"` are accepted temporarily for clients caching the old schema.

A message over 6000 characters or a preview over 40 lines falls back to the complete text flow before presenting that question. Elicitation failures or invalid choices also fall back, possibly with already-recorded reveals in text. Each accepted answer is recorded before its reveal is shown. `completed` returns a final `result`, null `question`, and answer reveals in text; cancellation returns `cancelled` without scoring. For a deterministic Orchestea-managed `start_quiz`/`submit_answer` flow, keep the default or launch with `GOTCHEA_MCP_ELICIT=off`.

## `submit_answer`

Input: `{ sessionId: string, questionId: string, displayIndex: number, includeCode?: boolean }`. `sessionId` must match `^qs_[0-9a-f]{16}$`; use the session ID returned by start. `questionId` identifies the current question. `displayIndex` is an integer 0–3, matching the **displayed** option chosen by the user (A=0, B=1, C=2, D=3). Ask the user and submit their choice; the integrating agent must not guess. `includeCode` sets the `code` preview of `next` for this response only; omitted, the session's stored value applies (set at start from `includeCode` or `quiz.showCode`; `true` for a session without a stored value). Changing `quiz.showCode` after start does not affect a running session.

```ts
type Reveal = {
  questionId: string; correct: boolean;
  selectedDisplayIndex: number; correctDisplayIndex: number; correctText: string;
  explanation: string;
  refs: { path: string; startLine: number; endLine: number; approximate: boolean; excerpt?: RefExcerpt }[];
};
// Strict object. At most 15 lines per ref and 30 per reveal; `truncated` is only ever true.
type RefExcerpt = { language: string; text: string; truncated?: true };
type SubmitAnswerOutput = Ready & {
  status: 'answered' | 'completed' | 'refused' | null;
  reason: string | null; repeat: boolean; sessionId: string | null;
  reveal: Reveal | null;
  progress: { answered: number; total: number; correct: number } | null;
  next: PublicQuestion | null; result: SessionResult | null;
};
type SessionResult = {
  passed: boolean; correct: number; total: number; needed: number;
  chunk: { id: string; title: string; path: string | null };
  before: { color: Color; R: number | null };
  after: State; stabilityDays: number | null;
  heatmap: {
    focus: HeatCell & { path: string | null };
    fileLeaves: (HeatCell & { isFocus: boolean })[];
    omitted: number;
    ancestors: (HeatCell & { kind: Kind })[];
  };
};
type HeatCell = { id: string; title: string; color: Color; R: number | null };
```

Answers are final and ordered. `answered` returns a reveal only for the submitted question and `next` as a public view (including its optional `code` preview). `completed` returns the last reveal plus a scored session result; `next` is null. Chunk progress is scored after the complete session, so do not expect a chunk to turn green after each individual answer. `needed` is the passing threshold; `passed` is the authoritative outcome. Reveal references use original file lines and may be marked approximate. A ref carries an `excerpt` (the cited source lines, sanitized like `code.text`) only when the response's previews are on (same `includeCode` / stored-session rule as `code`), the chunk is still fresh, the ref is not `approximate` and the file is readable inside the repository; otherwise the ref keeps its numbers only. The excerpt exists only in the reveal of the question just answered, never before the answer. A repeat of an already recorded identical answer within an active session can return `repeat: true`; do not assume replay remains successful after completion or expiry.

Submit refusal reasons: `unknown_session`, `session_expired`, `session_completed`, `chunk_changed`, `unknown_question`, `out_of_order`, `already_answered`, `invalid_index`, `question_unavailable`. Refusal outputs have `isError: true`, null reveal/progress/next/result, and a structured reason. An invalid input index normally fails input-schema validation before reaching semantic `invalid_index` handling. Before initialization, status/reason are null and readiness flags false.

Sessions expire after configured idle time (default 120 minutes), refreshed by answers; persisted finished/expired sessions have configurable retention (default 7 days). Restarting MCP can recover sessions from personal storage. Clients keep session/question IDs and displayed choices, not permutations or answer keys.

## Answer-key boundary and storage

Before an answer is submitted, recursively reject these object keys in tool output payloads, including nested arrays/objects:

```text
correctIndex, correctDisplayIndex, correctOptionIndex, correctText,
explanation, refs, excerpt, answer, key
```

This list is `FORBIDDEN_KEYS` in `packages/core/src/quiz/views.ts`; keep integration checks aligned with that export. Public questions, including an optional `code` preview, are strict-schema checked and deep-scanned. The scan matches keys, not string values, so a snippet that mentions these names is not a leak. Metadata/instruction strings may describe private schema field names without carrying an answer. Generation tasks expose existing stems only; save responses do not echo questions. After submission, only the just-answered question's reveal contains correctness, explanation and refs; `next` must retain the public shape. In elicitation mode, accepted answers are submissions inside `start_quiz`, so their later text reveals are post-answer data.

There are deliberate private-data locations: shared question JSON contains keys, and a generating host already knows the questions it wrote. Generate in a subagent or separate session to keep that knowledge outside the agent context used for the user's quiz. Never expose stored question JSON as pre-answer UI data.

| Location | Contents | Ownership |
| --- | --- | --- |
| `<repo>/.gotchea/config.json` | Shared configuration | Repository |
| `<repo>/.gotchea/chunks.json` | Shared scan/chunk structure | Repository |
| `<repo>/.gotchea/questions/*.json` | Shared private question pools, including answers | Repository |
| `~/.gotchea/repos/<repoId>/progress.json` | Personal comprehension/history | User |
| `~/.gotchea/repos/<repoId>/sessions/` | Persisted quiz sessions/permutations | User |
| `~/.gotchea/repos/<repoId>/snapshots/` | Personal reconciliation snapshots | User |

`GOTCHEA_HOME` overrides the `~/.gotchea` base. The E2E harness directs it into an isolated temporary home; no personal progress belongs in the fixture repository. Repository identity is computed by core, so do not hardcode the hash directory name. The implementation uses per-repository locks for relevant mutations; a tool advertised as read-only may still reconcile personal progress. MCP tool annotations are client hints, not a promise that no private storage write can occur.

## Snapshot maintenance and review

Run the contract E2E test against the built local server. It compares the actual server instructions and each tool's name, description and input/output schemas with `tools.snapshot.json`; deletion, renaming, required-argument additions, output-field changes and other schema drift fail the comparison. Set `UPDATE_CONTRACT=1` for an intentional refresh, or use `pnpm e2e:update-contract`. Review the generated diff and update this document with any changed response semantics before accepting a new baseline. Updating a snapshot accepts compatibility changes; it does not establish that an Orchestea client already supports them. The schema snapshot does not replace response, happy-path, storage and leak tests; `test/code-preview-leak.test.ts` covers the `code` preview and the reveal excerpts end to end over MCP and the CLI.

Implementation references: `packages/mcp/src/server.ts`, `packages/mcp/src/schemas.ts`, `packages/mcp/src/context.ts`, `packages/mcp/src/tools/`, `packages/core/src/ops/quiz.ts`, `packages/core/src/quiz/views.ts`, `packages/core/src/generate/{schema,save,validate}.ts`, and `packages/core/src/store/paths.ts`. `PLAN.md` §6 defines the answer-isolation promise; current strict schemas define the actual wire fields.
