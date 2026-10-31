/**
 * @file src/openai/model-profiles.js
 * @module openai/model-profiles
 * @purpose Model metadata registry: context window, max output, supported reasoning levels, and the effort ceiling.
 * @usedBy core/config, agent/loop, agent/pace, roles/*
 * @exports EFFORT_ORDER, CONTEXT_LEVELS, DEFAULT_PROFILE, MODEL_PROFILES, profileFor, effortRank, capEffort, snapEffort, contextBytes
 * @ai.tags models, profiles, effort, context
 * @ai.hint pure
 * @changed 2026-10-26 Registry for 0.2.0: every model declares its window, output cap, effort ladder and ceiling.
 */

/**
 * Reasoning levels from the cheapest to the dearest. The index is the rank used in comparisons.
 * Includes 'none', which the pace ladder leaves out, so a ceiling may name any level.
 */
export const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Word levels of a context budget, in bytes. `auto` is absent on purpose: it resolves from the model window.
 */
export const CONTEXT_LEVELS = Object.freeze({
    small: 16 * 1024,
    normal: 96 * 1024,
    large: 512 * 1024,
    max: 8 * 1024 * 1024,
});

/**
 * Profile of a model the registry does not list. No ceiling and no ladder, so nothing is restricted.
 */
export const DEFAULT_PROFILE = Object.freeze({ window: 128 * 1024, maxOutput: 16384, ceiling: null, efforts: null });

/**
 * Known models.
 * `window`    — context window in bytes; the `auto` context level and the model choice both read it.
 * `maxOutput` — largest `max_output_tokens` the model accepts; decides how much of a task fits one call.
 * `ceiling`   — hardest stop for reasoning effort: a request above it is lowered to it. Null means no stop.
 * `efforts`   — the ladder this model is configured to tear across. Null means the whole ladder down to the ceiling.
 *               A request snaps to the nearest level of the set, preferring the one below it.
 * Override any field for one installation in the `models.<id>` section of the configuration.
 */
export const MODEL_PROFILES = Object.freeze({
    'gpt-6.1-sol': { window: 256 * 1024, maxOutput: 32768, ceiling: 'xhigh', efforts: null },
    'gpt-6.1-terra': { window: 256 * 1024, maxOutput: 32768, ceiling: 'max', efforts: null },
    'gpt-6-luna': { window: 256 * 1024, maxOutput: 16384, ceiling: 'max', efforts: null },
    'gpt-6-astra': { window: 200 * 1024, maxOutput: 32768, ceiling: 'xhigh', efforts: null },
    'gpt-6-luna-decisions': { window: 128 * 1024, maxOutput: 256, ceiling: null, efforts: null },
    'openai/gpt-6-luna-decisions': { window: 128 * 1024, maxOutput: 256, ceiling: null, efforts: null }
});

/** Vendor prefixes, so a qualified id resolves to the same profile as the bare one. */
const QUALIFIED_PREFIXES = Object.freeze(['openai/', 'anthropic/']);

/**
 * Strip a known vendor prefix: `openai/gpt-6.1-sol` finds the `gpt-6.1-sol` profile.
 * @param {string} model
 * @returns {string}
 * @ai.hint pure
 */
function bareModel(model) {
    const name = String(model ?? '').trim();
    for (const prefix of QUALIFIED_PREFIXES) {
        if (name.startsWith(prefix)) return name.slice(prefix.length);
    }
    return name;
}

/**
 * Profile of one model: registry values, then the `models.<id>` overrides of the configuration.
 * @param {string} model
 * @param {object} [overrides] the `models` section of the config
 * @returns {{ window: number, maxOutput: number, ceiling: string | null, efforts: string[] | null }}
 * @exports
 * @ai.hint pure
 */
