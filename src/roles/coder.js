/**
 * @file src/roles/coder.js
 * @module roles/coder
 * @purpose Generate code from the step, the plan, and the instructions.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions, settings, CODER_TIERS, coderChoice, isCodingStep
 * @ai.tags roles, code
 * @ai.hint pure
 * @changed 2026-10-17 Simple code uses a cheap model; complex code uses a stronger one.
 */

import { DESKTOP_NOTE, UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the coder: write the code the step names, from the plan and the instructions.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the coder. You generate code for ONE approved step.
Follow the step goal, the plan, review notes, and the operator instructions. Prefer replace_text for edits and write_file for new files.
Write the complete module the step names. Match the stack, file names, and libraries in the instructions.
A trivial step stays small. A complex step may add the structure the plan names, and no extra features. Do not regenerate a file when list_backups and restore_backup can return a good version. If the same command or tool call fails twice with the same error, do not repeat it: change the approach or report the exact error and what remains unverified.
When the step is done, reply with a brief summary: files changed, how you checked them, and what the next step must know. Do not start other steps.
${DESKTOP_NOTE} ${UNTRUSTED}`;

/**
 * Fallback settings. The team replaces model and effort from {@link coderChoice} unless config pins them.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: null, model: null };

/** Model and effort for each plan complexity. */
export const CODER_TIERS = Object.freeze({
    trivial: Object.freeze({ model: 'gpt-6-luna', effort: 'low' }),
    normal: Object.freeze({ model: 'gpt-6-luna', effort: 'medium' }),
    complex: Object.freeze({ model: 'gpt-6.1-sol', effort: 'high' }),
});

/**
 * Model and effort for this complexity. A configured model or effort replaces the tier.
 * @param {string} [complexity]
 * @param {{ model?: string | null, effort?: string | null }} [configured]
 * @returns {{ model: string, effort: string }}
 * @exports
 * @ai.hint pure
 */
export function coderChoice(complexity = 'normal', configured = {}) {
    const tier = CODER_TIERS[complexity] ?? CODER_TIERS.normal;
    return {
        model: configured.model || tier.model,
        effort: configured.effort || tier.effort,
    };
}

const CODE_FILE = /\.(?:js|mjs|cjs|ts|tsx|jsx|scss|css|html|vue|svelte|py|rs|go|java)$/i;

/**
 * True when the step is code, not a document, rule, skill, or manifest.
 * @param {string[]} [files]
 * @param {string} [goal]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isCodingStep(files = [], goal = '') {
    const mentioned = String(goal).match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
    const list = [...(Array.isArray(files) ? files : []), ...mentioned].map((file) => String(file).replace(/\\/g, '/'));
    return list.some((file) => CODE_FILE.test(file) && !/\.(?:config|d)\.[cm]?[jt]s$/.test(file));
}
