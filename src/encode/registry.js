/**
 * @file src/encode/registry.js
 * @module encode/registry
 * @purpose Process-wide tool holders for the encode MCP server.
 * @depends node:crypto, server/protocol
 * @usedBy encode/host
 * @exports createProcessRegistry
 * @ai.tags websocket, tools
 * @ai.hint io
 * @changed 2026-10-19 Claim frames without a run id.
 */

import { randomUUID } from 'node:crypto';
import { listenProtocol } from '../server/protocol.js';

const PROCESSABLE = ['delete_file', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file'];
const PROCESSABLE_SET = new Set(PROCESSABLE);
const CHANGE_OPS = new Set(['create', 'overwrite', 'edit', 'delete']);

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ type: 'error', code: string, message: string }}
 * @ai.hint pure
 */
function errorFrame(code, message) {
    return { type: 'error', code, message };
}

/**
 * @param {unknown} list
 * @returns {string}
 * @ai.hint pure
 */
function validateToolList(list) {
    if (!Array.isArray(list)) return 'tools должен быть массивом.';
    const seen = new Set();
    for (const name of list) {
        if (seen.has(name)) return `Имя инструмента повторяется: ${name}.`;
        seen.add(name);
    }
    for (const name of list) {
        if (typeof name !== 'string' || !PROCESSABLE_SET.has(name)) return `Инструмент недоступен для захвата: ${name}.`;
    }
    return '';
}

/**
 * @param {unknown} changes
 * @returns {{ changes?: object[], error?: string }}
 * @ai.hint pure
 */
function parseChanges(changes) {
    if (changes === undefined) return { changes: [] };
    if (!Array.isArray(changes) || changes.length > 100) return { error: 'changes: op create, overwrite, edit или delete и path-строка.' };
    const parsed = [];
    for (const item of changes) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !CHANGE_OPS.has(item.op) || typeof item.path !== 'string') {
            return { error: 'changes: op create, overwrite, edit или delete и path-строка.' };
        }
        parsed.push({ op: item.op, path: item.path });
    }
    return { changes: parsed };
}

