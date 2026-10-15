/**
 * @file src/channels/handle.js
 * @module channels/handle
 * @purpose Moderate one inbound chat message, optionally draft a reply, and apply Telegram delete.
 * @depends channels/moderate, channels/reply, telegram/policy
 * @usedBy channels/dispatch, commands/channels
 * @exports handleInbound
 * @ai.tags chat, telegram, moderation
 * @ai.hint io
 * @changed 2026-10-15 One message through moderation, reply, and enforcement.
 */

import { moderateText } from './moderate.js';
import { draftReply } from './reply.js';
import { enforcementFor } from '../telegram/policy.js';

/**
 * Purpose when the caller did not name one. Private chats are support, channels are SMM.
 * @param {object} message
 * @returns {'support'|'smm'|'community'}
 * @ai.hint pure
 */
function purposeFor(message) {
    if (message.kind === 'private') return 'support';
    if (message.kind === 'channel') return 'smm';
    return 'community';
}

/**
 * Which question pack matches the chat. An explicit purpose wins.
 * Groups keep the configured community preset unless the caller asked for support or SMM.
 * @param {object} message
 * @param {string|null} purpose
 * @param {object} config
 * @returns {string}
 * @ai.hint pure
 */
function presetFor(message, purpose, config) {
    if (purpose === 'smm') return 'smm';
    if (purpose === 'support' || message.kind === 'private') return 'support';
    return config.moderation?.preset || 'community';
}

/**
 * Run moderation and, when allowed, a reply. Telegram delete runs only for the policy plan.
 * Errors from delete or send are returned on the result so a poll loop can continue.
 * @param {{ client: object, config: object, message: object, signal?: AbortSignal, ledger?: object|null, telegram?: object|null, purpose?: string|null, reply?: boolean }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function handleInbound({ client, config, message, signal, ledger = null, telegram = null, purpose = null, reply = null } = {}) {
    const text = String(message?.text ?? '').trim();
    if (!text) return { ignored: true, message };
    const resolvedPurpose = purpose || purposeFor(message);
    const preset = presetFor(message, purpose, config);
    const moderation = config.telegram?.moderate === false
        ? { action: 'allow', source: 'skipped', scores: {}, flagged: false, preset }
        : await moderateText({
            client, input: text, config, preset, signal, ledger,
            context: { channel: message.channel ?? null, kind: message.kind ?? null, title: message.title ?? null, from: message.from ?? null },
        });
    const plan = enforcementFor(message, moderation, { enforce: config.telegram?.enforce ?? 'delete' });
    let telegramResult = null;
    let enforcementError = null;
    if (plan && telegram) {
        try { telegramResult = await telegram.call(plan.method, plan.body, { signal }); }
        catch (error) { enforcementError = error.message; }
    }
    const wantReply = reply ?? config.telegram?.reply === true;
    let draft = null;
    if (wantReply && moderation.action === 'allow') {
        draft = await draftReply({
            client, config, purpose: resolvedPurpose, message, decision: moderation, signal,
            guard: config.moderation?.guardReplies ? (value) => moderateText({ client, input: value, config, preset: 'guard', signal, ledger }) : null,
        });
        if (draft.usage) ledger?.record({ model: draft.model, usage: draft.usage, kind: 'response', responseId: draft.id });
        if (telegram && draft.text && message.chatId != null) {
            try {
                await telegram.sendMessage({ chatId: message.chatId, text: draft.text, threadId: message.threadId, replyTo: message.messageId }, { signal });
                draft.sent = true;
            } catch (error) {
                draft.sent = false;
                draft.sendError = error.message;
            }
        }
    }
    return {
        ignored: false, message, moderation, purpose: resolvedPurpose, reply: draft,
        enforcement: plan, enforced: Boolean(telegramResult), enforcementError,
    };
}
