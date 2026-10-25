/**
 * @file src/mcp/client.js
 * @module mcp/client
 * @purpose Speak MCP over a stdio child process.
 * @depends node:child_process, mcp/frame, agent/shell
 * @usedBy mcp/session, commands/mcp
 * @exports ACCEPTED_PROTOCOLS, CLIENT_PROTOCOL, connectMcp
 * @ai.tags mcp
 * @ai.hint io
 * @changed 2026-10-15 Initialize, list, and call over Content-Length frames.
 */
import { spawn } from 'node:child_process';
import { createFrameParser, encodeMessage } from './frame.js';
import { childEnvironment } from '../agent/shell.js';

/** Protocol versions this client understands. */
export const ACCEPTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
/** Version sent in `initialize`. */
export const CLIENT_PROTOCOL = '2025-06-18';

/**
 * Join MCP content parts into text. Images and blobs are marked, not inlined.
 * @param {object} result `tools/call` or `resources/read` result.
 * @returns {string}
 * @ai.hint pure
 */
function contentText(result) {
    const parts = Array.isArray(result?.content) ? result.content : Array.isArray(result?.contents) ? result.contents : [];
    const lines = parts.map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string' && part.text) return part.text;
        if (part.type === 'image' || part.blob) return '[binary]';
        return '';
    }).filter(Boolean);
    if (result?.structuredContent) lines.push(JSON.stringify(result.structuredContent));
    return lines.join('\n').trim();
}

/**
 * Start a server, perform the MCP handshake, and return a small client.
 * The child is killed if the handshake throws.
 * @param {{ command: string, args?: string[], env?: object, cwd?: string|null, signal?: AbortSignal, timeoutMs?: number, id?: string }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function connectMcp({ command, args = [], env = {}, cwd = null, signal, timeoutMs = 15_000, id = 'mcp' } = {}) {
    const child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...childEnvironment(), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const pending = new Map();
    const parser = createFrameParser();
    let stderr = '';
    let closed = false;
    let stopped = null;
    let nextId = 0;
    /**
     * Reject every waiter.
     * @param {Error} error
     * @returns {void}
     * @ai.hint io
     */
    const failAll = (error) => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
    };
    /**
     * Write one frame. Throws when stdin is already closed.
     * @param {object} payload
     * @returns {void}
     * @ai.hint io
     */
    const send = (payload) => {
        if (!child.stdin.writable) throw new Error('MCP: stdin закрыт');
        child.stdin.write(encodeMessage(payload));
    };
    /**
     * Answer a server-initiated request. Unknown methods get -32601.
     * @param {object} message
     * @returns {void}
     * @ai.hint io
     */
    const answerServer = (message) => {
        if (message.method === 'ping') {
            send({ jsonrpc: '2.0', id: message.id, result: {} });
            return;
        }
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    };
    /**
     * Route one parsed JSON-RPC message.
     * @param {object} message
     * @returns {void}
     * @ai.hint io
     */
    const dispatch = (message) => {
        if (message.method && Object.hasOwn(message, 'id')) {
            answerServer(message);
            return;
        }
        if (Object.hasOwn(message, 'id') && pending.has(message.id)) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message || 'MCP error'));
            else waiter.resolve(message.result ?? {});
        }
    };
    child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
    });
    child.stdout.on('data', (chunk) => {
        try {
            for (const message of parser.push(chunk)) dispatch(message);
        } catch (error) {
            failAll(error);
            child.kill();
        }
    });
    child.once('error', (error) => failAll(error));
    child.once('exit', (code) => {
        stopped = new Error(`MCP-сервер завершился (код ${code ?? '?'})${stderr ? `: ${stderr.trim()}` : ''}`);
        if (!closed) failAll(stopped);
    });
    if (signal) {
        signal.addEventListener('abort', () => {
            child.kill();
            failAll(signal.reason instanceof Error ? signal.reason : new Error('MCP: отменено'));
        }, { once: true });
    }
    /**
     * Send a request and wait for the matching result.
     * @param {string} method
     * @param {object} [params]
     * @returns {Promise<object>}
     * @ai.hint io
     */
    function call(method, params) {
        if (stopped) return Promise.reject(stopped);
        nextId += 1;
        const idValue = nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(idValue);
                reject(new Error(`MCP: таймаут ${method}`));
            }, timeoutMs);
            pending.set(idValue, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            try {
                send({ jsonrpc: '2.0', id: idValue, method, ...(params ? { params } : {}) });
            } catch (error) {
                clearTimeout(timer);
                pending.delete(idValue);
                reject(error);
            }
        });
    }
    /**
     * Follow `nextCursor` up to ten pages.
     * @param {string} method
     * @param {string} key Result array field.
     * @returns {Promise<object[]>}
     * @ai.hint io
     */
    async function listAll(method, key) {
        const items = [];
        let cursor;
        for (let page = 0; page < 10; page += 1) {
            const result = await call(method, cursor ? { cursor } : {});
            items.push(...(Array.isArray(result[key]) ? result[key] : []));
            cursor = result.nextCursor;
            if (!cursor) break;
        }
        return items;
    }
    /**
     * Stop the child. A second call does nothing.
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function close() {
        if (closed) return;
        closed = true;
        failAll(new Error('MCP-соединение закрыто'));
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    try {
        const init = await call('initialize', {
            protocolVersion: CLIENT_PROTOCOL,
            capabilities: { tools: {}, resources: {} },
            clientInfo: { name: '@u2ai/universal-ai', version: '0.1.6' },
        });
        if (!ACCEPTED_PROTOCOLS.includes(init.protocolVersion)) {
            throw new Error(`MCP: протокол ${init.protocolVersion} не поддерживается`);
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        return {
            id,
            protocolVersion: init.protocolVersion,
            listTools: () => listAll('tools/list', 'tools'),
            /**
             * Call one tool and return its text.
             * @param {string} name
             * @param {object} toolArgs
             * @returns {Promise<{ text: string, isError: boolean }>}
             * @ai.hint io
             */
            async callTool(name, toolArgs) {
                const result = await call('tools/call', { name, arguments: toolArgs ?? {} });
                return { text: contentText(result) || '(пустой ответ MCP)', isError: Boolean(result.isError) };
            },
            listResources: () => listAll('resources/list', 'resources'),
            /**
             * Read one resource URI.
             * @param {string} uri
             * @returns {Promise<string>}
             * @ai.hint io
             */
            async readResource(uri) {
                const result = await call('resources/read', { uri });
                return contentText(result) || '(пустой ресурс)';
            },
            close,
        };
    } catch (error) {
        closed = true;
        child.kill();
        throw error;
    }
}
