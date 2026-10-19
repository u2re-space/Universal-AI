/**
 * @file src/agent/pace.js
 * @module agent/pace
 * @purpose Choose policy, model rung, effort, stages, and step merge from speed and quality.
 * @depends generate/fidelity
 * @usedBy agent/team
 * @exports ceilingIndex, mergeSteps, acceptanceParagraph, resolvePace, applyPins, clampModel
 * @ai.tags team, pace
 * @ai.hint pure
 * @changed 2026-10-19 Speed, quality, and pace decide a team run.
 */

import { effectiveFidelity } from '../generate/fidelity.js';

const ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const RANK = Object.freeze({ trivial: 0, normal: 1, complex: 2 });

/**
 * Highest ladder index quality may use.
 * @param {number} quality
 * @param {number} count
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function ceilingIndex(quality, count) {
    const n = Math.max(1, count);
    return Math.min(n - 1, Math.floor(quality * n / 100));
}

/**
 * @param {string} mode
 * @param {number} speed
 * @param {string | null} label
 * @returns {'a' | 'b' | 'c'}
 * @ai.hint pure
 */
function policyOf(mode, speed, label) {
    if (mode === 'a' || mode === 'b' || mode === 'c') return mode;
    if (speed <= 9) return 'b';
    if (speed <= 66) return 'a';
    if (label === 'trivial') return 'c';
    return 'a';
}

/**
 * @param {number} speed
 * @param {number} quality
 * @returns {number}
 * @ai.hint pure
 */
function effortShift(speed, quality) {
    if (speed <= 9 && quality >= 34) return 1;
    if (speed <= 66) return 0;
    if (speed <= 83) return quality >= 67 ? 0 : -1;
    if (quality <= 33) return -2;
    return -1;
}

/**
 * @param {string} base
 * @param {number} shift
 * @param {string} floor
 * @returns {string}
 * @ai.hint pure
 */
function applyShift(base, shift, floor) {
    const index = ORDER.indexOf(base) + shift;
    const min = ORDER.indexOf(floor);
    return ORDER[Math.max(min, Math.min(ORDER.length - 1, index))];
}

/**
 * @param {string} base
 * @param {number} speed
 * @param {number} quality
 * @param {boolean} protect
 * @returns {string}
 * @ai.hint pure
 */
function effortFor(base, speed, quality, protect) {
    const shift = effortShift(speed, quality);
    const floor = protect && quality >= 67 && shift < 0 ? 'medium' : 'minimal';
    return applyShift(base, shift, floor);
}

/**
 * @param {string | null} label
 * @param {number} speed
 * @param {number} adjusted
 * @returns {number}
 * @ai.hint pure
 */
function plannerRung(label, speed, adjusted) {
    if (label === 'trivial') return 0;
    if (speed >= 67) return adjusted;
    return Math.min(adjusted, 1);
}

/**
 * @param {string} complexity
 * @param {number} speed
 * @param {number} adjusted
 * @returns {number}
 * @ai.hint pure
 */
function authorRung(complexity, speed, adjusted) {
    if (complexity === 'trivial') return 0;
    if (complexity === 'normal') return speed >= 67 ? Math.min(adjusted, 1) : 0;
    return speed >= 67 ? adjusted : Math.max(0, adjusted - 1);
}

/**
 * @param {string} label
 * @param {number} adjusted
 * @returns {number}
 * @ai.hint pure
 */
function singleRung(label, adjusted) {
    if (label === 'trivial') return 0;
    if (label === 'normal') return Math.min(adjusted, 1);
    return adjusted;
}

/**
 * Fold adjacent steps that share an author and a rung.
 * @param {object[]} steps
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function mergeSteps(steps) {
    const out = [];
    for (const step of steps) {
        const prev = out.at(-1);
        const same = prev && prev.author === step.author && prev.rung === step.rung;
        if (!same) {
            out.push({ ...step, files: [...(step.files ?? [])] });
            continue;
        }
        prev.goal = `${prev.goal}\n\n${step.goal}`;
        prev.details = `${prev.details}\n\n${step.details}`;
        prev.verify = `${prev.verify}\n\n${step.verify}`;
        if (RANK[step.complexity] > RANK[prev.complexity]) prev.complexity = step.complexity;
        for (const file of step.files ?? []) if (!prev.files.includes(file)) prev.files.push(file);
    }
    return out;
}

/**
 * English acceptance instructions for the planner and the reviewer.
 * @param {'loose' | 'normal' | 'strict'} tone
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function acceptanceParagraph(tone) {
    if (tone === 'loose') return 'Acceptance is loose. Write at most three criteria. Each criterion is one observable result. Accept when the main goal is met. Polish, extra files, and weak tests are not high severity.';
    if (tone === 'strict') return 'Acceptance is strict. Write at most eight criteria. Edge cases and checks are in scope. Accept only when the goal is met and no high-severity issue remains.';
    return 'Acceptance is normal. Write at most six criteria. Send the work back for a high-severity issue. Let cosmetic issues pass.';
}

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {'trivial' | 'normal' | 'complex'}
 * @ai.hint pure
 */
function knownComplexity(value, fallback = 'normal') {
    return value === 'trivial' || value === 'normal' || value === 'complex' ? value : fallback;
}

/**
 * @param {object[]} steps
 * @param {{ speed: number, quality: number, models: string[], adjusted: number }} context
 * @returns {object[]}
 * @ai.hint pure
 */
