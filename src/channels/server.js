/**
 * @file src/channels/server.js
 * @module channels/server
 * @purpose Local HTTP and WebSocket API for decisions, moderation, replies, and Telegram updates.
 * @depends node:http, node:crypto, openai/errors, complete/ws, channels/dispatch, telegram/client
 * @usedBy commands/channels, index.js
 * @exports startChannelServer
 * @ai.tags channels, http, websocket
 * @ai.hint io
 * @changed 2026-10-15 Channel server on localhost unless a token is set.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../openai/errors.js';
import { acceptKey, encodeServerFrame, readClientFrames } from '../complete/ws.js';
import { dispatchChannel } from './dispatch.js';
import { createTelegram } from '../telegram/client.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const ROUTES = new Map([
    ['/v1/decisions', 'decide'],
    ['/v1/moderate', 'moderate'],
    ['/v1/chats/reply', 'reply'],
    ['/v1/telegram/webhook', 'telegram'],
]);

/**
 * Constant-time token check. An empty expected token allows the request.
 * @param {string|null} expected
 * @param {string|null} got
 * @returns {boolean}
 * @ai.hint pure
 */
function tokenOk(expected, got) {
    if (!expected) return true;
    if (typeof got !== 'string') return false;
    const left = Buffer.from(expected);
    const right = Buffer.from(got);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/**
 * Bearer token or ?token= from an upgrade or HTTP request.
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @returns {string|null}
 * @ai.hint pure
 */
function tokenFrom(req, url) {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) return header.slice(7);
    return url.searchParams.get('token');
}

/**
 * Public error body. Validation is 400. API failures are 502.
 * @param {Error} error
 * @returns {{ status: number, code: string, message: string }}
 * @ai.hint pure
 */
function publicError(error) {
    if (error instanceof TypeError) return { status: 400, code: 'BAD_REQUEST', message: error.message };
    if (error instanceof ApiError) return { status: 502, code: error.code ?? 'API_ERROR', message: error.message };
    return { status: 500, code: 'ERROR', message: error?.message ?? 'Ошибка каналов.' };
}

/**
 * Refuse a non-loopback bind when no token is configured.
 * @param {string} host
 * @param {string|null} token
 * @returns {void}
 * @ai.hint pure
 */
function assertBind(host, token) {
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!loopback && host !== '0.0.0.0') throw new TypeError('channels.host: 127.0.0.1, localhost, ::1 или 0.0.0.0.');
    if (!loopback && !token) throw new TypeError('Адрес вне localhost требует channels.token.');
}

/**
 * Origin with brackets around an IPv6 host.
 * @param {string} host
 * @param {number} port
 * @returns {string}
 * @ai.hint pure
 */
