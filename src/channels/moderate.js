/**
 * @file src/channels/moderate.js
 * @module channels/moderate
 * @purpose Moderate text with /moderations or, when that route is missing, with decisions.
 * @depends channels/decide, channels/questions, channels/verdict
 * @usedBy channels/handle, channels/dispatch, channels/tool-handlers
 * @exports moderateText
 * @ai.tags moderation, decisions
 * @ai.hint io
 * @changed 2026-10-15 auto falls back from omni-moderation-latest to gpt-6-luna-decisions.
 */

import { requestDecision } from './decide.js';
import { questionsFor } from './questions.js';
import { shouldFallbackModeration, verdictFromAnswers, verdictFromModeration } from './verdict.js';

/**
 * Record tokens when a ledger was passed in.
 * @param {object|null} ledger
 * @param {string} kind
 * @param {string|null} model
 * @param {object|null} usage
 * @param {string|null} id
 * @returns {void}
 * @ai.hint io
 */
function record(ledger, kind, model, usage, id) {
    ledger?.record({ model, usage, kind, responseId: id ?? null });
}

/**
 * Classify text. mode auto tries POST /moderations and uses decisions after 404, 405, or 501.
 * A model id containing "decision" skips /moderations.
 * @param {{ client: object, input: string|string[], config: object, preset?: string, model?: string, context?: object, signal?: AbortSignal, ledger?: object|null }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function moderateText({ client, input, config, preset, model, context = null, signal, ledger = null } = {}) {
    const text = asText(input);
    const pack = preset || config.moderation?.preset || 'community';
    const thresholds = config.decisions ?? {};
    const moderationModel = model || config.moderation?.model || 'omni-moderation-latest';
    const mode = config.moderation?.mode || 'auto';
    const namedDecision = /decision/i.test(String(model ?? ''));
    if (mode !== 'decisions' && !namedDecision) {
        try {
            const raw = await client.moderations.create({ model: moderationModel, input: Array.isArray(input) ? input : text }, { signal });
            const verdict = { ...verdictFromModeration(raw, thresholds), preset: pack };
            record(ledger, 'moderation', verdict.model, raw.usage ?? null, verdict.id);
            return verdict;
        } catch (error) {
            if (mode === 'moderations' || !shouldFallbackModeration(error)) throw error;
        }
    }
    const decisionModel = namedDecision ? model : (config.decisions?.model || 'gpt-6-luna-decisions');
    const state = { text, preset: pack, ...(context ? { context } : {}) };
    try {
        const raw = await requestDecision(client, { model: decisionModel, state, questions: questionsFor(pack), signal });
        const verdict = {
            ...verdictFromAnswers(raw.answers, thresholds),
            source: 'decisions', model: raw.model, id: raw.id, preset: pack, answers: raw.answers, usage: raw.usage,
        };
        record(ledger, 'decision', verdict.model, raw.usage, raw.id);
        return verdict;
    } catch (error) {
        if (error?.code !== 'DECISIONS_UNAVAILABLE') throw error;
        return {
            action: 'allow', scores: {}, top: null, choice: null, confidence: null, flagged: false,
            source: 'skipped', model: null, id: null, preset: pack,
        };
    }
}

/**
 * One string, or several strings joined by newlines.
 * @param {string|string[]} input
 * @returns {string}
 * @ai.hint pure
 */
function asText(input) {
    if (typeof input === 'string' && input.trim()) return input.trim();
    if (Array.isArray(input) && input.length && input.every((item) => typeof item === 'string')) {
        const text = input.join('\n').trim();
        if (text) return text;
    }
    throw new TypeError('input должен быть непустой строкой или массивом строк.');
}