function decorate(steps, { speed, quality, models, adjusted }) {
    return steps.map((step) => {
        const complexity = knownComplexity(step.complexity);
        const rung = authorRung(complexity, speed, adjusted);
        const base = complexity === 'trivial' ? 'low' : complexity === 'complex' ? 'high' : 'medium';
        const author = step.author === 'coder' || step.author === 'writer' ? step.author : 'worker';
        return {
            author, complexity, rung, model: models[rung],
            effort: effortFor(base, speed, quality, complexity === 'complex'),
            files: Array.isArray(step.files) ? [...step.files] : [],
            goal: String(step.goal ?? ''), details: String(step.details ?? ''), verify: String(step.verify ?? ''),
            kind: step.kind ?? 'work',
        };
    });
}

/**
 * Frozen team shape for one speed, quality, label, and optional step list.
 * @param {object} [input]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function resolvePace({
    speed, quality, mode, models, label = null, steps = null, generation = false,
    fidelity = null, stepCapOverride = null, task = '', author = 'worker',
} = {}) {
    const policy = policyOf(mode, speed, label);
    const raw = ceilingIndex(quality, models.length);
    const adjusted = label === 'trivial' ? Math.max(0, raw - 1) : raw;
    const fast = policy === 'a' && speed >= 67 && (label === 'normal' || label === 'complex');
    const reviewRounds = quality <= 33 ? 0 : quality <= 66 ? 1 : 2;
    const acceptance = quality <= 33 ? 'loose' : quality <= 66 ? 'normal' : 'strict';
    let reviewMode = 'plan';
    if (policy === 'c' || (policy === 'a' && label === 'trivial')) reviewMode = 'off';
    else if (policy === 'a') reviewMode = 'force';
    let collect = 'allow';
    if (policy === 'c' || fast || (policy === 'a' && label === 'trivial')) collect = 'off';
    let stepCap = policy === 'b' ? (generation ? 8 : 16)
        : fast && label === 'complex' ? (generation ? 1 : 2)
            : fast ? (generation ? 2 : 4)
                : policy === 'c' ? 1
                    : label === 'trivial' ? (generation ? 2 : 4)
                        : (generation ? 4 : 12);
    if (policy !== 'c' && Number.isInteger(stepCapOverride)) stepCap = Math.max(1, stepCapOverride);
    const role = (rung, base, protect) => ({
        rung, model: models[rung], effort: effortFor(base, speed, quality, protect),
    });
    const planner = role(plannerRung(label, speed, adjusted), plannerRung(label, speed, adjusted) === 0 ? 'medium' : 'high', true);
    const reviewerBase = quality >= 67 ? 'high' : 'medium';
    const directive = {
        ready: label === 'trivial' || label === 'normal' || label === 'complex',
        policy, ceilingIndex: adjusted, ceilingModel: models[adjusted],
        merge: fast, stepCap, reviewRounds, reviewMode, collect, acceptance,
        fidelity: Number.isInteger(fidelity) ? { stated: fidelity, effective: effectiveFidelity(fidelity, quality) } : null,
        roles: {
            classifier: role(0, 'low', false),
            planner, collector: role(0, 'low', false),
            reviewer: role(quality >= 67 ? adjusted : Math.min(adjusted, 1), reviewerBase, true),
            summarizer: role(0, 'low', false),
        },
        steps: null,
    };
    if (!directive.ready) return directive;
    if (policy === 'c' && !Array.isArray(steps)) {
        const complexity = knownComplexity(label);
        const rung = singleRung(label, adjusted);
        const base = complexity === 'trivial' ? 'low' : complexity === 'complex' ? 'high' : 'medium';
        directive.steps = [{
            author: author === 'coder' || author === 'writer' ? author : 'worker',
            complexity, rung, model: models[rung],
            effort: effortFor(base, speed, quality, complexity === 'complex'),
            files: [], goal: String(task), details: '', verify: '', kind: 'work',
        }];
        return directive;
    }
    if (Array.isArray(steps)) {
        const decorated = decorate(steps, { speed, quality, models, adjusted });
        directive.steps = fast ? mergeSteps(decorated) : decorated;
    }
    return directive;
}

/**
 * Replace a role's model or effort when that side is pinned.
 * @param {object} directive
 * @param {object} [configRoles]
 * @param {object} [rolePins]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function applyPins(directive, configRoles = {}, rolePins = {}) {
    const apply = (name, role) => {
        const pin = rolePins[name] ?? {};
        const configured = configRoles[name] ?? {};
        return {
            ...role,
            model: pin.model && configured.model ? configured.model : role.model,
            effort: pin.effort && configured.effort ? configured.effort : role.effort,
        };
    };
    const roles = Object.fromEntries(Object.entries(directive.roles).map(([name, role]) => [name, apply(name, role)]));
    const steps = directive.steps?.map((step) => apply(step.author, step)) ?? null;
    return { ...directive, roles, steps };
}

/**
 * Drop a ladder model that sits above the ceiling. A pin or an unknown model stays.
 * @param {string} model
 * @param {string[]} models
 * @param {number} ceiling
 * @param {boolean} pinned
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function clampModel(model, models, ceiling, pinned) {
    if (pinned || typeof model !== 'string') return model;
    const index = models.indexOf(model);
    if (index < 0 || index <= ceiling) return model;
    return models[ceiling];
}
