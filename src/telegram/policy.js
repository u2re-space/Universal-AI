/**
 * @file src/telegram/policy.js
 * @module telegram/policy
 * @purpose Decide whether a moderation verdict deletes a Telegram message.
 * @usedBy channels/handle
 * @exports enforcementFor
 * @ai.tags telegram, moderation
 * @ai.hint pure
 * @changed 2026-10-15 Delete only hidden group and channel messages.
 */

const GROUPS = new Set(['group', 'supergroup', 'channel']);

/**
 * A deleteMessage body, or null. Private chats are never deleted here.
 * `enforce: 'none'` does nothing. Ban is not automatic.
 * @param {object} message Normalized update.
 * @param {object|null} verdict
 * @param {{ enforce?: 'none'|'delete' }} [options]
 * @returns {{ method: 'deleteMessage', body: object }|null}
 * @exports
 * @ai.hint pure
 */
export function enforcementFor(message, verdict, { enforce = 'delete' } = {}) {
    if (enforce !== 'delete') return null;
    if (verdict?.action !== 'hide') return null;
    if (!GROUPS.has(message?.kind)) return null;
    if (message.chatId == null || message.messageId == null) return null;
    return { method: 'deleteMessage', body: { chat_id: message.chatId, message_id: message.messageId } };
}
