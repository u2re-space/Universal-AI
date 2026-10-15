/**
 * @file src/telegram/update.js
 * @module telegram/update
 * @purpose Normalize a Telegram update into one chat message.
 * @usedBy channels/handle, telegram/poll, commands/channels
 * @exports normalizeUpdate
 * @ai.tags telegram
 * @ai.hint pure
 * @changed 2026-10-15 Messages, channel posts, and forum topics.
 */

/**
 * One inbound Telegram message, or null when the update has no chat.
 * `kind` is private, group, supergroup, or channel. Communities arrive as supergroup or channel.
 * @param {object} update
 * @returns {object|null}
 * @exports
 * @ai.hint pure
 */
export function normalizeUpdate(update) {
    if (!update || typeof update !== 'object') return null;
    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post ?? null;
    if (!message?.chat || message.chat.id === undefined) return null;
    const from = message.from ?? message.sender_chat ?? null;
    const name = from ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.title || from.username || null : null;
    return {
        channel: 'telegram',
        updateId: update.update_id ?? null,
        kind: message.chat.type ?? 'private',
        chatId: message.chat.id,
        title: message.chat.title ?? message.chat.username ?? null,
        messageId: message.message_id ?? null,
        threadId: message.message_thread_id ?? null,
        from: from ? { id: from.id ?? null, name, username: from.username ?? null } : null,
        text: typeof message.text === 'string' ? message.text : (typeof message.caption === 'string' ? message.caption : ''),
        date: message.date ?? null,
    };
}
