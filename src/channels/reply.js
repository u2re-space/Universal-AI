/**
 * @file src/channels/reply.js
 * @module channels/reply
 * @purpose Draft a support, community, or SMM reply with the Responses API.
 * @depends agent/loop
 * @usedBy channels/handle, channels/dispatch, channels/tool-handlers
 * @exports PURPOSE_NAMES, draftReply
 * @ai.tags chat, smm
 * @ai.hint io
 * @changed 2026-10-15 Reply drafts skip hidden and review cases.
 */

import { buildRequestBody } from '../agent/loop.js';

export const PURPOSE_NAMES = Object.freeze(['support', 'smm', 'community']);

const INSTRUCTIONS = {
    support: `Ты отвечаешь клиенту в переписке. Пиши на языке сообщения, коротко и по делу.
Не выдумывай статусы заказов, цены и правила. Если данных нет, так и скажи.
Если отвечать не нужно, верни пустую строку.`,
    smm: `Ты готовишь одну публикацию для сообщества или канала. Пиши на языке исходного текста.
Не обещай результатов, которых нет в тексте. Если публиковать рано, верни пустую строку.`,
    community: `Ты модератор сообщества. Если уместен короткий публичный ответ, напиши его на языке сообщения.
Не спорь и не повторяй оскорбления. Если отвечать не нужно, верни пустую строку.`,
};

/**
 * Draft one message. Hidden and review decisions do not produce text.
 * `guard`, when set, receives the draft and can clear it.
 * @param {{ client: object, config: object, model?: string, purpose: string, message: object, decision?: object|null, signal?: AbortSignal, guard?: ((text: string) => Promise<object>)|null }} options
 * @returns {Promise<{ text: string, skipped: boolean, reason: string|null, model: string|null, id: string|null, usage: object|null, moderation?: object }>}
 * @exports
 * @ai.hint io
 */
export async function draftReply({ client, config, model, purpose, message, decision = null, signal, guard = null } = {}) {
    if (!PURPOSE_NAMES.includes(purpose)) throw new TypeError(`purpose: ${PURPOSE_NAMES.join(' | ')}.`);
    const text = String(message?.text ?? '').trim();
    if (!text) throw new TypeError('Нет текста, на который нужно ответить.');
    if (decision?.action === 'hide') return empty('hidden');
    if (decision?.action === 'review') return empty('review');
    if (purpose === 'support' && typeof decision?.answers?.needs_reply?.noul === 'number' && decision.answers.needs_reply.noul < (config.decisions?.reviewAt ?? 0.5)) {
        return empty('no_reply');
    }
    if (purpose === 'smm' && typeof decision?.answers?.publish?.noul === 'number' && decision.answers.publish.noul < (config.decisions?.reviewAt ?? 0.5)) {
        return empty('not_ready');
    }
    const chosen = model || config.model;
    const body = buildRequestBody({
        config, model: chosen, instructions: INSTRUCTIONS[purpose], stream: false, store: false,
        maxOutputTokens: config.maxOutputTokens ?? 800, reasoningEffort: 'low', reasoningSummary: 'none',
        input: [{ role: 'user', content: JSON.stringify({ purpose, message: publicMessage(message), decision: slim(decision) }) }],
    });
    const response = await client.responses.create(body, { signal });
    const draft = String(response?.output_text ?? '').trim();
    if (!draft) return { text: '', skipped: true, reason: 'empty', model: response?.model ?? chosen, id: response?.id ?? null, usage: response?.usage ?? null };
    if (guard) {
        const checked = await guard(draft);
        if (checked?.action === 'hide') {
            return { text: '', skipped: true, reason: 'guard', model: response?.model ?? chosen, id: response?.id ?? null, usage: response?.usage ?? null, moderation: checked };
        }
    }
    return { text: draft, skipped: false, reason: null, model: response?.model ?? chosen, id: response?.id ?? null, usage: response?.usage ?? null };
}

/**
 * Empty draft with a reason.
 * @param {string} reason
 * @returns {object}
 * @ai.hint pure
 */
function empty(reason) {
    return { text: '', skipped: true, reason, model: null, id: null, usage: null };
}

/**
 * Fields the reply model needs. Drop ids that are only for the transport.
 * @param {object} message
 * @returns {object}
 * @ai.hint pure
 */
function publicMessage(message) {
    return {
        text: String(message.text ?? ''),
        context: message.context ?? '',
        kind: message.kind ?? null,
        title: message.title ?? null,
        from: message.from?.name ?? message.from ?? null,
    };
}

/**
 * Action and scores, without the raw criteria echo.
 * @param {object|null} decision
 * @returns {object|null}
 * @ai.hint pure
 */
function slim(decision) {
    if (!decision) return null;
    return { action: decision.action ?? null, scores: decision.scores ?? {}, choice: decision.choice ?? null, preset: decision.preset ?? null };
}
