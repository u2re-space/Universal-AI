/**
 * @file src/complete/server.js
 * @module complete/server
 * @purpose Local HTTP and WebSocket API for editor code completion.
 * @depends node:http, node:crypto, openai/errors, complete/errors, complete/ws
 * @usedBy commands/complete, index.js
 * @exports startCompletionServer
 * @ai.tags complete, http, websocket
 * @ai.hint io
 * @changed 2026-10-15 IDE completion endpoint.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../openai/errors.js';
import { CompletionError } from './errors.js';
import { acceptKey, encodeServerFrame, readClientFrames } from './ws.js';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

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
 * Bearer token, X-Complete-Token, or ?token= from an upgrade or HTTP request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 * @ai.hint pure
 */
function tokenFrom(req) {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) return header.slice(7);
    const named = req.headers['x-complete-token'];
    if (typeof named === 'string' && named) return named;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    return url.searchParams.get('token');
}

/**
 * Map a failure to a status, code, and message safe to send to the editor.
 * @param {Error} error
 * @returns {{ status: number, code: string, message: string }}
 * @ai.hint pure
 */
function publicError(error) {
    if (error instanceof CompletionError) return { status: error.status, code: error.code, message: error.message };
    if (error instanceof ApiError) return { status: 502, code: error.code ?? 'API_ERROR', message: error.message };
    return { status: 500, code: 'ERROR', message: error?.message ?? 'Ошибка дополнения.' };
}

/**
 * Read a JSON body up to the byte cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function readJson(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) throw new CompletionError('Тело запроса больше 8 МиБ. Сократите контекст файла.', { status: 413, code: 'TOO_LARGE' });
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) throw new CompletionError('Пустое тело запроса.');
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
        return parsed;
    } catch (error) {
        if (error instanceof CompletionError) throw error;
        throw new CompletionError('Тело запроса не JSON-объект.');
    }
}

/**
 * Speak text frames on one upgraded socket.
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head Bytes already read past the handshake.
 * @param {{ onText: (text: string) => Promise<void>, signal: AbortSignal }} options
 * @returns {void}
 * @ai.hint io
 */
function speakWebSocket(socket, head, { onText, signal }) {
    let buffer = Buffer.from(head ?? []);
    let fragments = [];
    let fragmentBytes = 0;
    /**
     * Send one text frame.
     * @param {string} text
     * @returns {void}
     * @ai.hint io
     */
    const send = (text) => { if (!socket.destroyed) socket.write(encodeServerFrame(0x1, text)); };
    /**
     * Deliver one complete text message.
     * @param {Buffer} payload
     * @returns {void}
     * @ai.hint io
     */
    const deliver = (payload) => {
        onText(payload.toString('utf8')).catch((error) => {
            const body = publicError(error);
            send(JSON.stringify({ type: 'error', message: body.message, code: body.code }));
        });
    };
    /**
     * Parse whatever is buffered and answer control frames.
     * @returns {void}
     * @ai.hint io
     */
    const consume = () => {
        const parsed = readClientFrames(buffer, MAX_FRAME_BYTES);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
            if (frame.opcode === 0x9) { socket.write(encodeServerFrame(0xA, frame.payload)); continue; }
            if (frame.opcode === 0xA) continue;
            if (frame.opcode === 0x8) { socket.end(encodeServerFrame(0x8, Buffer.alloc(0))); return; }
            if (frame.opcode === 0x1 && frame.fin) { deliver(frame.payload); continue; }
            if (frame.opcode === 0x1 && !frame.fin) {
                fragments = [frame.payload];
                fragmentBytes = frame.payload.length;
                continue;
            }
            if (frame.opcode === 0x0) {
                fragmentBytes += frame.payload.length;
                if (fragmentBytes > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE');
                fragments.push(frame.payload);
                if (frame.fin) {
                    deliver(Buffer.concat(fragments));
                    fragments = [];
                    fragmentBytes = 0;
                }
                continue;
            }
            socket.destroy();
            return;
        }
    };
    socket.on('data', (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
        try { consume(); }
        catch { socket.destroy(); }
    });
    if (buffer.length) {
        try { consume(); }
        catch { socket.destroy(); }
    }
    /**
     * Drop the socket when the server is stopping.
     * @returns {void}
     * @ai.hint io
     */
    const stop = () => socket.destroy();
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    socket.on('close', () => signal.removeEventListener?.('abort', stop));
}

/**
 * Listen on 127.0.0.1 for POST /v1/complete and a WebSocket on the same path.
 * @param {{ port?: number, token?: string|null, handle: (request: object, signal: AbortSignal) => Promise<object>, signal?: AbortSignal }} options
 * @returns {Promise<{ port: number, httpURL: string, wsURL: string, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startCompletionServer({ port = 8765, token = null, handle, signal } = {}) {
    if (typeof handle !== 'function') throw new TypeError('Нужен handle для запроса дополнения.');
    const sockets = new Set();
    const controller = new AbortController();
    /**
     * Run one completion and hide internal failures behind a public error.
     * @param {object} request
     * @returns {Promise<object>}
     * @ai.hint io
     */
    const run = (request) => handle(request, controller.signal);
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        /**
         * Write a JSON response.
         * @param {number} status
         * @param {object} body
         * @returns {void}
         * @ai.hint io
         */
        const json = (status, body) => {
            const payload = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
            res.end(payload);
        };
        try {
            if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
            if (url.pathname !== '/v1/complete') return json(404, { error: { code: 'NOT_FOUND', message: 'Неизвестный путь.' } });
            if (req.method !== 'POST') return json(405, { error: { code: 'METHOD', message: 'Нужен POST /v1/complete.' } });
            if (!tokenOk(token, tokenFrom(req))) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Неверный токен дополнения.' } });
            const request = await readJson(req);
            const result = await run(request);
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
        if (url.pathname !== '/v1/complete' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
            socket.destroy();
            return;
        }
        if (!tokenOk(token, tokenFrom(req))) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
        }
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
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
                if (message.type && message.type !== 'complete') {
                    socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'error', id: message.id ?? null, message: 'Неизвестный тип кадра.', code: 'BAD_REQUEST' })));
                    return;
                }
                const result = await run(message);
                socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'completion', id: message.id ?? null, ...result })));
            },
        });
    });

    /**
     * Stop accepting and close every socket.
     * @returns {void}
     * @ai.hint io
     */
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
        server.listen(port, HOST, resolve);
    });
    const bound = server.address().port;
    return {
        port: bound,
        httpURL: `http://${HOST}:${bound}/v1/complete`,
        wsURL: `ws://${HOST}:${bound}/v1/complete`,
        /**
         * Close the listener and open sockets.
         * @returns {Promise<void>}
         * @ai.hint io
         */
        close: () => new Promise((resolve) => {
            shutdown();
            server.close(() => resolve());
        }),
    };
}
