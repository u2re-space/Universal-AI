/**
 * @file src/roles/solver.js
 * @module roles/solver
 * @purpose Solver prompt and complexity tiers. Also decides what to capture.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions, settings, SOLVER_TIERS, solverChoice
 * @ai.tags roles, desktop, answer
 * @ai.hint pure
 * @changed 2026-10-20 Solver absorbs the scanner and follows step complexity.
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

/**
 * Fallback settings. The team replaces model and effort from {@link solverChoice} unless config pins them.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: null, model: null };

/** Model and effort for each plan-step complexity. */
export const SOLVER_TIERS = Object.freeze({
    trivial: Object.freeze({ model: 'gpt-6-luna', effort: 'low' }),
    normal: Object.freeze({ model: 'gpt-6-luna', effort: 'medium' }),
    complex: Object.freeze({ model: 'gpt-6.1-sol', effort: 'high' }),
});

/**
 * Model and effort for this step. A configured model or effort replaces the tier.
 * @param {string} [complexity]
 * @param {{ model?: string | null, effort?: string | null }} [configured]
 * @returns {{ model: string, effort: string }}
 * @exports
 * @ai.hint pure
 */
export function solverChoice(complexity = 'normal', configured = {}) {
    const tier = SOLVER_TIERS[complexity] ?? SOLVER_TIERS.normal;
    return {
        model: configured.model || tier.model,
        effort: configured.effort || tier.effort,
    };
}
