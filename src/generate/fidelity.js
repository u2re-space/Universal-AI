/**
 * @file src/generate/fidelity.js
 * @module generate/fidelity
 * @purpose Fidelity and creativity targets. The match itself is not measured.
 * @usedBy generate/brief, commands/gen
 * @exports DEFAULT_FIDELITY, DEFAULT_CREATIVITY, clampPercent, fidelityContract, fidelityInstructions
 * @ai.tags generate
 * @ai.hint pure
 * @changed 2026-10-15 Default fidelity 87, creativity 20, measured null.
 */

/** How closely the result should follow attached references. */
export const DEFAULT_FIDELITY = 87;
/** How much may be added that is not in the references. */
export const DEFAULT_CREATIVITY = 20;

/**
 * Accept an integer percent, or throw.
 * @param {number} value
 * @param {string} name Field name used in the error.
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function clampPercent(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name}: целое 0..100`);
    return value;
}

/**
 * Record the targets and the fact that no comparator ran.
 * @param {{ fidelity?: number, creativity?: number }} [options]
 * @returns {{ fidelity: number, creativity: number, measured: null, method: 'unmeasured', reason: string }}
 * @exports
 * @ai.hint pure
 */
export function fidelityContract({ fidelity = DEFAULT_FIDELITY, creativity = DEFAULT_CREATIVITY } = {}) {
    return {
        fidelity: clampPercent(fidelity, 'fidelity'),
        creativity: clampPercent(creativity, 'creativity'),
        measured: null,
        method: 'unmeasured',
        reason: 'Сверка с изображением макета не реализована: нет сравнения кадра и вёрстки.',
    };
}

/**
 * Tell the model what the two percents mean and that it must not invent a score.
 * @param {{ fidelity: number, creativity: number }} contract
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function fidelityInstructions(contract) {
    return [
        `Fidelity target: ${contract.fidelity}%. 100 follows the references' visible structure, text, palette, and block order. 0 may depart from them. The other ${100 - contract.fidelity}% is the allowed deviation.`,
        `Creativity: ${contract.creativity}%. 0 adds nothing that is not in the references. 100 may add sections, copy, and decoration freely. Creativity does not raise the allowed deviation from a reference.`,
        'Visual fidelity is not measured. Do not write a match percentage. Leave measured null.',
    ].join('\n');
}