function origin(host, port) {
    const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${name}:${port}`;
}

/**
 * Read a JSON object up to 1 MiB.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function readJson(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) throw new TypeError('Тело запроса больше 1 МиБ.');
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) throw new TypeError('Пустое тело запроса.');
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('object');
        return parsed;
    } catch (error) {
        if (error instanceof TypeError && error.message !== 'object') throw error;
        throw new TypeError('Тело запроса не JSON-объект.');
    }
}

/**
 * Speak text frames on one upgraded socket.
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ onText: (text: string) => Promise<void>, signal: AbortSignal }} options
 * @returns {void}
 * @ai.hint io
 */
function speakWebSocket(socket, head, { onText, signal }) {
    let buffer = Buffer.from(head ?? []);
    let fragments = [];
    let fragmentBytes = 0;
    const send = (text) => { if (!socket.destroyed) socket.write(encodeServerFrame(0x1, text)); };
    const deliver = (payload) => {
        onText(payload.toString('utf8')).catch((error) => {
            const body = publicError(error);
            send(JSON.stringify({ type: 'error', message: body.message, code: body.code }));
        });
    };
    const consume = () => {
        const parsed = readClientFrames(buffer, MAX_FRAME_BYTES);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
            if (frame.opcode === 0x9) { socket.write(encodeServerFrame(0xA, frame.payload)); continue; }
            if (frame.opcode === 0xA) continue;
            if (frame.opcode === 0x8) { socket.end(encodeServerFrame(0x8, Buffer.alloc(0))); return; }
            if (frame.opcode === 0x1 && frame.fin) { deliver(frame.payload); continue; }
            if (frame.opcode === 0x1 && !frame.fin) { fragments = [frame.payload]; fragmentBytes = frame.payload.length; continue; }
            if (frame.opcode === 0x0) {
                fragmentBytes += frame.payload.length;
                if (fragmentBytes > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE');
                fragments.push(frame.payload);
                if (frame.fin) { deliver(Buffer.concat(fragments)); fragments = []; fragmentBytes = 0; }
                continue;
            }
            socket.destroy();
            return;
        }
    };
    socket.on('data', (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
        try { consume(); } catch { socket.destroy(); }
    });
    if (buffer.length) { try { consume(); } catch { socket.destroy(); } }
    const stop = () => socket.destroy();
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    socket.on('close', () => signal.removeEventListener?.('abort', stop));
}

/**
 * Listen for channel HTTP and WebSocket requests.
 * Paths: POST /v1/decisions, /v1/moderate, /v1/chats/reply, /v1/telegram/webhook, and WS /v1/channels.
 * @param {{ client: object, config: object, telegram?: object|null, ledger?: object|null, port?: number, host?: string, token?: string|null, signal?: AbortSignal }} options
 * @returns {Promise<{ port: number, host: string, httpURL: string, wsURL: string, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startChannelServer({ client, config, telegram = null, ledger = null, port, host, token, signal } = {}) {
    if (!client) throw new TypeError('Нужен клиент API.');
    const boundHost = host ?? config.channels?.host ?? '127.0.0.1';
    const boundPort = port ?? config.channels?.port ?? 8787;
    const boundToken = token ?? config.channels?.token ?? null;
    assertBind(boundHost, boundToken);
    let owned = null;
    const bot = telegram ?? (config.telegram?.token ? (owned = createTelegram({ token: config.telegram.token, baseURL: config.telegram.baseURL })) : null);
    const sockets = new Set();
    const controller = new AbortController();
    const run = (type, body) => dispatchChannel({
        type, body, client, config, telegram: bot, ledger,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${boundHost.includes(':') ? '127.0.0.1' : boundHost}`);
        const json = (status, body) => {
            const payload = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
            res.end(payload);
        };
        try {
            if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, service: 'channels' });
            const type = ROUTES.get(url.pathname);
            if (!type) return json(404, { error: { code: 'NOT_FOUND', message: 'Неизвестный путь.' } });
            if (req.method !== 'POST') return json(405, { error: { code: 'METHOD', message: 'Нужен POST.' } });
            if (!tokenOk(boundToken, tokenFrom(req, url))) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Неверный токен.' } });
            const request = await readJson(req);
            const result = await run(type, request);
            return json(200, { id: request.id ?? null, ...result });
        } catch (error) {
            const body = publicError(error);
            if (!res.headersSent) json(body.status, { error: { code: body.code, message: body.message } });
            else res.destroy();
        }
    });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const key = req.headers['sec-websocket-key'];
        if (url.pathname !== '/v1/channels' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
            socket.destroy();
            return;
        }
        if (!tokenOk(boundToken, tokenFrom(req, url))) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
        }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        speakWebSocket(socket, head, {
            signal: controller.signal,
            onText: async (text) => {
                let message;
                try { message = JSON.parse(text); }
                catch { socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'error', message: 'Не JSON.', code: 'BAD_REQUEST' }))); return; }
                if (message === null || typeof message !== 'object' || Array.isArray(message)) {
                    socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'error', message: 'Ожидался объект.', code: 'BAD_REQUEST' })));
                    return;
                }
                if (message.type === 'ping') {
                    socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'pong', id: message.id ?? null })));
                    return;
                }
                const result = await run(message.type, message);
                socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'result', id: message.id ?? null, ...result })));
            },
        });
    });
    const shutdown = () => {
        controller.abort();
        for (const socket of sockets) socket.destroy();
    };
    if (signal) {
        if (signal.aborted) shutdown();
        else signal.addEventListener('abort', shutdown, { once: true });
    }
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(boundPort, boundHost, resolve);
    });
    const actual = server.address().port;
    const root = origin(boundHost, actual);
    return {
        port: actual, host: boundHost, httpURL: root, wsURL: `${root.replace(/^http/, 'ws')}/v1/channels`,
        close: () => new Promise((resolve) => {
            shutdown();
            owned?.close();
            server.close(() => resolve());
        }),
    };
}