/**
 * Hold tool names for one command process.
 * @param {{ createId?: () => string }} [options]
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createProcessRegistry({ createId = () => randomUUID() } = {}) {
    /** @type {Map<string, object>} */
    const sockets = new Map();
    /** @type {Map<string, string>} */
    const holders = new Map();
    /** @type {Map<string, object>} */
    const pending = new Map();
    let socketCount = 0;

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    const send = (socket, frame) => { try { socket.send(frame); } catch { /* observer */ } };

    /**
     * @returns {void}
     * @ai.hint pure
     */
    function publishHeld() {
        const tools = [...holders.keys()].sort();
        for (const socket of sockets.values()) if (socket.authed) send(socket, { type: 'processing.held', tools });
    }

    /**
     * @param {object} socket
     * @param {string[]} tools
     * @returns {void}
     * @ai.hint pure
     */
    function applyClaim(socket, tools) {
        const next = new Set(tools);
        /** @type {Map<string, string[]>} */
        const released = new Map();
        for (const [name, holderId] of [...holders.entries()]) {
            const mine = holderId === socket.id;
            if (mine && !next.has(name)) holders.delete(name);
            if (!mine && next.has(name)) {
                holders.delete(name);
                const names = released.get(holderId) ?? [];
                names.push(name);
                released.set(holderId, names);
            }
        }
        for (const name of tools) holders.set(name, socket.id);
        for (const [holderId, names] of released) {
            sockets.get(holderId)?.send({ type: 'processing.released', tools: names.sort() });
        }
        send(socket, { type: 'processing.claimed', tools: [...tools] });
        publishHeld();
    }

    /**
     * @param {object} transport
     * @returns {object}
     * @ai.hint pure
     */
    function connect(transport) {
        const socket = {
            id: `s${++socketCount}`,
            send: (frame) => transport.send(frame),
            close: (code) => transport.close?.(code),
            authed: false,
        };
        sockets.set(socket.id, socket);
        return socket;
    }

    /**
     * @param {object} socket
     * @returns {void}
     * @ai.hint pure
     */
    function disconnect(socket) {
        sockets.delete(socket.id);
        for (const [name, holderId] of [...holders.entries()]) if (holderId === socket.id) holders.delete(name);
        for (const item of [...pending.values()]) {
            if (item.holderId === socket.id) item.resolve(new Error('Держатель инструмента отключился.'));
        }
        publishHeld();
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function receive(socket, frame) {
        if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
            send(socket, errorFrame('bad_request', 'Кадр должен быть JSON-объектом.'));
            return;
        }
        if (!socket.authed) {
            if (frame.type !== 'hello') {
                send(socket, errorFrame('unauthorized', 'Сначала отправьте hello.'));
                return;
            }
            socket.authed = true;
            send(socket, { type: 'ready' });
            return;
        }
        if (frame.type === 'hello') {
            send(socket, errorFrame('conflict', 'Повторный hello.'));
            return;
        }
        if (frame.type === 'processing.claim') {
            const problem = validateToolList(frame.tools);
            if (problem) {
                send(socket, errorFrame('bad_request', problem));
                return;
            }
            applyClaim(socket, frame.tools);
            return;
        }
        if (frame.type === 'tool.result') {
            const item = typeof frame.requestId === 'string' ? pending.get(frame.requestId) : null;
            if (!item) {
                send(socket, errorFrame('bad_request', 'Неизвестный requestId.'));
                return;
            }
            if (item.holderId !== socket.id) {
                send(socket, errorFrame('bad_request', 'Этот requestId адресован другому сокету.'));
                return;
            }
            if (frame.error !== undefined && typeof frame.error !== 'string') {
                send(socket, errorFrame('bad_request', 'error должен быть строкой.'));
                return;
            }
            if (typeof frame.error === 'string' && frame.error.trim()) {
                item.resolve(new Error(frame.error));
                return;
            }
            if (typeof frame.output !== 'string' || typeof frame.summary !== 'string') {
                send(socket, errorFrame('bad_request', 'output и summary должны быть строками.'));
                return;
            }
            const parsed = parseChanges(frame.changes);
            if (parsed.error) {
                send(socket, errorFrame('bad_request', parsed.error));
                return;
            }
            item.resolve(null, { output: frame.output, summary: frame.summary, changes: parsed.changes });
            return;
        }
        send(socket, errorFrame('unknown_type', `Неизвестный тип кадра: ${frame.type}.`));
    }

    /**
     * @param {string} name
     * @param {object} args
     * @param {AbortSignal} [signal]
     * @returns {Promise<null | { output: string, summary: string, changes: object[] }>}
     * @ai.hint io
     */
    function requestTool(name, args, signal) {
        if (signal?.aborted) {
            const error = new Error('Отменено.');
            error.name = 'AbortError';
            return Promise.reject(error);
        }
        const holderId = holders.get(name);
        if (!holderId) return Promise.resolve(null);
        const holder = sockets.get(holderId);
        if (!holder) return Promise.reject(new Error('Держатель инструмента отключился.'));
        const requestId = createId();
        return new Promise((resolve, reject) => {
            let settled = false;
            /**
             * @param {Error | null} error
             * @param {object} [value]
             * @returns {void}
             */
            const done = (error, value) => {
                if (settled) return;
                settled = true;
                pending.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
                if (error) reject(error);
                else resolve(value);
            };
            /** @returns {void} */
            const onAbort = () => {
                const error = new Error('Отменено.');
                error.name = 'AbortError';
                done(error);
            };
            pending.set(requestId, { holderId, resolve: done });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            holder.send({ type: 'tool.request', requestId, name, args });
        });
    }

    /**
     * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
     * @ai.hint io
     */
    function listen() {
        return listenProtocol({
            onConnection(conn) {
                const socket = connect({
                    send(frame) { conn.send(JSON.stringify(frame)); },
                    close(code) { conn.close(code); },
                });
                conn.on('message', (text) => {
                    let frame = null;
                    try { frame = JSON.parse(text); } catch { frame = null; }
                    void receive(socket, frame);
                });
                conn.on('close', () => disconnect(socket));
            },
        });
    }

    return { connect, receive, requestTool, disconnect, listen };
}
