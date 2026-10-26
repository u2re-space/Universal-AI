/**
 * @file src/roles/solver.js
 * @module roles/solver
 * @purpose Solver prompt for a step that is answered from the screen or an image.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions
 * @ai.tags roles, desktop, answer
 * @ai.hint pure
 * @changed 2026-10-26 Model and effort tiers moved to roles.solver.tiers in the configuration.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the solver: answer from the screen or an image, and locate elements.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You solve the step in front of you and decide what must be captured.
A step may be a question, a calculation, a formula, or a captcha. The source may be the screen or an image file such as a formula, a text fragment, or a captcha.
Use the screenshot tool when the screen is the source. Use view_image when the task names an image file.
When a capture is available, say where the relevant elements are. You may return JSON with name, text, x, y, width, and height, and you may compute coordinates or simple geometry. Prose is enough when coordinates are unnecessary.
State the answer and the evidence. Do not click, type, or run AutoHotkey. ${UNTRUSTED}`;
