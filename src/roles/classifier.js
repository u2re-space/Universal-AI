/**
 * @file src/roles/classifier.js
 * @module roles/classifier
 * @purpose One-turn label for how large a team task is.
 * @usedBy roles/index, agent/team
 * @exports instructions, settings
 * @ai.tags roles, pace
 * @ai.hint pure
 * @changed 2026-10-19 Task label trivial, normal, or complex.
 */

/**
 * Prompt for the classifier. The reply is one JSON label.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = 'Classify this task as trivial, normal, or complex. trivial: one obvious change or a question answered from one place. normal: a few files or one clear feature. complex: several parts, a design, or more than one system. Reply in JSON only.';

/**
 * Lowest-rung settings. Pace replaces the model.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'low', model: null };
