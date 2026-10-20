/**
 * @file src/server/protocol.js
 * @module server/protocol
 * @purpose WebSocket over a Node HTTP upgrade. Node has a client and no server.
 * @depends node:http, node:events, node:crypto
 * @usedBy commands/serve, index.js
 * @exports MAX_FRAME_BYTES, listenProtocol
 * @ai.tags websocket, http
 * @ai.hint io
 * @changed 2026-10-15 Localhost text frames, ping, and a 1 MiB cap.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Largest accepted WebSocket payload. A larger frame closes the socket with 1009. */
export const MAX_FRAME_BYTES = 1_048_576;

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Sec-WebSocket-Accept for a client key.
 * @param {string} key
 * @returns {string}
 * @ai.hint pure
 */
function acceptKey(key) {
    return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/**
 * One unmasked server frame. Opcode 1 is text, 8 close, 9 ping, 10 pong.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @returns {Buffer}
 * @ai.hint pure
 */
function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    const len = data.length;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, data]);
}

/**
 * Decode masked client frames on one upgraded socket and emit complete text messages.
 * @param {import('node:net').Socket} socket
 * @param {{ onConnection: Function, pingIntervalMs: number, idleMs: number, maxFrameBytes: number }} options
 * @returns {void}
 * @ai.hint io
 */
function attachSocket(socket, { onConnection, pingIntervalMs, idleMs, maxFrameBytes }) {
    const conn = new EventEmitter();
    let buffer = Buffer.alloc(0);
    let alive = true;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    /**
     * @param {number} code
     * @returns {void}
     * @ai.hint io
     */
    const shutdown = (code) => {
        if (!alive) return;
        alive = false;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code);
        try { socket.write(encodeFrame(0x8, payload)); } catch { /* already gone */ }
        socket.end();
        conn.emit('close', code);
    };
    conn.send = (text) => { if (alive) socket.write(encodeFrame(0x1, Buffer.from(String(text)))); };
    conn.close = (code = 1000) => shutdown(code);
    /**
     * @param {number} code
     * @param {string} [text]
     * @returns {void}
     * @ai.hint io
     */
    const fail = (code, text) => {
        if (text && alive) conn.send(text);
        shutdown(code);
    };
    /**
     * @param {Buffer} chunk
     * @returns {void}
     * @ai.hint io
     */
    const onData = (chunk) => {
        if (!alive) return;
        touch();
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            if (!alive || buffer.length < 2) return;
            const first = buffer[0];
            const second = buffer[1];
            if ((first & 0x70) !== 0) return fail(1002);
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                const declared = buffer.readBigUInt64BE(2);
                if (declared > BigInt(maxFrameBytes)) return fail(1009, JSON.stringify({ type: 'error', code: 'too_large', message: 'Кадр не помещается в 1 МиБ.' }));
                length = Number(declared);
                offset = 10;
            }
            if (!fin || opcode === 0) return fail(1007);
            if (!masked) return fail(1002);
            if (length > maxFrameBytes) return fail(1009, JSON.stringify({ type: 'error', code: 'too_large', message: 'Кадр не помещается в 1 МиБ.' }));
            if ((opcode & 0x8) !== 0 && length > 125) return fail(1002);
            const width = offset + 4 + length;
            if (buffer.length < width) return;
            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, width));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            buffer = buffer.subarray(width);
            if (opcode === 0x1) {
                let text;
                try { text = decoder.decode(payload); }
                catch { return fail(1007); }
                conn.emit('message', text);
            } else if (opcode === 0x2) return fail(1003);
            else if (opcode === 0x8) return shutdown(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
            else if (opcode === 0x9) socket.write(encodeFrame(0xA, payload));
            else if (opcode === 0xA) touch();
            else return fail(1002);
        }
    };
    socket.on('data', onData);
    socket.on('close', () => { if (alive) { alive = false; conn.emit('close', 1006); } });
    socket.on('error', () => shutdown(1006));
    const ping = pingIntervalMs > 0 ? setInterval(() => { if (alive) socket.write(encodeFrame(0x9, Buffer.alloc(0))); }, pingIntervalMs) : null;
    const idle = setInterval(() => { if (alive && Date.now() - last > idleMs) shutdown(1001); }, Math.max(15, Math.min(idleMs, 1000)));
    ping?.unref?.();
    idle.unref?.();
    const stop = () => { if (ping) clearInterval(ping); clearInterval(idle); };
    conn.on('close', stop);
    socket.on('close', stop);
    onConnection(conn);
}

/**
 * Listen on 127.0.0.1 and accept WebSocket upgrades. `pingIntervalMs` 0 disables pings.
 * @param {{ port?: number, host?: string, onConnection: Function, onRequest?: Function, onUpgrade?: Function, pingIntervalMs?: number, idleMs?: number, maxFrameBytes?: number }} [options]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export function listenProtocol({ port = 3000, host = '127.0.0.1', onConnection, onRequest = null, onUpgrade = null, pingIntervalMs = 30_000, idleMs = 90_000, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    if (host !== '127.0.0.1') return Promise.reject(new Error('WebSocket-сервер слушает только 127.0.0.1.'));
    const sockets = new Set();
    const server = http.createServer(async (req, res) => {
        try {
            if (onRequest && await onRequest(req, res)) return;
        } catch {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Ошибка сервера.\n');
            }
            return;
        }
        if (!res.headersSent) {
            res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Требуется WebSocket.\n');
        }
    });
    server.on('upgrade', (req, socket, head) => {
        if (onUpgrade?.(req, socket, head)) return;
        const key = req.headers['sec-websocket-key'];
        const connection = String(req.headers.connection ?? '');
        if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !/upgrade/i.test(connection) || !key) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        attachSocket(socket, { onConnection, pingIntervalMs, idleMs, maxFrameBytes });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const address = server.address();
            resolve({
                url: `ws://127.0.0.1:${address.port}`,
                port: address.port,
                close: () => new Promise((done) => {
                    for (const sock of sockets) sock.destroy();
                    server.close(() => done());
                }),
            });
        });
    });
}
