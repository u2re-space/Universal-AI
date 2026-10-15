/**
 * @file src/commands/serve.js
 * @module commands/serve
 * @purpose `ai serve` — localhost WebSocket bus for ask, run, chat, and image.
 * @depends node:path, node:fs/promises, node:crypto, node:stream, server/protocol, server/hub, ui/sanitize, ui/renderer, core/config, util/text, commands/shared, commands/flags, commands/ask, commands/run, commands/chat, commands/image
 * @usedBy cli
 * @exports pidAlive, startServe, serve
 * @ai.tags cli, websocket
 * @ai.hint io
 * @changed 2026-10-15 Bind --port, write serve.json, and accept extra start fields.
 */

import path from 'node:path';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Writable, Readable } from 'node:stream';
import { listenProtocol } from '../server/protocol.js';
import { createHub } from '../server/hub.js';
import { sanitizeValue } from '../ui/sanitize.js';
import { createRenderer } from '../ui/renderer.js';
import { loadConfig } from '../core/config.js';
import { deepMerge } from '../util/text.js';
import { UsageError } from './shared.js';
import { overridesFrom } from './flags.js';
import { ask } from './ask.js';
import { run } from './run.js';
import { chat } from './chat.js';
import { image } from './image.js';

const COMMANDS = { ask, run, chat, image };
const FIELD_MAP = {
    effort: 'effort', summary: 'summary', instructions: 'instructions', images: 'image', files: 'file',
    detail: 'detail', out: 'out', session: 'session', store: 'store', web: 'web', imagesTool: 'images',
    tools: 'tools', noTools: 'no-tools', maxTurns: 'max-turns', budgetUsd: 'budget-usd', budgetTokens: 'budget-tokens',
    maxOutputTokens: 'max-output-tokens', temperature: 'temperature', verbosity: 'verbosity', shell: 'shell',
    stream: 'stream', size: 'size', quality: 'quality', format: 'format', imageBackground: 'image-background',
    partials: 'partials', imageModel: 'image-model', count: 'count', schema: 'schema', role: 'role',
    single: 'single', team: 'team', memory: 'memory',
};
const AS_STRING = new Set(['max-turns', 'budget-usd', 'budget-tokens', 'max-output-tokens', 'temperature', 'partials', 'count']);

/**
 * True when `pid` is a live process.
 * @param {number} pid
 * @returns {boolean}
 * @exports
 * @ai.hint io
 */
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

/**
 * Turn one start frame into the values object commands already read.
 * @param {object} frame
 * @returns {object}
 * @ai.hint pure
 */
function valuesFromFrame(frame) {
    const values = { approve: frame.approve ?? 'ask', detail: frame.detail ?? 'auto', reasoning: true };
    for (const [from, to] of Object.entries(FIELD_MAP)) {
        if (frame[from] === undefined) continue;
        const value = frame[from];
        values[to] = AS_STRING.has(to) && value != null && typeof value !== 'boolean' ? String(value) : value;
    }
    return values;
}

/**
 * Writable that publishes each JSON line as a run event.
 * @param {(event: object) => void} publish
 * @returns {Writable}
 * @ai.hint io
 */
function eventStdout(publish) {
    let pending = '';
    return new Writable({
        write(chunk, _encoding, callback) {
            pending += chunk.toString();
            let index = pending.indexOf('\n');
            while (index >= 0) {
                const line = pending.slice(0, index);
                pending = pending.slice(index + 1);
                if (line.trim()) {
                    try { publish(JSON.parse(line)); } catch { /* not a JSON event */ }
                }
                index = pending.indexOf('\n');
            }
            callback();
        },
    });
}

/**
 * Run the command named by a client start frame.
 * @param {{ hub: object, baseConfig?: object | null }} options
 * @returns {(run: object, frame: object) => Promise<void>}
 * @ai.hint io
 */
