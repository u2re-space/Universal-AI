/**
 * @file src/mcp/session.js
 * @module mcp/session
 * @purpose Connect configured MCP servers and expose them as toolset extras.
 * @depends mcp/client, mcp/servers, util/text
 * @usedBy agent/team, commands/run, commands/mcp
 * @exports openMcpSources
 * @ai.tags mcp, tools
 * @ai.hint io
 * @changed 2026-10-15 One warning per failed server, tools for the rest.
 */
import { connectMcp } from './client.js';
import { mcpToolName } from './servers.js';
import { clipMiddle } from '../util/text.js';

/**
 * Strict wrapper schema. The model passes the server's arguments as one JSON string.
 * @param {object|undefined} inputSchema Schema advertised by the server.
 * @returns {object}
 * @ai.hint pure
 */
function argumentsSchema(inputSchema) {
    const encoded = JSON.stringify(inputSchema ?? {}).slice(0, 1200);
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            arguments_json: { type: 'string', description: `JSON object matching ${encoded}` },
        },
        required: ['arguments_json'],
    };
}

/**
 * Parse `arguments_json` into an object. An empty string is `{}`.
 * @param {object} args Tool arguments from the model.
 * @returns {object}
 * @ai.hint pure
 */
function parseArguments(args) {
    const raw = args?.arguments_json;
    if (raw == null || raw === '') return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments_json должен быть JSON-объектом.');
    return parsed;
}

/**
 * Read-only tools that cover every connected server.
 * @param {object[]} clients
 * @returns {object[]}
 * @ai.hint pure
 */
function resourceExtras(clients) {
    return [
        {
            name: 'mcp_list_resources',
            category: 'read',
            description: 'List resources exposed by the connected MCP servers. Pass null when server_id is not needed.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    server_id: { type: ['string', 'null'], description: 'Server id, or null for every connected server.' },
                },
                required: ['server_id'],
            },
            /**
             * List resources, optionally for one server.
             * @param {{ server_id?: string|null }} args
             * @returns {Promise<{ output: string, summary: string }>}
             * @ai.hint io
             */
            async handler(args) {
                const chosen = clients.filter((client) => !args.server_id || client.id === args.server_id);
                if (!chosen.length) throw new Error(`MCP-сервер не подключён: ${args.server_id}`);
                const lines = [];
                for (const client of chosen) {
                    const items = await client.listResources();
                    for (const item of items) lines.push(`${client.id}\t${item.uri ?? ''}\t${item.name ?? ''}`);
                }
                return { output: lines.join('\n') || 'Ресурсов нет.', summary: `${lines.length} ресурсов` };
            },
        },
        {
            name: 'mcp_read_resource',
            category: 'read',
            description: 'Read one MCP resource by server id and URI.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    server_id: { type: 'string', description: 'Server id from the configuration.' },
                    uri: { type: 'string', description: 'Resource URI returned by mcp_list_resources.' },
                },
                required: ['server_id', 'uri'],
            },
            /**
             * Read one URI from one server.
             * @param {{ server_id: string, uri: string }} args
             * @returns {Promise<{ output: string, summary: string }>}
             * @ai.hint io
             */
            async handler(args) {
                const client = clients.find((item) => item.id === args.server_id);
                if (!client) throw new Error(`MCP-сервер не подключён: ${args.server_id}`);
                const text = await client.readResource(args.uri);
                return { output: text, summary: args.uri };
            },
        },
    ];
}

/**
 * Connect every enabled server. A server that fails is reported and skipped.
 * @param {object} config Loaded configuration. Uses tools.mcp, mcp.servers, and limits.maxCommandOutputBytes.
 * @param {{ signal?: AbortSignal, notify?: (event: object) => void }} [options]
 * @returns {Promise<{ extras: object[], errors: object[], close: () => Promise<void>, describe: () => string }>}
 * @exports
 * @ai.hint io
 */
export async function openMcpSources(config, { signal, notify = () => {} } = {}) {
    const empty = { extras: [], errors: [], close: async () => {}, describe: () => '' };
    if (!config?.tools?.mcp) return empty;
    const servers = (config.mcp?.servers ?? []).filter((server) => server.enabled !== false && server.transport !== 'http');
    if (!servers.length) return empty;
    const maxBytes = config.limits?.maxCommandOutputBytes ?? 64 * 1024;
    const clients = [];
    const extras = [];
    const errors = [];
    for (const server of servers) {
        try {
            const client = await connectMcp({
                id: server.id, command: server.command, args: server.args, env: server.env, cwd: server.cwd, signal,
            });
            let tools;
            try {
                tools = await client.listTools();
            } catch (error) {
                await client.close();
                throw error;
            }
            clients.push(client);
            for (const tool of tools) {
                const name = mcpToolName(server.id, tool.name);
                extras.push({
                    name,
                    category: 'network',
                    description: `MCP ${server.id}/${tool.name}: ${tool.description ?? ''}`.slice(0, 1024),
                    parameters: argumentsSchema(tool.inputSchema),
                    /**
                     * Forward the parsed JSON object to the server tool.
                     * @param {object} args
                     * @returns {Promise<{ output: string, summary: string, ok: boolean }>}
                     * @ai.hint io
                     */
                    async handler(args) {
                        const result = await client.callTool(tool.name, parseArguments(args));
                        const output = clipMiddle(result.text, maxBytes);
                        return { output, summary: `${server.id}/${tool.name}`, ok: !result.isError };
                    },
                });
            }
        } catch (error) {
            errors.push({ id: server.id, message: error.message });
            notify({ type: 'warning', message: `MCP ${server.id}: ${error.message}` });
        }
    }
    if (clients.length) extras.push(...resourceExtras(clients));
    return {
        extras,
        errors,
        /**
         * Close every child that connected.
         * @returns {Promise<void>}
         * @ai.hint io
         */
        async close() {
            await Promise.all(clients.map((client) => client.close()));
        },
        /**
         * Short list for the shared context.
         * @returns {string}
         * @ai.hint pure
         */
        describe() {
            const lines = extras.map((extra) => `- ${extra.name}: ${extra.description}`);
            return lines.join('\n');
        },
    };
}
