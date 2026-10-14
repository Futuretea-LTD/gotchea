# gotchea — M4 Summary (Web)

M4 is ready for your review. **M5 has not been started.** Nothing was committed, pushed or published.
The scope is PLAN.md §9 "M4". The decisions are recorded in PLAN §10.58–62, and §9 marks M4 as done.

## Prerequisite check

- The baseline was green before any change: `pnpm build`, `pnpm test` (67 files, 886 tests), `pnpm typecheck` and `pnpm lint` (the 4 old warnings).
- `buildMapTree` and `filterTree` were already in core (`core/src/map/tree.ts`, moved in M1.5).
- **`MapJson` was still in `cli/src/render/json.ts`**, and MCP `get_map` had its own node copy (`toOut`). Both now live in `core/src/map/json.ts`:
  - `MapJson` and `StatusJson`;
  - `copyMapNode(node, depth?)`, which copies field by field so no extra key can ride along;
  - `mapJsonFrom(snapshot, { rootTitle, filter, generatedAt })`;
  - `statusJsonFrom(report, now)`.

  `map --json`, MCP `get_map`, `GET /api/map` and the web types all go through these. The shape is written once.
- **`gotchea status --json` did not exist.** It is added, with the same schema as `GET /api/status`.

## What was built

### `packages/web` (`gotchea-web`)
- Private, never published. Vanilla TypeScript, built by Vite (a devDependency only).
- The bundle is `index.html`, one JS file (~10 kB), one CSS file and `favicon.svg`.
- **`src/layout/squarify.ts`** is pure: no DOM, no core.
  - `squarify(items, rect, value)` is the Bruls et al. algorithm. The last cell of each row and the last row absorb rounding error, so the cells tile the rectangle exactly.
  - Items with 0, a negative or a non-finite value get no cell.
  - `layoutTree(root, rect, value, { maxDepth, inset })` gives a nested layout.
- **`src/app.ts`** is the UI:
  - Breadcrumb. The URL hash holds the selection (`#/src/auth/session.ts`, with `#` in a symbol id encoded as `%23`). The back button works.
  - A legend with per-colour leaf counters for the node on screen, like the `gotchea map` legend.
  - The treemap. A node with children shows its children; a leaf is shown selected inside its parent.
  - A details panel: id, kind, LOC, complexity, fanIn, R %, dueAt and okQuestions/questionCount. It follows the hovered or focused cell.
  - Copy buttons for `gotchea quiz <id>`, plus `gotchea generate --chunk <id>` for grey leaves. Ids are shell-quoted.
  - A children table that also lists 0-LOC chunks.
  - A "run `gotchea scan`" screen when chunks.json is missing or the repo is empty.
  - **There is no quiz.**
- **Accessibility:**
  - Cells are `<button>`s with a full `aria-label`, and use a roving tabindex.
  - Keys: arrows move to the nearest cell in that direction, Home/End jump to the first or last cell, Enter opens, Backspace/Escape goes up.
  - Every state has a text mark (`!` red, `~` yellow, `✓` green, `–` grey) and a CSS pattern, so no state relies on colour alone.
  - `prefers-color-scheme` light and dark are both supported.
- **`src/api.ts`:** polls `/api/map` every 3 s with `If-None-Match`, and does not re-render on a 304. An "offline" notice keeps the last map on screen and clears when the server comes back. There is no SSE or WebSocket.

### `gotchea serve [path] [--port <n>] [--no-open]` (`packages/cli/src/serve/`, `commands/serve.ts`)
- Only `node:http` is used. It binds to `127.0.0.1` only (there is no `--host`). The default port is 4477, and `--port 0` works.
- If the port is taken, it fails with `port 4477 is already in use. Try another one with --port <n>.`.
- On start it prints the URL and opens the browser (`open`, `xdg-open` or `cmd /c start`; failures are silent) unless `--no-open` is given. It closes cleanly on SIGINT/SIGTERM and also drops keep-alive connections.
- **Endpoints** (GET/HEAD only, 405 with `Allow` otherwise):
  - `/api/map[?filter=]` returns the same bytes as `map --json`.
  - `/api/status` returns the same bytes as `status --json`.
  - 404 bodies: `not_scanned`, `no_root`, `no_match`, `not_found`.
  - Everything else is a static file, and unknown paths fall back to `index.html`.
  - ETag on every 200. 304 for `If-None-Match`.