function commandRunner({ hub, baseConfig = null }) {
    return async (run, frame) => {
        const cwd = path.resolve(typeof frame.cwd === 'string' && frame.cwd.trim() ? frame.cwd : process.cwd());
        const directory = await stat(cwd).then((info) => info.isDirectory()).catch(() => false);
        if (!directory) {
            hub.publish(run.id, { type: 'warning', message: `Каталог не найден: ${cwd}` });
            hub.finish(run.id, 'failed', 2);
            return;
        }
        let values;
        let config;
        try {
            values = valuesFromFrame(frame);
            const overrides = overridesFrom(values);
            config = baseConfig
                ? deepMerge(structuredClone(baseConfig), overrides)
                : await loadConfig({ overrides, env: process.env, ensureHome: false });
        } catch (error) {
            hub.publish(run.id, { type: 'warning', message: error.message });
            hub.finish(run.id, 'failed', error.exitCode ?? 2);
            return;
        }
        if (!config.apiKey) {
            hub.publish(run.id, { type: 'warning', message: 'Не задан OPENAI_API_KEY.' });
            hub.finish(run.id, 'failed', 2);
            return;
        }
        const stdout = eventStdout((event) => hub.publish(run.id, event));
        const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        const renderer = createRenderer({ mode: 'json', stdout, stderr, stdin: Readable.from([]) });
        const wrapped = {
            ...renderer,
            get interactive() { return true; },
            approve: (request, opts) => hub.requestApproval(run.id, request, opts?.signal),
            ask: (question, opts) => hub.requestQuestion(run.id, question, opts?.signal),
            readline: () => ({ question: (_prompt, opts) => hub.waitInput(run.id, opts?.signal) }),
        };
        const command = COMMANDS[frame.command];
        const ctx = {
            argv: [], values, positionals: frame.command === 'chat' || !frame.prompt ? [] : [frame.prompt],
            config, renderer: wrapped, cwd, controller: run.controller, signal: run.controller.signal,
            emit: wrapped.handle, reporter: null, backupDir: null, stdin: Readable.from([]),
            setTurnController() {},
            turnSignal: () => run.controller.signal,
        };
        try {
            const code = await command(ctx);
            const status = code === 0 ? 'completed' : code === 130 ? 'cancelled' : 'failed';
            hub.finish(run.id, status, code);
        } catch (error) {
            if (run.controller.signal.aborted) {
                hub.finish(run.id, 'cancelled', 130);
                return;
            }
            hub.publish(run.id, { type: 'warning', message: error.message });
            hub.finish(run.id, error.exitCode === 130 ? 'cancelled' : 'failed', error.exitCode ?? 1);
        } finally {
            renderer.close();
        }
    };
}

/**
 * Bind the bus, write serve.json, and return a close handle.
 * @param {{ home: string, port?: number, token?: string, onStart?: Function, signal?: AbortSignal, baseConfig?: object | null }} options
 * @returns {Promise<{ url: string, token: string, port: number, file: string, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startServe({ home, port = 0, token = randomBytes(32).toString('hex'), onStart, signal, baseConfig = null }) {
    const file = path.join(home, 'serve.json');
    let existing = null;
    try { existing = JSON.parse(await readFile(file, 'utf8')); } catch { /* absent or stale */ }
    if (existing && pidAlive(existing.pid)) throw new UsageError(`Не удалось запустить: сервер уже работает (pid ${existing.pid}).`);
    const hub = createHub({
        token,
        onStart: onStart ?? ((run, frame) => commandRunner({ get hub() { return hub; }, baseConfig })(run, frame)),
    });
    let listener;
    try {
        listener = await listenProtocol({ port, host: '127.0.0.1', onConnection: (conn) => bindConnection(hub, conn) });
    } catch (error) {
        if (error?.code === 'EADDRINUSE') throw new UsageError(`Порт ${port} занят.`);
        throw error;
    }
    await mkdir(home, { recursive: true });
    await writeFile(file, `${JSON.stringify({ pid: process.pid, url: listener.url, token, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`WebSocket: ${listener.url}\nФайл: ${file}\n`);
    let closed = false;
    /**
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const close = async () => {
        if (closed) return;
        closed = true;
        hub.shutdown();
        await listener.close();
        await rm(file, { force: true });
    };
    if (signal) {
        if (signal.aborted) await close();
        else signal.addEventListener('abort', () => { void close(); }, { once: true });
    }
    return { url: listener.url, token, port: listener.port, file, close };
}

/**
 * Attach one upgraded socket to the hub. Frames are handled one at a time.
 * @param {object} hub
 * @param {import('node:events').EventEmitter} conn
 * @returns {void}
 * @ai.hint io
 */
function bindConnection(hub, conn) {
    const socket = hub.connect({
        send(frame) { conn.send(JSON.stringify(sanitizeValue(frame))); },
        close(code) { conn.close(code); },
    });
    let chain = Promise.resolve();
    conn.on('message', (text) => {
        chain = chain.then(async () => {
            let frame;
            try { frame = JSON.parse(text); }
            catch {
                conn.send(JSON.stringify({ type: 'error', code: 'bad_request', message: 'Некорректный JSON.' }));
                return;
            }
            await hub.receive(socket, frame);
        }).catch(() => {});
    });
    conn.on('close', () => hub.disconnect(socket));
}

/**
 * `ai serve [--port n]`. Blocks until the process signal aborts, then returns 0.
 * Extra CLI flags become the default config. Per-run fields arrive in the start frame.
 * @param {object} ctx
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function serve(ctx) {
    if (ctx.values.serve) throw new UsageError('ai serve --serve нельзя сочетать.');
    if (ctx.positionals?.length) throw new UsageError('ai serve не принимает позиционные аргументы. Дополнительные поля передаются в кадре start.');
    let port = 0;
    if (ctx.values.port != null && String(ctx.values.port).trim() !== '') {
        port = Number(ctx.values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port: 0..65535');
    }
    const handle = await startServe({ home: ctx.config.home, port, signal: ctx.signal, baseConfig: ctx.config });
    if (ctx.signal.aborted) {
        await handle.close();
        return 0;
    }
    await new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => { handle.close().then(resolve); }, { once: true });
    });
    return 0;
}
