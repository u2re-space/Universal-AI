/**
 * @file src/agent/pace.js
 * @module agent/pace
 * @purpose Choose policy, model rung, effort, stages, and step merge from speed and quality.
 * @depends generate/fidelity, openai/model-profiles
 * @usedBy agent/team, core/config, commands/flags
 * @exports ceilingIndex, mergeSteps, acceptanceParagraph, guaranteesParagraph, assertPaceBudget, resolvePace, applyPins, clampModel
 * @ai.tags team, pace
 * @ai.hint pure
 * @changed 2026-10-26 Every effort the directive carries is snapped to the ladder and ceiling of its model.
 */

import { effectiveFidelity } from '../generate/fidelity.js';
import { FORBIDDEN_MODELS as REVIEWER_FORBIDDEN } from '../roles/reviewer.js';
import { profileFor, snapEffort, lowerEffort } from '../openai/model-profiles.js';

export const PACE_QUALITY_MESSAGE = 'pace.quality: целое 0..200, и speed + quality не больше 200';
export const PACE_SPEED_MESSAGE = 'pace.speed: целое от 0, и speed + quality не больше 200';

/**
 * Highest rung at or below `wanted` whose model may serve the reviewer.
 * gpt-6-astra is forbidden for review, so the ladder steps down instead.
 * @param {string[]} models
 * @param {number} wanted
 * @returns {number}
 * @ai.hint pure
 */
function reviewerRung(models, wanted) {
    let index = Math.max(0, Math.min(models.length - 1, wanted));
    while (index > 0 && REVIEWER_FORBIDDEN.includes(models[index])) index--;
    return index;
}

/**
 * Reject a pair outside the shared budget. Quality is checked first.
 * @param {number} speed
 * @param {number} quality
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function assertPaceBudget(speed, quality) {
    if (!Number.isInteger(quality) || quality < 0 || quality > 200) throw new Error(PACE_QUALITY_MESSAGE);
    if (!Number.isInteger(speed) || speed < 0 || speed + quality > 200) throw new Error(PACE_SPEED_MESSAGE);
}

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
 * @param {number} paceSpeed
 * @param {number} modelQuality
 * @param {boolean} protect
 * @param {number} [recklessExtra]
 * @returns {string}
 * @ai.hint pure
 */
