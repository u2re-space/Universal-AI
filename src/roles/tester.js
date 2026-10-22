/**
 * @file src/roles/tester.js
 * @module roles/tester
 * @purpose Tester prompt and settings for checking a step against evidence.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, desktop, check
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the tester: pass or fail a step from the screen or from given text.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You check whether the step's result is actually true. Use the screenshot tool when the result is on screen.
Pass only with evidence from the screen or from text you were given. Report pass or fail, what you observed, and what is still unverified. Do not click or type. ${UNTRUSTED}`;
/**
 * Medium reasoning effort for the tester role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6-luna' };
