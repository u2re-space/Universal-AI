/**
 * @file src/channels/dispatch.js
 * @module channels/dispatch
 * @purpose One decide, moderate, reply, or telegram request for HTTP, WebSocket, and the CLI.
 * @depends channels/decide, channels/moderate, channels/reply, channels/handle, channels/questions, channels/verdict, telegram/update
 * @usedBy channels/server, commands/channels
 * @exports dispatchChannel
 * @ai.tags channels, api
 * @ai.hint io
 * @changed 2026-10-15 Shared dispatcher for the four channel operations.
 */

import { requestDecision } from './decide.js';
import { handleInbound } from './handle.js';
import { moderateText } from './moderate.js';
import { draftReply } from './reply.js';
import { questionsFor } from './questions.js';
import { routeFlag, verdictFromAnswers } from './verdict.js';
import { normalizeUpdate } from '../telegram/update.js';

/**
 * Run one channel operation.
 * decide — state plus questions or a preset. moderate — text plus a preset.
 * reply — a draft. telegram — a Bot API update.
 * @param {{ type: string, body: object, client: object, config: object, telegram?: object|null, signal?: AbortSignal, ledger?: object|null }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function dispatchChannel({ type, body, client, config, telegram = null, signal, ledger = null } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Ожидался JSON-объект.');
    if (type === 'decide') return decide(body, client, config, signal, ledger);
    if (type === 'moderate') {
        const moderation = await moderateText({
            client, config, signal, ledger,
            input: body.input ?? body.text, preset: body.preset || config.moderation?.preset, model: body.model,
            context: body.context ?? null,
        });
        return { moderation };
    }
    if (type === 'reply') {
        const reply = await draftReply({
            client, config, signal, model: body.model, purpose: body.purpose,
            message: { text: body.text ?? body.input, context: body.context ?? '', kind: body.kind ?? null, title: body.title ?? null },
            decision: body.decision ?? null,
            guard: config.moderation?.guardReplies ? (value) => moderateText({ client, input: value, config, preset: 'guard', signal, ledger }) : null,
        });
        if (reply.usage) ledger?.record({ model: reply.model, usage: reply.usage, kind: 'response', responseId: reply.id });
        return { reply };
    }
    if (type === 'telegram') {
        const message = normalizeUpdate(body.update ?? body);
        if (!message) return { ignored: true };
        return handleInbound({ client, config, message, signal, ledger, telegram, purpose: body.purpose ?? null, reply: body.reply });
    }
    throw new TypeError('Неизвестный тип: decide, moderate, reply или telegram.');
}

/**
 * Decisions call plus a verdict. Preset route also returns encoder or planner.
 * @param {object} body
 * @param {object} client
 * @param {object} config
 * @param {AbortSignal|undefined} signal
 * @param {object|null} ledger
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function decide(body, client, config, signal, ledger) {
    const questions = body.questions ? body.questions : questionsFor(body.preset || config.moderation?.preset || 'community');
    const model = body.model || config.decisions?.model;
    const raw = await requestDecision(client, { model, state: body.state ?? body.text ?? body.input, questions, signal });
    ledger?.record({ model: raw.model, usage: raw.usage, kind: 'decision', responseId: raw.id });
    const verdict = { ...verdictFromAnswers(raw.answers, config.decisions), source: 'decisions', model: raw.model, id: raw.id };
    const flag = (body.preset === 'route' || questions.next) ? routeFlag(raw.answers, { blockAt: config.decisions?.blockAt }) : null;
    return { decision: raw, verdict, ...(flag ? { route: flag === 'encoder' ? 'encode' : 'plan' } : {}) };
}
