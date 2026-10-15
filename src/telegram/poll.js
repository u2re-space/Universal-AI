/**
 * @file src/telegram/poll.js
 * @module telegram/poll
 * @purpose One long-poll of getUpdates and the next offset.
 * @depends telegram/client
 * @usedBy commands/channels
 * @exports nextOffset, pollOnce
 * @ai.tags telegram
 * @ai.hint io
 * @changed 2026-10-15 Long polling without a public webhook.
 */

/**
 * The offset to send on the next getUpdates. Unset update ids are ignored.
 * @param {object[]} updates
 * @param {number} [offset=0]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function nextOffset(updates, offset = 0) {
    let next = offset;
    for (const update of updates ?? []) {
        if (typeof update?.update_id === 'number' && update.update_id + 1 > next) next = update.update_id + 1;
    }
    return next;
}

/**
 * Fetch one batch and hand each update to `onUpdate` before advancing the offset.
 * @param {{ telegram: object, offset?: number, timeout?: number, signal?: AbortSignal, onUpdate: (update: object) => Promise<void> }} options
 * @returns {Promise<number>} Next offset.
 * @exports
 * @ai.hint io
 */
export async function pollOnce({ telegram, offset = 0, timeout = 25, signal, onUpdate } = {}) {
    const updates = await telegram.getUpdates({
        offset, timeout,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
    }, { signal });
    const list = Array.isArray(updates) ? updates : [];
    for (const update of list) await onUpdate(update);
    return nextOffset(list, offset);
}
