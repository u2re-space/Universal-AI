/**
 * @file src/agent/step-budget.js
 * @module agent/step-budget
 * @purpose Choose how many passes and tool turns a plan step may spend.
 * @usedBy agent/team, generate/scaffold
 * @exports GENERATION_MAX_STEPS, planLimit, stepAllowance
 * @ai.tags team, limits
 * @ai.hint pure
 * @changed 2026-10-17 A generation step with no listed file is the interface. Artwork uses the full ceiling.
 */

/** A generation plan stays short so boilerplate is not a step each. */
export const GENERATION_MAX_STEPS = 4;

const BOILERPLATE = /^(?:package\.json|scripts\/generate\.js|\.rules\/|\.skills\/)/;
const HEAVY = /\.(?:tsx|jsx|scss|css|js|ts|html)$/;
const VISUAL = /artwork|generate_image|edit_image|image_generation|illustration|\blayout\b|\bstyling\b/i;

/**
 * Step cap for this run. Generation never asks for more than {@link GENERATION_MAX_STEPS}.
 * @param {{ maxSteps?: number, generation?: boolean }} [options]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function planLimit({ maxSteps = 12, generation = false, pace = false } = {}) {
    const cap = Math.max(1, maxSteps);
    if (pace) return cap;
    return generation ? Math.min(cap, GENERATION_MAX_STEPS) : cap;
}

/**
 * Passes and turn caps for one step. `ceiling` is `workerMaxTurnsPerStep`.
 * A generation step is one pass. A normal source file still gets a short surface pass and a longer body pass.
 * @param {{ complexity?: string, kind?: string, files?: string[], goal?: string, details?: string, generation?: boolean, ceiling?: number }} options
 * @returns {{ passes: number, maxTurns?: number, surfaceTurns?: number, bodyTurns?: number }}
 * @exports
 * @ai.hint pure
 */
export function stepAllowance({ complexity = 'normal', kind = 'work', files = [], goal = '', details = '', generation = false, ceiling = 25 } = {}) {
    const limit = Math.max(1, ceiling);
    const within = (value) => Math.min(value, limit);
    const list = (Array.isArray(files) ? files : []).map((file) => String(file).replace(/\\/g, '/'));
    const only = list.length === 1 ? list[0] : null;
    if (complexity === 'trivial') return { passes: 1, maxTurns: within(8) };
    if (kind === 'compat') return { passes: 1, maxTurns: within(12) };
    if (only && BOILERPLATE.test(only)) return { passes: 1, maxTurns: within(4) };
    if (generation) {
        if (VISUAL.test(`${goal}\n${details}`)) return { passes: 1, maxTurns: limit };
        const heavy = list.some((file) => HEAVY.test(file) && !file.endsWith('.config.js'));
        const light = list.length > 0 && !heavy;
        return { passes: 1, maxTurns: within(light ? 10 : 20) };
    }
    if (list.length !== 1) return { passes: 1, maxTurns: within(16) };
    const heavy = HEAVY.test(only) && !only.endsWith('.config.js');
    if (!heavy) return { passes: 1, maxTurns: within(10) };
    return { passes: 2, surfaceTurns: within(4), bodyTurns: within(16) };
}
