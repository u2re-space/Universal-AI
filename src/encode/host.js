/**
 * @file src/encode/host.js
 * @module encode/host
 * @purpose Start the encode MCP listener and the process claim registry.
 * @depends encode/registry, agent/tools, server/protocol
 * @usedBy commands/run, commands/chat
 * @exports startEncodeHost
 * @ai.tags mcp, encode
 * @ai.hint io
 * @changed 2026-10-19 Localhost MCP and processing sockets share one port.
 */

import { listenProtocol } from '../server/protocol.js';
import { createProcessRegistry } from './registry.js';
import { createToolset } from '../agent/tools.js';

const TOOLS = ['list_files', 'read_file', 'search_files', 'write_file', 'replace_text', 'delete_file', 'run_command', 'run_script'];

/**
 * Open the MCP server and the claim registry. Loads TypeScript only from here.
 * @param {{ root: string, config: object, decide?: Function, signal?: AbortSignal, stderr?: object, approvalLevel?: string, emit?: Function, port?: number }} options
 * @returns {Promise<{ mcpURL: string, processingURL: string, encode: Function, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startEncodeHost({
    root, config, decide = async () => 'yes', signal, stderr = process.stderr, approvalLevel = 'all', emit = () => { }, port = 3000,
}) {
    const registry = createProcessRegistry();
    const { encodeArtifacts } = await import('./encode.ts');
    const { createEncodeHandler } = await import('./server.ts');
    const toolset = createToolset({
        root, config, names: TOOLS, approvalLevel,
        approve: (request) => decide(request),
        processTool: (name, args, callSignal) => registry.requestTool(name, args, callSignal ?? signal),
        signal, emit,
    });

    /**
     * @param {string} file
     * @param {string} content
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function writeFile(file, content) {
        const executed = await toolset.execute({
            name: 'write_file',
            arguments: JSON.stringify({ path: file, content, overwrite: true }),
        });
        if (executed.ok === false) throw new Error(executed.summary || executed.output);
    }

    /**
     * @param {object} input
     * @returns {Promise<{ written: string[] }>}
     * @ai.hint io
     */
    function encode(input) {
        return encodeArtifacts({ ...input, root, writeFile });
    }

    /**
     * @param {string} name
     * @param {object} args
     * @returns {Promise<{ output: string }>}
     * @ai.hint io
     */
    async function callTool(name, args) {
        if (name === 'encode') {
            const result = await encode(args);
            return { output: JSON.stringify(result) };
        }
        const executed = await toolset.execute({ name, arguments: JSON.stringify(args ?? {}) });
        if (executed.ok === false) throw new Error(executed.output);
        return { output: executed.output };
    }

    const handleMcp = createEncodeHandler(callTool);
    let listener;
    try {
        listener = await listenProtocol({
            port,
            onRequest(req, res) {
                const pathname = String(req.url ?? '').split('?')[0];
                if (pathname !== '/mcp') return false;
                void handleMcp(req, res);
                return true;
            },
            onConnection(conn) {
                const socket = registry.connect({
                    send(frame) { conn.send(JSON.stringify(frame)); },
                    close(code) { conn.close(code); },
                });
                conn.on('message', (text) => {
                    let frame = null;
                    try { frame = JSON.parse(text); } catch { frame = null; }
                    void registry.receive(socket, frame);
                });
                conn.on('close', () => registry.disconnect(socket));
            },
        });
    } catch (error) {
        const message = error?.code === 'EADDRINUSE' ? `порт ${port} занят` : error.message;
        throw new Error(`Не удалось открыть MCP-сервер: ${message}`);
    }
    const mcpURL = `http://127.0.0.1:${listener.port}/mcp`;
    const processingURL = listener.url;
    stderr.write(`MCP: ${mcpURL}\nProcessing: ${processingURL}\n`);
    let closed = false;
    return {
        mcpURL, processingURL, encode,
        processTool: (name, args, callSignal) => registry.requestTool(name, args, callSignal ?? signal),
        async close() {
            if (closed) return;
            closed = true;
            await listener.close();
        },
    };
}
