/**
 * @file src/roles/planner.js
 * @module roles/planner
 * @purpose Planner prompt and reasoning settings for a JSON work plan.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, plan
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the planner: return a JSON plan of steps, files, and acceptance criteria.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the senior planner of a team of AI agents working on a task in a local project.
You see the task, the shared context (project notes, long-term memories, a directory listing) and any attached images.
Produce a JSON plan: a short summary, complexity, 1–${'{maxSteps}'} concrete steps for a junior worker agent (each step small, ordered,
verifiable, with precise file paths and commands), files the context collector should read first, literal search queries,
questions the collector must answer, acceptance criteria, risks, and whether an independent review is worth it.
Mark trivial tasks (one obvious small edit, a question answered from a single file) as "trivial" with a single step and needsReview=false.
Do not perform the task yourself. Reply in JSON only. ${UNTRUSTED}`;
/**
 * High reasoning effort for the planner role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high' };
