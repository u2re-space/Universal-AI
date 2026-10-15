/**
 * @file src/channels/tool-handlers.js
 * @module channels/tool-handlers
 * @purpose Agent tools: decide, moderate_text, channel_reply, and telegram_call.
 * @depends openai/client, util/text, channels/dispatch, telegram/client
 * @usedBy agent/tools
 * @exports createChannelHandlers
 * @ai.tags tools, channels
 * @ai.hint io
 * @changed 2026-10-15 Channel tools share the injected API client.
 */

import { createClient } from '../openai/client.js';
import { clipMiddle } from '../util/text.js';
import { dispatchChannel } from './dispatch.js';
import { createTelegram, TELEGRAM_METHODS } from '../telegram/client.js';

/**
 * Handlers for the four channel tools. A passed-in client is not closed.
 * @param {{ client?: object|null, config: object, signal?: AbortSignal, ledger?: object|null }} options
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createChannelHandlers({ client = null, config, signal, ledger = null } = {}) {
    /**
     * Use the shared client, or open one for this call and close it afterwards.
     * @param {(api: object) => Promise<any>} fn
     * @returns {Promise<any>}
     * @ai.hint io
     */
    async function withClient(fn) {
        if (client) return fn(client);
        const owned = createClient({
            apiKey: config.apiKey, baseURL: config.baseURL, organization: config.organization, project: config.project,
            retries: config.retries, idleTimeoutMs: config.limits?.idleTimeoutMs, connectTimeoutMs: config.limits?.connectTimeoutMs,
        });
        try { return await fn(owned); }
        finally { owned.close(); }
    }

    return {
        /** Ask a decision model. questions_json wins when it is not empty. */
        async decide(args) {
            const questions = String(args.questions_json ?? '').trim();
            const body = {
                model: String(args.model ?? '').trim() || undefined,
                preset: args.preset || undefined,
                state: JSON.parse(args.state_json),
                ...(questions ? { questions: JSON.parse(questions) } : {}),
            };
            const result = await withClient((api) => dispatchChannel({ type: 'decide', body, client: api, config, signal, ledger }));
            return { output: JSON.stringify(result.verdict), summary: `${result.verdict.action} · ${result.verdict.source}` };
        },
        /** Moderate one text with the named preset. */
        async moderate_text(args) {
            const result = await withClient((api) => dispatchChannel({
                type: 'moderate', body: { input: args.text, preset: args.preset }, client: api, config, signal, ledger,
            }));
            return { output: JSON.stringify(result.moderation), summary: `${result.moderation.action} · ${result.moderation.source}` };
        },
        /** Draft a support, SMM, or community reply. */
        async channel_reply(args) {
            const result = await withClient((api) => dispatchChannel({
                type: 'reply', body: { purpose: args.purpose, text: args.text, context: args.context ?? '' }, client: api, config, signal, ledger,
            }));
            const reply = result.reply;
            return { output: reply.skipped ? `(пропуск: ${reply.reason})` : reply.text, summary: reply.skipped ? reply.reason : 'черновик' };
        },
        /** Call one allow-listed Telegram Bot API method. args_json is the method body. */
        async telegram_call(args) {
            if (!TELEGRAM_METHODS.includes(args.method)) throw new TypeError(`Метод Telegram недоступен: ${args.method}`);
            const body = String(args.args_json ?? '').trim() ? JSON.parse(args.args_json) : {};
            if (args.method === 'sendMessage' && typeof body.text === 'string' && body.text.length > 4096) {
                throw new TypeError('Текст Telegram длиннее 4096 символов.');
            }
            const token = config.telegram?.token;
            const telegram = createTelegram({ token, baseURL: config.telegram?.baseURL });
            try {
                const result = await telegram.call(args.method, body, { signal });
                return { output: clipMiddle(JSON.stringify(result ?? null), 8000), summary: args.method };
            } finally { telegram.close(); }
        },
    };
}
