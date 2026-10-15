#!/usr/bin/env node
/**
 * @file bin/ai.js
 * @module bin/ai
 * @purpose Process entry for the `ai` command. Forwards every argument, including `serve` and `--port`, to `cli.main`.
 * @depends cli
 * @usedBy package bin
 * @ai.tags cli
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card. Shebang stays on line 1.
 */
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
