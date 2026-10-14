# Contributing to gotchea

Thanks for helping out! This is a pnpm monorepo:

| Directory | npm package | Role |
|---|---|---|
| `packages/cli` | `gotchea` | CLI (`npx gotchea`) |
| `packages/core` | `gotchea-core` | Comprehension engine (chunking, scoring, stores) |
| `packages/mcp` | `gotchea-mcp` | MCP server |

`cli` and `mcp` depend on `core`. `core` never imports from them.

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
