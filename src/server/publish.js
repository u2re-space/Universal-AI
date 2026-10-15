/**
 * @file src/server/publish.js
 * @module server/publish
 * @purpose Terminal side of --serve. Connects to the local bus and forwards events.
 * @depends node:fs/promises, node:path, ui/sanitize, commands/shared
 * @usedBy cli
 * @exports splitServeUrl, assertLoopback, readServeFile, attachPublisher
 * @ai.tags websocket, cli
 * @ai.hint io
 * @changed 2026-10-15 Publisher hello and a loopback-only URL.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeValue } from '../ui/sanitize.js';
import { UsageError } from '../commands/shared.js';

/**
 * Lift a ws:// URL that follows --serve out of argv before parseArgs.
 * @param {string[]} argv
 * @returns {{ argv: string[], serveUrl: string | null }}
 * @exports
 * @ai.hint pure
 */
export function splitServeUrl(argv) {
    const out = [];
    let serveUrl = null;
    for (let i = 0; i < argv.length; i++) {
        const next = argv[i + 1];
        if (argv[i] === '--serve' && typeof next === 'string' && /^wss?:\/\//.test(next)) {
            serveUrl = next;
            out.push('--serve');
            i += 1;
            continue;
        }
        out.push(argv[i]);
    }
    return { argv: out, serveUrl };
}

/**
 * Accept only ws://127.0.0.1 or ws://localhost.
 * @param {string} value
 * @returns {URL}
 * @exports
 * @ai.hint pure
 */
export function assertLoopback(value) {
    let url;
    try { url = new URL(value); }
    catch { throw new UsageError(`Некорректный адрес --serve: ${value}`); }
    if (url.protocol !== 'ws:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
        throw new UsageError('Адрес --serve должен быть ws://127.0.0.1 или ws://localhost.');
    }
    return url;
}

/**
 * Read ~/.ai-agent/serve.json.
 * @param {string} home
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function readServeFile(home) {
    const file = path.join(home, 'serve.json');
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new UsageError(`Нет запущенного ai serve. Ожидался ${file}.`); }
}

/**
 * Wait until a ready or error frame arrives.
 * @param {object[]} frames
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function waitReady(frames) {
    for (let i = 0; i < 50; i++) {
        const found = frames.find((frame) => frame.type === 'ready' || frame.type === 'error');
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new UsageError('ai serve не ответил на hello.');
}

/**
 * Connect as a publisher. A URL overrides the address in serve.json; the token still comes from that file.
 * @param {{ home: string, url?: string | null, command: string, title: string, cwd: string }} options
 * @returns {Promise<{ event: Function, end: Function, close: Function }>}
 * @exports
 * @ai.hint io
 */
export async function attachPublisher({ home, url = null, command, title, cwd }) {
    const info = await readServeFile(home);
    const target = url || info.url;
    assertLoopback(target);
    const ws = new WebSocket(target);
    const frames = [];
    ws.addEventListener('message', (event) => {
        try { frames.push(JSON.parse(String(event.data))); } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new UsageError(`Не удалось подключиться к ${target}.`)), { once: true });
    });
    ws.send(JSON.stringify({ type: 'hello', role: 'publisher', token: info.token, command, title, cwd }));
    const ready = await waitReady(frames);
    if (ready?.code === 'unauthorized') throw new UsageError('Токен ai serve не принят.');
    return {
        event(value) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', event: sanitizeValue(value) }));
        },
        end(status, exitCode) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end', status, exitCode }));
            return Promise.resolve();
        },
        close() { ws.close(); },
    };
}
