/**
 * @file src/commands/gen.js
 * @module commands/gen
 * @purpose `ai gen` — the same team command as `ai run`.
 * @depends commands/run
 * @usedBy cli
 * @exports gen
 * @ai.tags cli, generate
 * @ai.hint io
 * @changed 2026-10-15 Alias of run.
 */
import { run } from './run.js';

/**
 * `ai gen` uses the same handler, flags, and positionals as `ai run`.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code from run.
 * @exports
 * @ai.hint io
 */
export async function gen(ctx) {
    return run(ctx);
}
