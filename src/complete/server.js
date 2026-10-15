/**
 * @file src/complete/server.js
 * @module complete/server
 * @purpose Local HTTP and WebSocket API for editor code completion.
 * @depends node:http, node:crypto, openai/errors, complete/errors, complete/ws
 * @usedBy commands/complete, index.js
 * @exports startCompletionServer, createCompletionBridge
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
 * True when no token is required, or `got` matches one required token.
 * @param {string[]} tokens
 * @param {string|null} got
 * @returns {boolean}
 * @ai.hint pure
 */
function tokensOk(tokens, got) {
    if (!tokens.length) return true;
    return tokens.some((token) => tokenOk(token, got));
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

const COMPLETION_PATHS = new Set(['/v1/complete', '/v1/structure']);

/**
 * HTTP and WebSocket handlers for editor completion, attachable to any local server.
 * An empty token list allows every request. Otherwise one of the tokens must match.
 * @param {{ tokens?: Array<string|null|undefined>, handle?: Function|null, structure?: Function|null, signal?: AbortSignal }} [options]
 * @returns {{ handleRequest: Function, handleUpgrade: Function, stop: Function }}
 * @exports
 * @ai.hint io
 */
export function createCompletionBridge({ tokens = [], handle = null, structure = null, signal } = {}) {
    const accepted = tokens.filter((item) => typeof item === 'string' && item);
    const sockets = new Set();
    const controller = new AbortController();
    /**
     * Abort in-flight completions and drop editor sockets.
     * @returns {void}
     * @ai.hint io
     */
    const stop = () => {
        controller.abort();
        for (const socket of sockets) socket.destroy();
    };
    if (signal) {
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
    }
    const run = (request) => handle(request, controller.signal);
    const runStructure = (request) => structure(request, controller.signal);

    /**
     * Answer /health, /v1/complete, and /v1/structure. Other paths return false.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {Promise<boolean>}
     * @ai.hint io
     */
    async function handleRequest(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        /**
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
        if (req.method === 'GET' && url.pathname === '/health') {
            json(200, { ok: true });
            return true;
        }
        if (!COMPLETION_PATHS.has(url.pathname)) return false;
        try {
            const route = url.pathname === '/v1/complete' ? handle : structure;
            if (typeof route !== 'function') {
                json(404, { error: { code: 'NOT_FOUND', message: 'Неизвестный путь.' } });
                return true;
            }
            if (req.method !== 'POST') {
                json(405, { error: { code: 'METHOD', message: 'Нужен POST.' } });
                return true;
            }
            if (!tokensOk(accepted, tokenFrom(req))) {
                json(401, { error: { code: 'UNAUTHORIZED', message: 'Неверный токен.' } });
                return true;
            }
            const request = await readJson(req);
            const result = url.pathname === '/v1/structure' ? await runStructure(request) : await run(request);
            json(200, { id: request.id ?? null, ...result });
        } catch (error) {
            const body = publicError(error);
            if (!res.headersSent) json(body.status, { error: { code: body.code, message: body.message } });
            else res.destroy();
        }
        return true;
    }

    /**
     * Take a WebSocket upgrade for the editor paths. Other paths return false.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:net').Socket} socket
     * @param {Buffer} head
     * @returns {boolean}
     * @ai.hint io
     */
    function handleUpgrade(req, socket, head) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!COMPLETION_PATHS.has(url.pathname)) return false;
        const key = req.headers['sec-websocket-key'];
        if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
            socket.destroy();
            return true;
        }
        if (!tokensOk(accepted, tokenFrom(req))) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return true;
        }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
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
                if (message.type === 'structure') {
                    if (typeof structure !== 'function') {
                        socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'error', id: message.id ?? null, message: 'Структура не включена.', code: 'NOT_FOUND' })));
                        return;
                    }
                    const result = await runStructure(message);
                    socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'structured', id: message.id ?? null, ...result })));
                    return;
                }
                if (message.type && message.type !== 'complete') {
                    socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'error', id: message.id ?? null, message: 'Неизвестный тип кадра.', code: 'BAD_REQUEST' })));
                    return;
                }
                if (typeof handle !== 'function') {
                    socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'error', id: message.id ?? null, message: 'Дополнение не включено.', code: 'NOT_FOUND' })));
                    return;
                }
                const result = await run(message);
                socket.write(encodeServerFrame(0x1, JSON.stringify({ type: 'completion', id: message.id ?? null, ...result })));
            },
        });
        return true;
    }

    return { handleRequest, handleUpgrade, stop };
}

/**
 * Listen on 127.0.0.1 for POST /v1/complete and a WebSocket on the same path.
 * @param {{ port?: number, token?: string|null, handle: (request: object, signal: AbortSignal) => Promise<object>, structure?: Function|null, signal?: AbortSignal }} options
 * @returns {Promise<{ port: number, httpURL: string, wsURL: string, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startCompletionServer({ port = 8765, token = null, handle = null, structure = null, signal } = {}) {
    if (typeof handle !== 'function' && typeof structure !== 'function') throw new TypeError('Нужен handle или structure.');
    const bridge = createCompletionBridge({ tokens: token ? [token] : [], handle, structure, signal });
    const server = http.createServer(async (req, res) => {
        const handled = await bridge.handleRequest(req, res);
        if (handled) return;
        const payload = JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Неизвестный путь.' } });
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
    });
    server.on('upgrade', (req, socket, head) => {
        if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
    });
    const bound = server.address().port;
    return {
        port: bound,
        httpURL: `http://${HOST}:${bound}/v1/complete`,
        structureURL: `http://${HOST}:${bound}/v1/structure`,
        wsURL: `ws://${HOST}:${bound}/v1/complete`,
        /**
         * Close the listener and open sockets.
         * @returns {Promise<void>}
         * @ai.hint io
         */
        close: () => new Promise((resolve) => {
            bridge.stop();
            server.close(() => resolve());
        }),
    };
}