export function profileFor(model, overrides = null) {
    const name = bareModel(model);
    const base = MODEL_PROFILES[name] ?? DEFAULT_PROFILE;
    const extra = overrides && typeof overrides === 'object' ? (overrides[name] ?? overrides[model]) : null;
    if (!extra || typeof extra !== 'object') return { ...base };
    const ceiling = Object.hasOwn(extra, 'ceiling')
        ? (extra.ceiling === null || EFFORT_ORDER.includes(extra.ceiling) ? extra.ceiling : base.ceiling)
        : base.ceiling;
    const efforts = Array.isArray(extra.efforts) && extra.efforts.length
        ? extra.efforts.filter((level) => EFFORT_ORDER.includes(level))
        : base.efforts;
    return {
        window: Number.isSafeInteger(extra.window) && extra.window > 0 ? extra.window : base.window,
        maxOutput: Number.isSafeInteger(extra.maxOutput) && extra.maxOutput > 0 ? extra.maxOutput : base.maxOutput,
        ceiling,
        efforts: efforts && efforts.length ? efforts : null,
    };
}

/**
 * Rank of an effort level, or -1 when the name is unknown.
 * @param {string | null} effort
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export const effortRank = (effort) => EFFORT_ORDER.indexOf(String(effort ?? ''));

/**
 * The stricter of two ceilings. Null means no limit, so a null side returns the other.
 * Used to combine the ceiling of a model with the ceiling of a role.
 * @param {string | null} a
 * @param {string | null} b
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function lowerEffort(a, b) {
    const rankA = effortRank(a);
    const rankB = effortRank(b);
    if (rankA < 0 && rankB < 0) return null;
    if (rankA < 0) return b;
    if (rankB < 0) return a;
    return rankA <= rankB ? a : b;
}

/**
 * Hard ceiling: lower `effort` to the profile ceiling when it sits above it.
 * An unknown name or a missing ceiling passes through untouched.
 * @param {string | null} effort
 * @param {{ ceiling?: string | null }} profile
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function capEffort(effort, profile) {
    const ceiling = profile?.ceiling;
    if (!ceiling) return effort;
    const wanted = effortRank(effort);
    const limit = effortRank(ceiling);
    if (wanted < 0 || limit < 0) return effort;
    return wanted <= limit ? effort : ceiling;
}

/**
 * Snap `effort` onto the ladder the model is configured to use, then apply the ceiling.
 * Snapping goes down first, since a level above the ladder costs less once it drops. Only a request
 * below the whole ladder rises to its cheapest level, because the model is not asked to go lower.
 * @param {string | null} effort
 * @param {{ ceiling?: string | null, efforts?: string[] | null }} profile
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function snapEffort(effort, profile) {
    const ladder = profile?.efforts;
    if (!Array.isArray(ladder) || !ladder.length) return capEffort(effort, profile);
    const wanted = effortRank(effort);
    if (wanted < 0) return capEffort(effort, profile);
    const ranks = ladder.map(effortRank).filter((rank) => rank >= 0);
    if (!ranks.length) return capEffort(effort, profile);
    const below = ranks.filter((rank) => rank <= wanted).sort((a, b) => b - a)[0];
    const picked = below ?? ranks.slice().sort((a, b) => a - b)[0];
    return capEffort(EFFORT_ORDER[picked], profile);
}

/**
 * Byte budget behind a context level.
 * A number returns as is, `auto` takes the model window, a word takes its size, and an unknown value
 * falls back so a typo in the configuration cannot ask for an unbounded context.
 * @param {string | number | null} level
 * @param {{ window?: number }} profile
 * @param {number} [fallback]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function contextBytes(level, profile, fallback = CONTEXT_LEVELS.normal) {
    if (Number.isSafeInteger(level) && level > 0) return level;
    if (typeof level === 'string') {
        const name = level.trim().toLowerCase();
        if (name === 'auto') return profile?.window ?? DEFAULT_PROFILE.window;
        if (Object.hasOwn(CONTEXT_LEVELS, name)) return CONTEXT_LEVELS[name];
    }
    return fallback;
}
