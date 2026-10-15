# Contributing to gotchea

Thanks for helping out! This is a pnpm monorepo:

| Directory | npm package | Role |
|---|---|---|
| `packages/cli` | `gotchea` | CLI (`npx gotchea`) |
| `packages/core` | `gotchea-core` | Comprehension engine (chunking, scoring, stores) |
| `packages/mcp` | `gotchea-mcp` | MCP server |
| `packages/web` | `gotchea-web` (private) | Treemap UI for `gotchea serve`, bundled into the CLI |

`cli`, `mcp` and `web` depend on `core`. `core` never imports from them. Coding agents should also read [AGENTS.md](./AGENTS.md).

## Prerequisites

- Node.js **>= 20**
- pnpm, through Corepack (the version is pinned in `packageManager` in `package.json`):

  ```sh
  corepack enable
  ```

## Setup

```sh
git clone https://github.com/Futuretea-LTD/gotchea.git
cd gotchea
pnpm install
pnpm build
```

To try your local build against any repository:

```sh
node packages/cli/dist/index.js --cwd /path/to/repo scan
```

## Scripts

Run these from the repository root:

| Command | What it does |
|---|---|
| `pnpm build` | Builds every package (tsup + `tsc` declarations) |
| `pnpm test` | Runs all tests with Vitest |
| `pnpm test:coverage` | Runs tests with coverage (`core/src/score/**` must stay at 100%) |
| `pnpm lint` | Lints the workspace |
| `pnpm typecheck` | Type-checks every package |

Before you open a PR, make sure `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm typecheck` all pass.

## Testing local tarballs

To check what users will actually install (bundled WASM grammars, the web UI, rewritten `workspace:*` dependencies), pack the three published packages and install them into a throwaway project outside the repo:

```sh
pnpm build
T=$(mktemp -d)
for p in core mcp cli; do (cd packages/$p && pnpm pack --pack-destination "$T/tarballs"); done
mkdir "$T/consumer" && cd "$T/consumer"
npm init -y >/dev/null
npm install "$T"/tarballs/*.tgz
```

Then run the installed CLI from inside a test repository, so `.gotchea/` is created there and not in the consumer project:

```sh
cd /path/to/some/repo
npx --prefix "$T/consumer" gotchea init
npx --prefix "$T/consumer" gotchea scan
npx --prefix "$T/consumer" gotchea map
npx --prefix "$T/consumer" gotchea mcp    # waits for a client on stdio; stdout must carry only JSON-RPC (Ctrl-D exits)
```

**Why `--prefix`:** with npm 11, `npx gotchea` no longer picks up a `gotchea` bin from your `PATH` or from another directory's `node_modules`. Before the package is published, a plain `npx gotchea` from the test repository goes to the registry and fails with `E404`. `npx --prefix <consumer>` resolves the bin from the consumer's `node_modules` while the working directory stays the test repository. (Running `node "$T/consumer/node_modules/gotchea/dist/index.js" …` works too.)

Delete `$T` when you are done. Never `npm publish` these tarballs.

## Changesets

Every PR that changes a published package needs a changeset:

```sh
pnpm changeset
```

Pick the affected packages and the bump type (`patch` / `minor` / `major`), then write a one-line summary for users. Commit the generated `.changeset/*.md` file with your change. Docs-only or internal changes don't need one.

## Release flow

Releases are automated. Do not run `npm publish` by hand.

1. When PRs with changesets merge into `main`, CI opens or updates a **"Version Packages"** PR. That PR bumps versions and updates the changelogs.
2. Merging the Version Packages PR triggers the automated publish to npm.

## Code style

- TypeScript in strict mode, ESM only, `NodeNext` resolution. Use `.js` extensions in relative imports and `import type` for types.
- Keep `core/src/score/` pure: inject `now` and do no I/O. Keep `core` independent of the CLI and MCP packages.
- Write comments that explain *why*, not *what*. Match the style of the surrounding code.
- Add or update tests for every behavior change.
