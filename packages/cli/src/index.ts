#!/usr/bin/env node
// Executable entry (package.json `bin`). The programmatic API lives in program.ts.
import { run } from './program.js';

process.exitCode = await run(process.argv.slice(2));
