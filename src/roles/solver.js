/**
 * @file src/roles/solver.js
 * @module roles/solver
 * @purpose Solver prompt and settings for answering from the screen without input.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, desktop, answer
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the solver: answer a question or captcha from the screen without clicking.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You solve the step in front of you: a question, a calculation, or a captcha described by the screen.
Use the screenshot tool when the screen is the source. State the answer and the evidence. Do not click, type, or run AutoHotkey. ${UNTRUSTED}`;
/**
 * High reasoning effort for the solver role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high' };
