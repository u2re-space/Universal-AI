import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { listenProtocol, MAX_FRAME_BYTES } from '../src/server/protocol.js';

function once(target, event) {
    return new Promise((resolve, reject) => {
        const ok = (...args) => { cleanup(); resolve(args.length <= 1 ? args[0] : args); };
        const fail = (error) => { cleanup(); reject(error); };
        const cleanup = () => {
            target.removeEventListener?.(event, ok);
            target.removeEventListener?.('error', fail);
        };
        target.addEventListener(event, ok);
        target.addEventListener?.('error', fail);
    });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('text frames round-trip through the HTTP upgrade', async () => {
    let received = '';
    const server = await listenProtocol({
        onConnection(conn) { conn.on('message', (text) => { received = text; conn.send(`echo:${text}`); }); },
    });
    try {
        const ws = new WebSocket(server.url);
        await once(ws, 'open');
        ws.send('привет');
        const reply = await once(ws, 'message');
        assert.equal(received, 'привет');
        assert.equal(String(reply.data), 'echo:привет');
        ws.close();
    } finally {
        await server.close();
    }
});

test('a binary frame closes with 1003', async () => {
    const server = await listenProtocol({ onConnection() {} });
    try {
        const ws = new WebSocket(server.url);
        await once(ws, 'open');
        ws.send(new Uint8Array([1, 2, 3]));
        const event = await once(ws, 'close');
        assert.equal(event.code, 1003);
    } finally {
        await server.close();
    }
});

test('pings keep a quiet socket open and a socket with no ping dies at the idle limit', async () => {
    const alive = await listenProtocol({ pingIntervalMs: 30, idleMs: 200, onConnection() {} });
    const dead = await listenProtocol({ pingIntervalMs: 0, idleMs: 80, onConnection() {} });
    try {
        const ws = new WebSocket(alive.url);
        await once(ws, 'open');
        await delay(250);
        assert.equal(ws.readyState, WebSocket.OPEN);
        ws.close();
        const idle = new WebSocket(dead.url);
        await once(idle, 'open');
        const event = await once(idle, 'close');
        assert.equal(event.code, 1001);
    } finally {
        await alive.close();
        await dead.close();
    }
});

test('a single text frame larger than 1 MiB closes with 1009', async () => {
    const server = await listenProtocol({ onConnection() {} });
    try {
        const socket = await new Promise((resolve, reject) => {
            const client = net.connect(server.port, '127.0.0.1', () => {
                const key = randomBytes(16).toString('base64');
                client.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            });
            let buf = Buffer.alloc(0);
            const onData = (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                if (!buf.includes(Buffer.from('\r\n\r\n'))) return;
                client.off('data', onData);
                resolve(client);
            };
            client.on('data', onData);
            client.on('error', reject);
        });
        const length = MAX_FRAME_BYTES + 1;
        const head = Buffer.alloc(14);
        head[0] = 0x81;
        head[1] = 0xFF;
        head.writeBigUInt64BE(BigInt(length), 2);
        head.writeUInt32BE(0, 10);
        const bytes = await new Promise((resolve) => {
            const parts = [];
            socket.on('data', (chunk) => parts.push(chunk));
            socket.on('close', () => resolve(Buffer.concat(parts)));
            socket.write(head);
        });
        assert.ok(bytes.includes(Buffer.from('too_large')), bytes.toString('utf8'));
        const closeAt = bytes.indexOf(Buffer.from([0x88]));
        assert.ok(closeAt >= 0);
        assert.equal(bytes.readUInt16BE(closeAt + 2), 1009);
    } finally {
        await server.close();
    }
});
