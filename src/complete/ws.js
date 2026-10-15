/**
 * @file src/complete/ws.js
 * @module complete/ws
 * @purpose Minimal WebSocket frames on a Node HTTP upgrade. Node has a client and no server.
 * @depends node:crypto
 * @usedBy complete/server
 * @exports acceptKey, encodeServerFrame, readClientFrames
 * @ai.tags complete, websocket
 * @ai.hint pure
 * @changed 2026-10-15 Text frames for editor completion.
 */

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Sec-WebSocket-Accept for a client key.
 * @param {string} key Sec-WebSocket-Key header.
 * @returns {string} Base64 accept value.
 * @exports
 * @ai.hint pure
 */
export function acceptKey(key) {
    return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/**
 * One unmasked server frame. Opcode 1 is text, 8 close, 9 ping, 10 pong.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @returns {Buffer}
 * @exports
 * @ai.hint pure
 */
export function encodeServerFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, data]);
}

/**
 * Pull masked client frames out of a buffer. Unmasked client frames are rejected.
 * @param {Buffer} buffer Bytes received so far.
 * @param {number} maxBytes Largest accepted payload.
 * @returns {{ frames: { fin: boolean, opcode: number, payload: Buffer }[], rest: Buffer }}
 * @exports
 * @ai.hint pure
 */
export function readClientFrames(buffer, maxBytes) {
    const frames = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let pos = offset + 2;
        if (length === 126) {
            if (buffer.length < pos + 2) break;
            length = buffer.readUInt16BE(pos);
            pos += 2;
        } else if (length === 127) {
            if (buffer.length < pos + 8) break;
            const wide = buffer.readBigUInt64BE(pos);
            if (wide > BigInt(maxBytes)) throw new Error('FRAME_TOO_LARGE');
            length = Number(wide);
            pos += 8;
        }
        if (length > maxBytes) throw new Error('FRAME_TOO_LARGE');
        if (!masked) throw new Error('UNMASKED');
        if (buffer.length < pos + 4 + length) break;
        const mask = buffer.subarray(pos, pos + 4);
        const payload = Buffer.from(buffer.subarray(pos + 4, pos + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        frames.push({ fin, opcode, payload });
        offset = pos + 4 + length;
    }
    if (frames.length === 0 && buffer.length > maxBytes + 14) throw new Error('FRAME_TOO_LARGE');
    return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}
