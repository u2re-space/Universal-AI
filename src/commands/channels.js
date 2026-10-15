/**
 * @file src/commands/channels.js
 * @module commands/channels
 * @purpose CLI for decisions, moderation, the channel server, and Telegram polling.
 * @depends commands/shared, channels/dispatch, channels/server, channels/questions, telegram/client, telegram/poll, telegram/update, openai/errors
 * @usedBy cli
 * @exports decide, moderate, channels, telegram
 * @ai.tags cli, channels, telegram
 * @ai.hint io
 * @changed 2026-10-15 decide, moderate, channels --listen, telegram poll and send.
 */

import { isAbortError } from '../openai/errors.js';
import { dispatchChannel } from '../channels/dispatch.js';
import { startChannelServer } from '../channels/server.js';
import { PRESET_NAMES } from '../channels/questions.js';
import { createTelegram } from '../telegram/client.js';
import { pollOnce } from '../telegram/poll.js';
import { normalizeUpdate } from '../telegram/update.js';
import { UsageError, readStdin, createClientFor, createLedgerFor } from './shared.js';

/**
 * Parse --port. 0 asks the OS for a free port.
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 * @ai.hint pure
 */
function parsePort(value, fallback) {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new UsageError(`Некорректное значение --port: ${value}`);
    const port = Number(value);
    if (port > 65535) throw new UsageError('--port: 0..65535');
    return port;
}

/**
 * Stdin JSON object, or text from arguments and stdin.
 * @param {object} ctx
 * @returns {Promise<{ json: object|null, text: string }>}
 * @ai.hint io
 */
async function readPayload(ctx) {
    const stdin = await readStdin({ maxBytes: ctx.config.limits.maxStdinBytes });
    if (stdin?.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(stdin);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { json: parsed, text: '' };
        } catch { /* the text itself starts with a brace */ }
    }
    return { json: null, text: stdin ?? '' };
}

/**
 * First positional is a preset name when it matches one.
 * @param {string[]} positionals
 * @returns {{ preset: string|null, text: string }}
 * @ai.hint pure
 */
function splitPreset(positionals) {
    const [first, ...rest] = positionals;
    if (first && PRESET_NAMES.includes(first)) return { preset: first, text: rest.join(' ').trim() };
    return { preset: null, text: positionals.join(' ').trim() };
}

/**
 * Print a verdict or the raw JSON mode event.
 * @param {object} renderer
 * @param {object} payload
 * @param {object} verdict
 * @returns {void}
 * @ai.hint io
 */
function showVerdict(renderer, payload, verdict) {
    renderer.json(payload);
    if (renderer.mode === 'json') return;
    const lines = [`действие: ${verdict.action}`, `источник: ${verdict.source ?? '—'}`];
    for (const [name, score] of Object.entries(verdict.scores ?? {})) lines.push(`${name}: ${score}`);
    if (verdict.choice) lines.push(`выбор: ${verdict.choice}`);
    renderer.write(`${lines.join('\n')}\n`);
}