- **Security:**
  - Host allowlist: only `127.0.0.1:<port>` and `localhost:<port>`. Anything else, including a missing Host, gets 403.
  - No CORS headers.
  - CSP `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`, `nosniff` and `no-referrer` on every response.
  - Traversal is checked on the raw target: a `..` or `.` segment, or an encoded `/`, `\` or NUL, gets 403, and the realpath must stay inside `dist/web`.
  - The API JSON is deep-scanned for the §6 forbidden keys plus `options`/`stem`. A hit gets 500 and nothing is sent.
- **Read-only:**
  - `ensureReconciled` runs once at startup.
  - After that, map and status are loaded with `reconcile: false` and cached.
  - The cache reloads when the mtime, size or inode of `chunks.json`, `config.json`, `questions/` or `progress.json` changes, and every 60 s for the time decay (§10.58).
- `serve` is gone from `STUB_COMMANDS` (now empty) and from the "not implemented" help lines.

### Packaging
- The cli build is `tsup && tsc … && node scripts/copy-web.mjs`. The script copies `packages/web/dist` to `packages/cli/dist/web/`, and fails with a clear message if the web bundle is missing. The cli gains no runtime dependency.
- `gotchea-web` is a `workspace:*` **devDependency** of the cli, so the build order is core → mcp → web → cli (verified).
- `.changeset/config.json` has `privatePackages: { version: false, tag: false }`. Web is not in `fixed`. I added `.changeset/m4-web.md` (gotchea and core minor, mcp patch).
- `vitest.config.ts` has a new `web` project in `happy-dom`.
- README: the stale status line is updated and there is a short "Web treemap" section.

## Decisions added to PLAN §10
- **58:** serve is read-only after one startup reconcile; it reloads by mtime/size/inode plus a 60 s age, and `generatedAt` is the cache time. *Consequence:* after a `git pull`, decay shows in the browser only once another command has reconciled.
- **59:** the security model (refines 28).
- **60:** web packaging, the devDependency used for build order, changesets. Building from source wants Node ≥ 20.19 for Vite 8; it also worked on 20.15.
- **61:** one JSON shape in core, and `status --json` (completes 52).
- **62:** treemap semantics: one level per view, a leaf shown in its parent, 0-LOC chunks only in the list, the hash format, falling back to the closest ancestor, the legend without numeric thresholds, the text marks and patterns.

## Tests (2026-10-14)

| Check | Result |
|---|---|
| `pnpm build` | ✅ core → mcp → web → cli |
| `pnpm test` | ✅ 73 files, **945 tests** (886 before, **+59**) |
| per project | core 723 (+4) · cli 98 (+29) · mcp 98 (±0) · web 26 (new) |
| `pnpm typecheck` | ✅ core, cli, mcp, web |
| `pnpm lint` | ✅ 0 errors; the same 4 old warnings |
| Node 20.15.1 / 22.12.0 | ✅ web tests and `vite build` on both. cli + mcp tests on 20.15.1 (run by the subagent) |

- **web:**
  - `squarify.test.ts`: a fast-check property (400 runs) that the total area equals the rectangle area within ε, each cell is proportional to its value, there is no overlap and nothing leaves the bounds. Also 0-LOC items, a single child, empty and NaN input, the classic Bruls example and `layoutTree`.
  - `model.test.ts`.
  - `app.test.ts` (happy-dom): the empty and not-scanned screens; drill-down, breadcrumb and `history.back()`; a leaf in the hash; generate for grey leaves; the fallback for a vanished chunk; clipboard; roving arrows and Backspace; 304 not re-rendering, change re-rendering, offline and reconnect, and the poll timer.
- **cli** (`serve.test.ts`, `serve-security.test.ts`, real http on port 0):
  - Byte equality with `map --json` (whole and filtered) and `status --json`.
  - ETag/304, and a reload after planting questions.
  - 405 and HEAD.
  - Host 403 cases.
  - Headers on every status code and no CORS.
  - Traversal (`/../package.json`, `%2e%2e`, `%2f`, `\`, a symlink out of `webRoot`).
  - SPA fallback, not-scanned → scan → 200, and that the bind address is 127.0.0.1.
  - The **leak test** with answer-bearing question files and the M2 sentinel provider over `/api/map`, `/api/map?filter=` and `/api/status`.
  - Read-only: recursive mtime/size listings of `.gotchea` and `GOTCHEA_HOME` are unchanged after a request burst.
  - Port in use, the CLI run with an abort signal, and no stub left.
  - `status --json`.
- **core:** `map/json.test.ts` (copy strips foreign keys, depth cut, filter, title, `no_root`/`no_match`, status copy).

## Acceptance run
- On a copy of `core/test/fixtures/ts-basic`: `init → scan → generate --limit 24` (mock LLM via `ProgramDeps`) → scripted `quiz` runs (pass today, pass 8 days ago, fail) → `serve --port 4488 --no-open` from the built `dist/index.js`.
- The result had 6 green, 6 yellow, 12 red and 8 grey leaves.
- curl:
  - `/api/status` ✅
  - Host `evil.com` → 403 ✅
  - `--path-as-is /../package.json` → 403 ✅
  - `If-None-Match` → 304 ✅
  - `lsof` shows `127.0.0.1:4488` ✅
  - SIGINT → clean exit ✅
- Headless Chrome rendered the coloured treemap, and drill-down to `report-engine.ts > ReportEngine > addRow` works.
- **Screenshots:** `docs/screenshots/m4-treemap-leaf.png` and `docs/screenshots/m4-treemap-root.png` (dark scheme).
- `pnpm pack` of the cli: `dist/web/index.html`, `assets/*` and `favicon.svg` are present, and there is no `src/`.

## Known limitations
- **One level per view.** A root with a single child (`src/`) shows one big cell, and you need one click to drill in. `layoutTree` supports nested levels if you want 2 levels drawn.
- **Decay after a pull** reaches the browser only once another command reconciles, or after a restart (§10.58). Time decay shows up within 60 s.
- **Legend thresholds:** the legend shows no numeric thresholds, because `greenAt` and `yellowAt` are not in `MapJson`.
- **SPA fallback serves `index.html` for a missing `/assets/*.js` too**, as you specified. A 404 under `/assets/` would make a broken bundle more obvious.
- **The published cli `package.json` lists `devDependencies: { "gotchea-web": "0.0.0" }`.** It is harmless, because consumers never install devDependencies, but it points to a package that is not on npm.
- **Not covered by automated tests:** no Playwright, by your instruction, so real-browser layout, focus outlines and clipboard over http are only checked by the screenshot run. The light theme was not screenshotted.
- **Things not fixed:**
  - The README's MCP section still says "Quiz tools are planned", which has been stale since M3.
  - The M3 open item "a failed chunk contributes R ≈ 1 to its parents" is now visible in the treemap.

## Optional item 4 (not done; waiting for your answer)
Should MCP `get_map` add the hint "web view: `npx gotchea serve`" to its text output? I would make it a separate change: one line appended to the text result, not to `structuredContent`, with a test. Shall I go ahead?

## Subagents used
- **1 × general-purpose:** implemented `packages/cli/src/serve/*`, `commands/serve.ts`, the program wiring, stub removal, `status --json` test and the server tests. I reviewed its code and verified it in the full run and the acceptance run.
- **I did myself:** the core JSON move, `packages/web`, packaging, configs, PLAN, README and this summary.
