/**
 * @file src/roles/reviewer.js
 * @module roles/reviewer
 * @purpose Reviewer prompt and settings for accepting or revising a result.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, review
 * @ai.hint pure
 * @changed 2026-10-22 gpt-6-astra is forbidden for this role and is replaced by a safe fallback.
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
(path + requested change). When the shared context contains the architect's brief, check that the result follows its file/module
structure, interfaces, and conventions; report a real deviation as an issue, not a stylistic preference.
Reply in JSON only. ${DESKTOP_NOTE} ${UNTRUSTED}`;
/**
 * Medium reasoning effort for the reviewer role.
 * Model restriction: reviewer must NOT use gpt-6-astra (too expensive and not a review model).
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6.1-sol' };
/** Models the reviewer must never run on. Validated in config.js and clamped in pace/config. */
export const FORBIDDEN_MODELS = Object.freeze(['gpt-6-astra']);
/** Replacement when a forbidden model is inherited from the default role or the pace ladder. */
export const FALLBACK_MODEL = 'gpt-6-luna';

/**
 * Replace a forbidden reviewer model with the safe fallback.
 * @param {string|null|undefined} model
 * @param {string} [fallback]
 * @returns {string|null|undefined}
 * @exports
 * @ai.hint pure
 */
export function safeReviewerModel(model, fallback = FALLBACK_MODEL) {
    return FORBIDDEN_MODELS.includes(model) ? fallback : model;
}
