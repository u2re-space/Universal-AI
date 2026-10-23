/**
 * @file src/commands/complete.js
 * @module commands/complete
 * @purpose Editor completion: one JSON request, or a local HTTP and WebSocket server.
 * @depends commands/shared, complete/complete, complete/channels, complete/server, complete/errors
 * @usedBy cli
 * @exports complete
 * @ai.tags cli, complete
 * @ai.hint io
 * @changed 2026-10-15 IDE completion command.
 */

import { isRecord } from '../util/text.js';
import { envValue } from '../core/runtime-env.js';
import { UsageError, readStdin, createClientFor } from './shared.js';
import { completeCode } from '../complete/complete.js';
import { createCompletionChannels } from '../complete/channels.js';
import { startCompletionServer } from '../complete/server.js';
import { CompletionError } from '../complete/errors.js';
import { structureCode } from '../structure/structure.js';

/**
 * Parse a 0-based cursor flag.
 * @param {string} value Raw flag.
 * @param {string} name Flag name without dashes.
 * @returns {number}
 * @ai.hint pure
 */
function cursorNumber(value, name) {
    if (!/^\d+$/.test(value)) throw new UsageError(`Некорректное значение --${name}: ${value}`);
    return Number(value);
}

/**
 * Parse --port. 0 asks the OS for a free port.
 * @param {string|undefined} value
 * @returns {number}
 * @ai.hint pure
 */
function parsePort(value) {
    if (value === undefined) return 8765;
    if (!/^\d+$/.test(value)) throw new UsageError(`Некорректное значение --port: ${value}`);
    const port = Number(value);
    if (port > 65535) throw new UsageError(`Некорректное значение --port: ${value}`);
    return port;
}

/**
 * Build the completion request from JSON stdin, a piped snippet, or flags.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function requestFromCli(ctx) {
    const { values, positionals } = ctx;
    const stdinText = await readStdin({ maxBytes: ctx.config.limits.maxStdinBytes });
    let request = {};
    if (stdinText && stdinText.trimStart().startsWith('{')) {
        try { request = JSON.parse(stdinText); }
        catch { throw new UsageError('stdin: ожидался JSON запроса дополнения.'); }
        if (!isRecord(request)) throw new UsageError('stdin: ожидался JSON-объект.');
    } else if (stdinText) request = { content: stdinText };
    if (values.file?.length) request.path = values.file[values.file.length - 1];
    if (values.language) request.language = values.language;
    if (values.model) request.model = values.model;
    if (values.effort) request.effort = values.effort;
    if (values.line !== undefined || values.character !== undefined) {
        const current = isRecord(request.cursor) ? request.cursor : {};
        request.cursor = {
            line: values.line !== undefined ? cursorNumber(values.line, 'line') : (current.line ?? 0),
            character: values.character !== undefined ? cursorNumber(values.character, 'character') : (current.character ?? current.column ?? 0),
        };
    }
    if (request.content == null && request.prefix == null && request.suffix == null && !request.path && positionals.length) {
        request.content = positionals.join(' ');
    }
    return request;
}

/**
 * Listen on 127.0.0.1 until SIGINT or SIGTERM.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} 130 when the server stops.
 * @ai.hint io
 */
async function listen(ctx) {
    const { config, renderer, values, signal, cwd } = ctx;
    const port = parsePort(values.port);
    const token = values.token || envValue('AI_COMPLETE_TOKEN') || config.completion.token || null;
    let client = null;
    let channels = null;
    let server;
    try {
        server = await startCompletionServer({
            port, token, signal,
            handle: (request, requestSignal) => {
                if (!config.apiKey) throw new CompletionError('Не задан OPENAI_API_KEY.', { status: 401, code: 'NO_API_KEY' });
                channels ??= createCompletionChannels(config);
                return completeCode({ channels, config, request, cwd, signal: requestSignal });
            },
            structure: (request, requestSignal) => structureCode({
                request, cwd, config, client: config.apiKey ? (client ??= createClientFor(config)) : null, signal: requestSignal,
            }),
        });
    } catch (error) {
        if (error.code === 'EADDRINUSE') throw new UsageError(`Порт занят: ${port}`);
        throw error;
    }
    renderer.line('info', `дополнение: ${server.httpURL}`);
    renderer.line('info', `структура: ${server.structureURL}`);
    renderer.line('info', `websocket: ${server.wsURL}`);
    renderer.json({ type: 'complete.listening', httpURL: server.httpURL, structureURL: server.structureURL, wsURL: server.wsURL, port: server.port });
    try {
        await new Promise((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
    } finally {
        await server.close();
        channels?.close();
        client?.close();
    }
    return 130;
}

/**
 * `ai complete` — insert text at a cursor. `--listen` serves HTTP and WebSocket for an editor.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} 0 for one completion, 130 when the server is stopped.
 * @exports
 * @ai.hint io
 */
export async function complete(ctx) {
    const { config, renderer, values, signal, cwd } = ctx;
    if (values.listen || values.port !== undefined) return listen(ctx);
    const request = await requestFromCli(ctx);
    if (request.kind === 'structure' || request.tasks != null) {
        const client = config.apiKey ? createClientFor(config) : null;
        try {
            const result = await structureCode({ request, cwd, config, client, signal });
            if (renderer.mode === 'json') renderer.json({ type: 'structured', ...result });
            else process.stdout.write(result.text);
            return 0;
        } finally { client?.close(); }
    }
    if (!config.apiKey) throw new UsageError('Не задан OPENAI_API_KEY. Укажите его в .env, в окружении или в ~/.ai-agent/config.json.');
    const channels = createCompletionChannels(config);
    try {
        const result = await completeCode({ channels, config, request, cwd, signal });
        if (renderer.mode === 'json') renderer.json({ type: 'completion', ...result });
        else {
            renderer.line('info', result.model, { dim: true });
            process.stdout.write(result.text);
        }
        return 0;
    } finally { channels.close(); }
}
