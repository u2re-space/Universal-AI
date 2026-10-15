/**
 * @file src/channels/decide.js
 * @module channels/decide
 * @purpose POST /v1/decisions and check the answer object.
 * @depends openai/errors, channels/questions
 * @usedBy channels/moderate, channels/dispatch, agent/team
 * @exports requestDecision
 * @ai.tags decisions
 * @ai.hint io
 * @changed 2026-10-15 Decisions client wrapper.
 */

import { ApiError } from '../openai/errors.js';
import { validateQuestions, validateState } from './questions.js';

/**
 * Ask a decision model. `questions` must already be a Decisions questions object.
 * @param {object} client createClient() result with decisions.create.
 * @param {{ model: string, state: string|object|Array, questions: object, signal?: AbortSignal }} request
 * @returns {Promise<{ id: string|null, model: string|null, answers: object, usage: object|null }>}
 * @exports
 * @ai.hint io
 */
export async function requestDecision(client, { model, state, questions, signal } = {}) {
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('Нужна модель решений.');
    const body = { model: model.trim(), state: validateState(state), questions: validateQuestions(questions) };
    const raw = await client.decisions.create(body, { signal });
    if (!raw || typeof raw !== 'object' || !raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) {
        throw new ApiError('Ответ /decisions не содержит answers.', { code: 'INVALID_RESPONSE' });
    }
    return { id: raw.id ?? null, model: raw.model ?? model, answers: raw.answers, usage: raw.usage ?? null };
}