function effortFor(base, paceSpeed, modelQuality, protect, recklessExtra = 0) {
    const shift = effortShift(paceSpeed, modelQuality) + recklessExtra;
    const floor = recklessExtra < 0 ? 'minimal' : (protect && modelQuality >= 67 && shift < 0 ? 'medium' : 'minimal');
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
 * English sentence for a budget that is no longer stable. Steady pace adds nothing.
 * @param {'steady' | 'strained' | 'broken'} guarantees
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function guaranteesParagraph(guarantees) {
    if (guarantees === 'strained') return 'Speed and quality together exceed the stable budget. Balance is not promised.';
    if (guarantees === 'broken') return 'This pace is past the safe speed. Acceptance criteria are not binding. A step may stop before its plan is finished. Finish the smallest usable slice and stop.';
    return '';
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
 * @param {{ modelSpeed: number, paceSpeed: number, modelQuality: number, models: string[], adjusted: number, recklessExtra: number, bounded: Function }} context
 * @returns {object[]}
 * @ai.hint pure
 */
function decorate(steps, { modelSpeed, paceSpeed, modelQuality, models, adjusted, recklessExtra, bounded }) {
    return steps.map((step) => {
        const complexity = knownComplexity(step.complexity);
        const rung = authorRung(complexity, modelSpeed, adjusted);
        const base = complexity === 'trivial' ? 'low' : complexity === 'complex' ? 'high' : 'medium';
        const author = step.author === 'coder' || step.author === 'writer' ? step.author : 'worker';
        const model = models[rung];
        return {
            author, complexity, rung, model,
            effort: bounded(model, effortFor(base, paceSpeed, modelQuality, complexity === 'complex', recklessExtra)),
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
    fidelity = null, stepCapOverride = null, task = '', author = 'worker', modelProfiles = null,
} = {}) {
    assertPaceBudget(speed, quality);
    /** Snap one effort onto the ladder and ceiling of the model that would carry it. */
    const bounded = (model, level) => snapEffort(level, profileFor(model, modelProfiles));
    const modelQuality = Math.min(quality, 100);
    const modelSpeed = Math.min(100, speed + Math.max(0, quality - 100));
    const paceSpeed = Math.min(speed, 100);
    const guarantees = speed + quality <= 100 ? 'steady' : speed <= 100 ? 'strained' : 'broken';
    const recklessExtra = speed <= 100 ? 0 : speed <= 150 ? -1 : -2;
    const policy = policyOf(mode, paceSpeed, label);
    const raw = ceilingIndex(modelQuality, models.length);
    const adjusted = label === 'trivial' ? Math.max(0, raw - 1) : raw;
    const fast = policy === 'a' && paceSpeed >= 67 && (label === 'normal' || label === 'complex');
    const reviewRounds = modelQuality <= 33 ? 0 : modelQuality <= 66 ? 1 : 2;
    const acceptance = modelQuality <= 33 ? 'loose' : modelQuality <= 66 ? 'normal' : 'strict';
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
    if (guarantees !== 'broken' && policy !== 'c' && Number.isInteger(stepCapOverride)) stepCap = Math.max(1, stepCapOverride);
    const role = (rung, base, protect) => {
        const model = models[rung];
        return { rung, model, effort: bounded(model, effortFor(base, paceSpeed, modelQuality, protect, recklessExtra)) };
    };
    const planner = role(plannerRung(label, modelSpeed, adjusted), plannerRung(label, modelSpeed, adjusted) === 0 ? 'medium' : 'high', true);
    const reviewerBase = modelQuality >= 67 ? 'xhigh' : 'high';
    const directive = {
        ready: label === 'trivial' || label === 'normal' || label === 'complex',
        policy, ceilingIndex: adjusted, ceilingModel: models[adjusted],
        merge: fast, stepCap, reviewRounds, reviewMode, collect, acceptance, guarantees,
        fidelity: Number.isInteger(fidelity) ? { stated: fidelity, effective: effectiveFidelity(fidelity, quality) } : null,
        roles: {
            classifier: role(1, 'xhigh', false),
            planner, architect: role(plannerRung(label, modelSpeed, adjusted), 'high', true),
            orchestrator: role(1, 'high', false),
            reviewer: role(reviewerRung(models, modelQuality >= 67 ? adjusted : Math.min(adjusted, 1)), reviewerBase, true),
            summarizer: role(0, 'max', false),
            extractor: role(0, 'high', false),
        },
        steps: null,
    };
    if (guarantees === 'broken') {
        directive.reviewMode = 'off';
        directive.reviewRounds = 0;
        directive.stepCap = 1;
    }
    if (!directive.ready) return directive;
    if (policy === 'c' && !Array.isArray(steps)) {
        const complexity = knownComplexity(label);
        const rung = singleRung(label, adjusted);
        const base = complexity === 'trivial' ? 'low' : complexity === 'complex' ? 'high' : 'medium';
        const model = models[rung];
        directive.steps = [{
            author: author === 'coder' || author === 'writer' ? author : 'worker',
            complexity, rung, model,
            effort: bounded(model, effortFor(base, paceSpeed, modelQuality, complexity === 'complex', recklessExtra)),
            files: [], goal: String(task), details: '', verify: '', kind: 'work',
        }];
        return directive;
    }
    if (Array.isArray(steps)) {
        const decorated = decorate(steps, { modelSpeed, paceSpeed, modelQuality, models, adjusted, recklessExtra, bounded });
        directive.steps = fast ? mergeSteps(decorated) : decorated;
    }
    return directive;
}

/**
 * Replace a role's model or effort when that side is pinned, then re-apply the ceilings.
 * A ceiling is a hard limit, so it holds over a pinned effort too: a pin asks for a level,
 * the model and the role decide which level they can actually serve.
 * @param {object} directive
 * @param {object} [configRoles]
 * @param {object} [rolePins]
 * @param {object} [modelProfiles] the `models` section of the config
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function applyPins(directive, configRoles = {}, rolePins = {}, modelProfiles = null) {
    const apply = (name, role) => {
        const pin = rolePins[name] ?? {};
        const configured = configRoles[name] ?? {};
        const model = pin.model && configured.model ? configured.model : role.model;
        const wanted = pin.effort && configured.effort ? configured.effort : role.effort;
        const profile = profileFor(model, modelProfiles);
        return {
            ...role,
            model,
            effort: snapEffort(wanted, { ...profile, ceiling: lowerEffort(profile.ceiling, configured.maxEffort ?? null) }),
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
