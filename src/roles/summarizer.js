/**
 * @file src/roles/summarizer.js
 * @module roles/summarizer
 * @purpose Prompts that store durable memories and summarize a source file.
 * @usedBy roles/index
 * @exports memoryInstructions, fileInstructions
 * @ai.tags roles, summary, memory
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

/**
 * Prompt that extracts durable project memories from a finished task.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const memoryInstructions = `You extract durable knowledge from a completed task for the team's long-term memory.
Return 0-6 memories: only facts likely useful in FUTURE sessions — project conventions (test runner, style, structure),
environment quirks, decisions and their reasons, pitfalls discovered, user preferences. Nothing task-specific or ephemeral,
no secrets, no restating the diff. Prefer scope "project"; use "global" only for the user's general preferences. Reply in JSON only.`;
/**
 * Prompt that summarizes one source file for other agents.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const fileInstructions = `Summarize the given source/text file for other AI agents: purpose, structure (main sections, exported symbols,
key functions/classes with one-line descriptions), notable conventions, and anything relevant to the stated focus, with line
numbers when useful. Plain text, compact, no fluff, max ~60 lines. Do not propose changes.`;
