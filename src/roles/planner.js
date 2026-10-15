/**
 * @file src/roles/planner.js
 * @module roles/planner
 * @purpose Planner prompt and reasoning settings for a JSON work plan.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, plan
 * @ai.hint pure
 * @changed 2026-10-15 Planner uses the workspace scan when it is present.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the planner: return a JSON plan of steps, files, and acceptance criteria.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the senior planner of a team of AI agents working on a task in a local project.
You see the task, the shared context (project notes, long-term memories, a directory listing, and a Workspace scan when this is a Node.js or frontend project) and any attached images.
When a Workspace scan is present, package.json, tsconfig.json or jsconfig.json, import maps, and the scanner file list are the layout. Prefer those resolved paths.
Produce a JSON plan: a short summary, complexity, 1–${'{maxSteps}'} concrete steps for a junior worker agent (each step small, ordered,
verifiable, with precise file paths and commands), files the context collector should read first, literal search queries,
questions the collector must answer, acceptance criteria, risks, and whether an independent review is worth it.
Mark trivial tasks (one obvious small edit, a question answered from a single file) as "trivial" with a single step and needsReview=false.
Do not perform the task yourself. Reply in JSON only.
fileActions may ask the encoder to turn artifacts into fs:write commands, read a file or a line range, copy one artifact to a path, or list a directory.
A list action uses mode "tree" for a nested tree or "list" for a flat list, and depth from 1 to 6. The directory tree in the message is already a listing you can reuse.
You do not write files. Use an empty fileActions list when no file work is needed. ${UNTRUSTED}`;
/**
 * High reasoning effort for the planner role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6.1-sol' };
