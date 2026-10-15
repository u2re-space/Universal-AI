/**
 * @file src/mcp/frame.js
 * @module mcp/frame
 * @purpose Content-Length framing for a stdio MCP session.
 * @usedBy mcp/client, test/helpers/mcp-stdio
 * @exports MCP_MAX_BODY_BYTES, encodeMessage, createFrameParser
 * @ai.tags mcp
 * @ai.hint pure
 * @changed 2026-10-15 Encode and parse MCP stdio frames.
 */

/** Largest JSON body accepted on the stdio stream. */
export const MCP_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * One JSON-RPC message as a Content-Length frame.
 * @param {object} payload
 * @returns {Buffer}
 * @exports
 * @ai.hint pure
 */
export function encodeMessage(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    if (body.length > MCP_MAX_BODY_BYTES) throw new Error(`MCP: сообщение больше ${MCP_MAX_BODY_BYTES} байт`);
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Incremental parser. `push` returns the messages completed by this chunk.
 * @returns {{ push: (chunk: Buffer|string) => object[] }}
 * @exports
 * @ai.hint pure
 */
export function createFrameParser() {
    let buffer = Buffer.alloc(0);
    return {
        /**
         * Append bytes and return every complete JSON message.
         * @param {Buffer|string} chunk
         * @returns {object[]}
         * @ai.hint pure
         */
        push(chunk) {
            const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            buffer = Buffer.concat([buffer, incoming]);
            if (buffer.length > MCP_MAX_BODY_BYTES + 64 * 1024) throw new Error('MCP: поток больше лимита');
            const messages = [];
            while (buffer.length) {
                const sep = buffer.indexOf('\r\n\r\n');
                if (sep < 0) {
                    if (buffer.length > 64 * 1024) throw new Error('MCP: заголовок слишком длинный');
                    break;
                }
                const header = buffer.subarray(0, sep).toString('ascii');
                const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
                if (!match) throw new Error('MCP: нет Content-Length');
                const length = Number(match[1]);
                if (!Number.isSafeInteger(length) || length < 0 || length > MCP_MAX_BODY_BYTES) throw new Error('MCP: некорректный Content-Length');
                const start = sep + 4;
                if (buffer.length < start + length) break;
                const body = buffer.subarray(start, start + length).toString('utf8');
                messages.push(JSON.parse(body));
                buffer = Buffer.from(buffer.subarray(start + length));
            }
            return messages;
        },
    };
}
