/**
 * Tiny stdio MCP server for tests. Speaks Content-Length frames and exits when stdin ends.
 * Tools: echo. Resources: mcp://demo/note.
 */
import { createFrameParser, encodeMessage } from '../../src/mcp/frame.js';

const parser = createFrameParser();

/**
 * Write one JSON-RPC result frame.
 * @param {number|string} id
 * @param {object} result
 * @returns {void}
 */
function reply(id, result) {
    process.stdout.write(encodeMessage({ jsonrpc: '2.0', id, result }));
}

/**
 * Handle one client message. Notifications are ignored except by not replying.
 * @param {object} message
 * @returns {void}
 */
function handle(message) {
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method === 'initialize') {
        reply(message.id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'fixture', version: '0' },
        });
        return;
    }
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'ping') {
        reply(message.id, {});
        return;
    }
    if (message.method === 'tools/list') {
        reply(message.id, {
            tools: [{
                name: 'echo',
                description: 'Echo the text',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            }],
        });
        return;
    }
    if (message.method === 'tools/call') {
        const text = message.params?.arguments?.text ?? '';
        reply(message.id, { content: [{ type: 'text', text: `echo:${text}` }], isError: false });
        return;
    }
    if (message.method === 'resources/list') {
        reply(message.id, { resources: [{ uri: 'mcp://demo/note', name: 'note' }] });
        return;
    }
    if (message.method === 'resources/read') {
        reply(message.id, { contents: [{ uri: message.params?.uri, text: 'hello resource' }] });
        return;
    }
    if (message.id != null) {
        process.stdout.write(encodeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } }));
    }
}

process.stdin.on('data', (chunk) => {
    for (const message of parser.push(chunk)) handle(message);
});
process.stdin.on('end', () => process.exit(0));
