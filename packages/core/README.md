# gotchea-core

> The comprehension engine behind [gotchea](https://www.npmjs.com/package/gotchea): chunking, question pools, quizzes and spaced-repetition scoring for codebases.

**This is a library package.** The `gotchea` CLI and MCP server are built on it. To use gotchea, run the tool instead:

```sh
npx gotchea init
```

If you are building on the engine directly:

```sh
npm install gotchea-core
```

It is ESM only and requires Node.js >= 20. The API is not stable yet and may change in any `0.x` release.

## Public API

Everything below is exported from `gotchea-core` (`src/index.ts`):

| Area | Main exports |
|---|---|
| Operations (what the CLI and MCP call) | `runScan`, `getStatus`, `isInitialized`, `ensureReconciled`, `startQuiz`, `submitAnswer`, `abandonQuiz`, `getGenerationTasks`, `saveQuestions`, `runGenerate`, `initConfig`, `saveConfig` |
| Config | `loadConfig`, `defaultConfig`, `mergeConfig`, `resolveConfig`, `ConfigSchema` (+ section schemas), `ConfigError` |
| Files and parsing | `walkFiles`, `createMatcher`, `findIgnoredPaths`, `ParserRegistry`, `createDefaultRegistry`, `createTypeScriptParser`, `createTsxParser`, `createJavaScriptParser`, `createPythonParser`, `grammarPath` |
| Chunking and hashing | `CodeChunker`, `buildTree`, `buildFanIn`, `normalizeSource`, `contentHash`, `lineFingerprints` |
| Scan | `scanRepo`, `computeScanDiff`, `applyScanDiff`, `reconcileProgress`, `lineDiff`, `changeRatio` |
| Storage | `FsChunkStore`, `FsProgressStore`, `FsSnapshotStore`, `FsSessionStore` (+ `InMemory*`), `repoPaths`, `userPaths`, `computeRepoId`, `withRepoLock`, `writeFileAtomic` |
| Index | `ChunkIndex` (in-memory file/line → chunk lookup) |
| Scoring (pure) | `retrievability`, `onSessionResult`, `onContentChange`, `chunkState`, `parentState`, `computeTreeStates`, `aggregate`, `colorFor`, `passThreshold`, `questionCount`, `selectionPriority` |
| Map | `loadMapTree`, `buildMapTree`, `filterTree`, `okQuestionCounts`, `mapJsonFrom`, `statusJsonFrom`, `copyMapNode`, `buildMiniHeatmap`, `HEAT` |
| Generation | `createProvider`, `AnthropicProvider`, `createOpenAIProvider`, `createOpenAICompatibleProvider`, `buildGenerationPrompt`, `RawBatchSchema`, `REJECTION_REASONS` |
| Quiz | `selectChunk`, `selectQuestions`, `QuizSessions`, `scoreSession`, `PublicQuestionViewSchema`, `RevealViewSchema`, `assertPublicView`, `FORBIDDEN_KEYS` |

The public entry never returns a stored question with its answer. The question stores and the private question type are on the internal `gotchea-core/internal` entry, which is not part of the public API.

## Documentation

See the [main README](https://github.com/Futuretea-LTD/gotchea#readme).

## License

MIT © 2026 Futuretea LTD
