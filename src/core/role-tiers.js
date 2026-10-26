/**
 * @file src/core/role-tiers.js
 * @module core/role-tiers
 * @purpose Turn `roles.<name>.tiers` into a model and an effort for trivial, normal, and complex work.
 * @usedBy core/config
 * @exports TIER_LEVELS, normalizeTiers, tierChoice
 * @ai.tags config, roles, models
 * @ai.hint pure
 * @changed 2026-10-26 Ladder form: one entry per model, each with the effort levels that model serves.
 */

/** Work sizes a tier map answers for, smallest first. */
export const TIER_LEVELS = Object.freeze(['trivial', 'normal', 'complex']);

/**
 * The size a caller named. Anything else counts as normal work, because a size was already stated.
 * @param {unknown} complexity
 * @returns {'trivial' | 'normal' | 'complex' | null}
 * @ai.hint pure
 */
function levelOf(complexity) {
    if (complexity == null) return null;
    return complexity === 'trivial' || complexity === 'complex' ? complexity : 'normal';
}

/**
 * Read a role's tiers in either accepted shape.
 *
 * Ladder form: `[{ model, effort: [level, ...] }, ...]` — one entry per model rung, each with the
 * effort levels that model may serve. Complexity advances both axes: the first rung and its first
 * effort for trivial, the next for normal, and so on; the model stops at the last rung, the effort
 * at the top of that rung's ladder. With two rungs this is the old [0,0] → [1,1] → [1,2] table.
 *
 * Explicit form: `{ trivial: { model, effort }, normal: { model, effort }, complex: { model, effort } }`
 * — one entry per tier, for a role whose effort does not follow its model ladder.
 *
 * A missing model or effort stays null and the role's own field applies.
 * @param {unknown} value
 * @returns {{ trivial: object, normal: object, complex: object } | null} null when the value is empty.
 * @ai.hint pure
 */
export function normalizeTiers(value) {
    if (Array.isArray(value)) {
        const rungs = value
            .filter((entry) => entry && typeof entry === 'object' && typeof entry.model === 'string' && entry.model.trim())
            .map((entry) => ({
                model: entry.model.trim(),
                effort: Array.isArray(entry.effort) ? entry.effort.filter((level) => typeof level === 'string' && level.trim()) : [],
            }));
        if (!rungs.length) return null;
        return Object.fromEntries(TIER_LEVELS.map((level, index) => {
            const rung = rungs[Math.min(index, rungs.length - 1)];
            return [level, {
                model: rung.model,
                effort: rung.effort.length ? rung.effort[Math.min(index, rung.effort.length - 1)] : null,
            }];
        }));
    }
    if (!value || typeof value !== 'object') return null;
    const map = {};
    for (const level of TIER_LEVELS) {
        const tier = value[level];
        if (!tier || typeof tier !== 'object') continue;
        map[level] = {
            model: typeof tier.model === 'string' && tier.model.trim() ? tier.model.trim() : null,
            effort: typeof tier.effort === 'string' && tier.effort.trim() ? tier.effort.trim() : null,
        };
    }
    return Object.keys(map).length ? map : null;
}

/**
 * Model and effort a role's tiers name for this work size. Null means the role's own fields apply.
 * @param {unknown} tiers `roles.<name>.tiers`
 * @param {string | null | undefined} complexity
 * @returns {{ model: string | null, effort: string | null } | null}
 * @exports
 * @ai.hint pure
 */
export function tierChoice(tiers, complexity = null) {
    const level = levelOf(complexity);
    if (!level) return null;
    return normalizeTiers(tiers)?.[level] ?? null;
}
