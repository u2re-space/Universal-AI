/**
 * @file src/channels/verdict.js
 * @module channels/verdict
 * @purpose Turn decision probabilities and moderation scores into allow, review, or hide.
 * @depends channels/questions, openai/errors
 * @usedBy channels/moderate, channels/dispatch, agent/team
 * @exports verdictFromAnswers, verdictFromModeration, routeFlag, shouldFallbackModeration
 * @ai.tags decisions, moderation
 * @ai.hint pure
 * @changed 2026-10-15 Thresholds and the omni-moderation shape.
 */

import { ApiError } from '../openai/errors.js';
import { RISK_NAMES } from './questions.js';

const RANK = { allow: 0, review: 1, hide: 2 };

/**
 * True when a category should be reviewed rather than deleted.
 * @param {string} name
 * @returns {boolean}
 * @ai.hint pure
 */
function crisis(name) {
    return name === 'self_harm' || name.startsWith('self_harm') || name.startsWith('self-harm');
}

/**
 * Read reviewAt and blockAt. blockAt is never below reviewAt.
 * @param {{ reviewAt?: number, blockAt?: number }} [thresholds]
 * @returns {{ reviewAt: number, blockAt: number }}
 * @ai.hint pure
 */
function bounds(thresholds = {}) {
    const reviewAt = Number.isFinite(thresholds.reviewAt) ? thresholds.reviewAt : 0.5;
    const blockAt = Number.isFinite(thresholds.blockAt) ? Math.max(thresholds.blockAt, reviewAt) : 0.9;
    return { reviewAt, blockAt };
}

/**
 * Map Decisions `answers` to an action.
 * A high self-harm score is review, not hide. A stricter `action` choice can raise the result.
 * @param {object} answers
 * @param {{ reviewAt?: number, blockAt?: number }} [thresholds]
 * @returns {{ action: 'allow'|'review'|'hide', scores: object, top: string|null, choice: string|null, confidence: number|null, flagged: boolean }}
 * @exports
 * @ai.hint pure
 */
export function verdictFromAnswers(answers, thresholds = {}) {
    const { reviewAt, blockAt } = bounds(thresholds);
    const scores = {};
    let maxRisk = 0;
    let top = null;
    let maxCrisis = 0;
    for (const [name, answer] of Object.entries(answers ?? {})) {
        if (answer?.type !== 'noul' || typeof answer.noul !== 'number') continue;
        scores[name] = answer.noul;
        if (crisis(name)) {
            if (answer.noul >= maxCrisis) maxCrisis = answer.noul;
            continue;
        }
        if (!RISK_NAMES.includes(name)) continue;
        if (answer.noul >= maxRisk) { maxRisk = answer.noul; top = name; }
    }
    let action = 'allow';
    if (maxRisk >= blockAt) action = 'hide';
    else if (maxRisk >= reviewAt || maxCrisis >= reviewAt) action = 'review';
    const choice = answers?.action?.type === 'choice' ? answers.action.choice : null;
    const confidence = typeof answers?.action?.confidence === 'number' ? answers.action.confidence : null;
    if (choice && RANK[choice] !== undefined && RANK[choice] > RANK[action] && (confidence === null || confidence >= reviewAt)) action = choice;
    const handoff = answers?.handoff?.type === 'noul' ? answers.handoff.noul : null;
    if (action === 'allow' && typeof handoff === 'number' && handoff >= reviewAt) action = 'review';
    if (action === 'hide' && maxCrisis >= reviewAt && maxCrisis >= maxRisk) action = 'review';
    return { action, scores, top, choice: RANK[choice] !== undefined ? choice : null, confidence, flagged: action !== 'allow' };
}

/**
 * Map one OpenAI moderations result to the same action shape.
 * @param {object} raw Response from POST /moderations.
 * @param {{ reviewAt?: number, blockAt?: number }} [thresholds]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function verdictFromModeration(raw, thresholds = {}) {
    const result = raw?.results?.[0];
    if (!result || typeof result !== 'object') {
        throw new ApiError('Ответ /moderations без results.', { code: 'INVALID_RESPONSE' });
    }
    const { reviewAt, blockAt } = bounds(thresholds);
    const scores = {};
    let maxRisk = 0;
    let top = null;
    let maxCrisis = 0;
    for (const [name, score] of Object.entries(result.category_scores ?? {})) {
        if (typeof score !== 'number') continue;
        scores[name] = score;
        if (crisis(name)) {
            if (score >= maxCrisis) maxCrisis = score;
            continue;
        }
        if (score >= maxRisk) { maxRisk = score; top = name; }
    }
    let action = 'allow';
    if (result.flagged && maxRisk >= blockAt) action = 'hide';
    else if (result.flagged || maxRisk >= reviewAt || maxCrisis >= reviewAt) action = 'review';
    if (action === 'hide' && maxCrisis >= reviewAt && maxCrisis >= maxRisk) action = 'review';
    return {
        action, scores, top, choice: null, confidence: null, flagged: action !== 'allow',
        categories: result.categories ?? {},
        source: 'moderations', model: raw.model ?? null, id: raw.id ?? null,
    };
}

/**
 * Encoder or planner from a route preset. A high `risky` score stays with the planner.
 * @param {object} answers
 * @param {{ blockAt?: number }} [thresholds]
 * @returns {'encoder'|'planner'|null}
 * @exports
 * @ai.hint pure
 */
export function routeFlag(answers, { blockAt = 0.9 } = {}) {
    if (answers?.risky?.type === 'noul' && typeof answers.risky.noul === 'number' && answers.risky.noul >= blockAt) return 'planner';
    if (answers?.next?.choice === 'encode') return 'encoder';
    if (answers?.next?.choice === 'plan') return 'planner';
    return null;
}

/**
 * True when /moderations is missing on this gateway and decisions can replace it.
 * A ordinary 400 (bad input) is not a missing endpoint.
 * @param {Error} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function shouldFallbackModeration(error) {
    if (!(error instanceof ApiError)) return false;
    if ([404, 405, 501].includes(error.status)) return true;
    const text = `${error.message} ${error.apiCode ?? ''}`.toLowerCase();
    return error.status === 400 && /not found|unknown endpoint|unrecognized|no such/.test(text);
}
