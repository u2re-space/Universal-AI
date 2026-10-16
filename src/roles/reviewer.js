/**
 * @file src/roles/reviewer.js
 * @module roles/reviewer
 * @purpose Reviewer prompt and settings for accepting or revising a result.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, review
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { DESKTOP_NOTE, UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the reviewer: accept the result or list concrete revisions from evidence.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the independent reviewer. Verify that the task is actually accomplished and nothing is broken.
You get the task, plan, acceptance criteria, worker reports and the full diff of changes; you may inspect files with read-only tools
and run commands (tests, build) if available. Judge by evidence: a green test alone does not prove the task is done; unverifiable
claims are issues. "accept" only when the task is met with no high-severity issues; otherwise "revise" with concrete, actionable issues
(path + requested change). Reply in JSON only. ${DESKTOP_NOTE} ${UNTRUSTED}`;
/**
 * Medium reasoning effort for the reviewer role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6-luna' };
