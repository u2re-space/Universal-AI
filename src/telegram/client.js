/**
 * @file src/telegram/client.js
 * @module telegram/client
 * @purpose Telegram Bot API over the shared HTTPS transport. No SDK.
 * @depends openai/http, openai/errors
 * @usedBy channels/server, commands/channels, channels/tool-handlers
 * @exports TELEGRAM_METHODS, createTelegram
 * @ai.tags telegram, http
 * @ai.hint io
 * @changed 2026-10-15 Bot API adapter.
 */

import { ApiError } from '../openai/errors.js';
import { createHttp, readBody } from '../openai/http.js';

export const TELEGRAM_METHODS = Object.freeze([
    'getMe', 'getChat', 'sendMessage', 'deleteMessage', 'getUpdates', 'banChatMember', 'restrictChatMember',
]);

/**
 * Replace the bot token if a transport error echoes the URL.
 * @param {string} message
 * @param {string} token
 * @returns {string}
 * @ai.hint pure
 */
function hideToken(message, token) {
    return String(message).split(token).join('…');
}

/**
 * Open a Bot API client. `baseURL` defaults to https://api.telegram.org.
 * Pass `http` in tests; otherwise the client owns the keep-alive agent.
 * @param {{ token: string, baseURL?: string, http?: object }} options
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createTelegram({ token, baseURL = 'https://api.telegram.org', http, connectTimeoutMs = 30_000 } = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n\s]/.test(token)) {
        throw new TypeError('Не задан токен Telegram (TELEGRAM_BOT_TOKEN).');
    }
    const root = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
    const owns = !http;
    const transport = http ?? createHttp({ connectTimeoutMs });

    /**
     * POST one allow-listed or explicit method. The token is not included in thrown messages.
     * @param {string} method
     * @param {object} [body]
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<any>}
     * @ai.hint io
     */
    async function call(method, body = {}, { signal } = {}) {
        if (!TELEGRAM_METHODS.includes(method)) throw new TypeError(`Метод Telegram недоступен: ${method}`);
        // A token contains a colon. Building a relative URL would read that colon as a scheme.
        const url = new URL(root.href);
        const basePath = root.pathname.endsWith('/') ? root.pathname.slice(0, -1) : root.pathname;
        url.pathname = `${basePath}/bot${token}/${method}`;
        url.search = '';
        url.hash = '';
        let res;
        try {
            res = await transport.request({
                url, method: 'POST', body: JSON.stringify(body ?? {}), signal,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            });
        } catch (error) {
            throw new ApiError(hideToken(error.message, token), { code: error.code ?? 'NETWORK_ERROR', cause: error });
        }
        const raw = await readBody(res.body, 1024 * 1024, { truncate: true });
        let parsed = null;
        try { parsed = JSON.parse(raw.toString('utf8')); }
        catch { throw new ApiError('Telegram вернул не JSON.', { code: 'INVALID_RESPONSE', status: res.status }); }
        if (!parsed?.ok) {
            throw new ApiError(`Telegram: ${parsed?.description ?? 'ошибка'}`, {
                code: 'TELEGRAM', status: res.status || parsed?.error_code || null, apiCode: parsed?.error_code != null ? String(parsed.error_code) : null,
            });
        }
        return parsed.result;
    }

    return Object.freeze({
        call,
        close: () => { if (owns) transport.close(); },
        getMe: (options) => call('getMe', {}, options),
        getUpdates: (body, options) => call('getUpdates', body, options),
        getChat: ({ chatId }, options) => call('getChat', { chat_id: chatId }, options),
        sendMessage: ({ chatId, text, threadId = null, replyTo = null }, options) => call('sendMessage', {
            chat_id: chatId, text,
            ...(threadId != null ? { message_thread_id: threadId } : {}),
            ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
        }, options),
        deleteMessage: ({ chatId, messageId }, options) => call('deleteMessage', { chat_id: chatId, message_id: messageId }, options),
        banChatMember: ({ chatId, userId }, options) => call('banChatMember', { chat_id: chatId, user_id: userId }, options),
        restrictChatMember: ({ chatId, userId, permissions }, options) => call('restrictChatMember', {
            chat_id: chatId, user_id: userId, permissions,
        }, options),
    });
}