/**
 * `ai decide [preset] [text]` or a JSON object on stdin.
 * @param {object} ctx
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function decide(ctx) {
    const { json, text } = await readPayload(ctx);
    const split = splitPreset(ctx.positionals);
    const content = [split.text, text].filter(Boolean).join('\n').trim();
    const body = json ?? { preset: split.preset || ctx.config.moderation.preset, state: { text: content } };
    if (!json && !content) throw new UsageError('Укажите текст или JSON на stdin: ai decide community "текст".');
    const client = createClientFor(ctx.config);
    const ledger = createLedgerFor(ctx.config);
    try {
        const result = await dispatchChannel({ type: 'decide', body, client, config: ctx.config, signal: ctx.signal, ledger });
        showVerdict(ctx.renderer, { type: 'decision', ...result }, result.verdict);
        return 0;
    } finally { client.close(); }
}

/**
 * `ai moderate [preset] [text]` or JSON `{ input, preset }` on stdin.
 * @param {object} ctx
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function moderate(ctx) {
    const { json, text } = await readPayload(ctx);
    const split = splitPreset(ctx.positionals);
    const content = [split.text, text].filter(Boolean).join('\n').trim();
    const body = json ?? { preset: split.preset || ctx.config.moderation.preset, input: content };
    if (!json && !body.input) throw new UsageError('Укажите текст или JSON на stdin: ai moderate community "текст".');
    const client = createClientFor(ctx.config);
    const ledger = createLedgerFor(ctx.config);
    try {
        const result = await dispatchChannel({ type: 'moderate', body, client, config: ctx.config, signal: ctx.signal, ledger });
        showVerdict(ctx.renderer, { type: 'moderation', ...result }, result.moderation);
        return 0;
    } finally { client.close(); }
}

/**
 * `ai channels --listen [--port n]`. HTTP and WebSocket on channels.host (127.0.0.1 by default).
 * @param {object} ctx
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function channels(ctx) {
    if (!ctx.values.listen) throw new UsageError('Запуск: ai channels --listen [--port n] [--token секрет].');
    const port = parsePort(ctx.values.port, ctx.config.channels.port);
    const token = ctx.values.token || ctx.config.channels.token;
    const client = createClientFor(ctx.config);
    const ledger = createLedgerFor(ctx.config);
    const server = await startChannelServer({ client, config: ctx.config, ledger, port, token, signal: ctx.signal });
    ctx.renderer.line('info', `решения: ${server.httpURL}/v1/decisions`);
    ctx.renderer.line('info', `модерация: ${server.httpURL}/v1/moderate`);
    ctx.renderer.line('info', `ответ: ${server.httpURL}/v1/chats/reply`);
    ctx.renderer.line('info', `webhook: ${server.httpURL}/v1/telegram/webhook`);
    ctx.renderer.line('info', `websocket: ${server.wsURL}`);
    try {
        await new Promise((resolve) => {
            if (ctx.signal.aborted) resolve();
            else ctx.signal.addEventListener('abort', resolve, { once: true });
        });
        return 130;
    } finally {
        await server.close();
        client.close();
    }
}

/**
 * `ai telegram poll` or `ai telegram send <chat_id> <text>`.
 * @param {object} ctx
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function telegram(ctx) {
    const [sub, chatId, ...rest] = ctx.positionals;
    const token = ctx.config.telegram?.token;
    if (!token) throw new UsageError('Задайте TELEGRAM_BOT_TOKEN или telegram.token в конфигурации.');
    const bot = createTelegram({ token, baseURL: ctx.config.telegram.baseURL });
    try {
        if (sub === 'send') {
            const text = rest.join(' ').trim();
            if (!chatId || !text) throw new UsageError('Использование: ai telegram send <chat_id> "текст".');
            const sent = await bot.sendMessage({ chatId, text }, { signal: ctx.signal });
            ctx.renderer.write(`${sent?.message_id ?? 'ok'}\n`);
            ctx.renderer.json({ type: 'telegram.sent', messageId: sent?.message_id ?? null });
            return 0;
        }
        if (sub !== 'poll') throw new UsageError('Использование: ai telegram poll | ai telegram send <chat_id> "текст".');
        const needsModel = ctx.config.telegram.moderate !== false || ctx.config.telegram.reply === true;
        if (needsModel && !ctx.config.apiKey) throw new UsageError('Для модерации и ответов нужен OPENAI_API_KEY.');
        const client = ctx.config.apiKey ? createClientFor(ctx.config) : null;
        const ledger = createLedgerFor(ctx.config);
        let offset = 0;
        ctx.renderer.line('info', 'Telegram: длинный опрос getUpdates. Остановка — Ctrl-C.');
        try {
            while (!ctx.signal.aborted) {
                offset = await pollOnce({
                    telegram: bot, offset, timeout: 25, signal: ctx.signal,
                    onUpdate: async (update) => {
                        const message = normalizeUpdate(update);
                        if (!message?.text) return;
                        const outcome = client
                            ? await dispatchChannel({ type: 'telegram', body: { update }, client, config: ctx.config, telegram: bot, signal: ctx.signal, ledger })
                            : { moderation: null, message };
                        const action = outcome.moderation?.action ?? 'allow';
                        ctx.renderer.write(`${message.kind} ${message.chatId}: ${action} ${message.text.slice(0, 160)}\n`);
                        ctx.renderer.json({ type: 'telegram.update', ...outcome });
                    },
                });
            }
        } catch (error) {
            if (isAbortError(error) || ctx.signal.aborted) return 130;
            throw error;
        } finally { client?.close(); }
        return 130;
    } finally { bot.close(); }
}
