import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const TOOLS = ['list_files', 'read_file', 'search_files', 'write_file', 'replace_text', 'delete_file', 'run_command', 'run_script'] as const;

const loose = z.object({}).passthrough();

/**
 * Node HTTP handler for POST/GET /mcp. Host and Origin must be localhost.
 * @param {(name: string, args: Record<string, unknown>) => Promise<{ output: string }>} callTool
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createEncodeHandler(callTool: (name: string, args: Record<string, unknown>) => Promise<{ output: string }>) {
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'universal-ai-encode', version: '1.0.0' });
        for (const name of TOOLS) {
            server.registerTool(name, { description: name, inputSchema: loose }, async (args) => {
                try {
                    const result = await callTool(name, args as Record<string, unknown>);
                    return { content: [{ type: 'text' as const, text: result.output }] };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { isError: true, content: [{ type: 'text' as const, text: message }] };
                }
            });
        }
        server.registerTool('encode', {
            description: 'Write answer artifacts to hint paths.',
            inputSchema: z.object({
                text: z.string(),
                workspace: z.string(),
                directoryTree: z.string(),
                artifacts: z.array(z.object({
                    id: z.string(),
                    body: z.string(),
                    hintLanguage: z.string().nullable(),
                    hintPath: z.string().nullable(),
                })),
            }),
        }, async (args) => {
            try {
                const result = await callTool('encode', args as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text: result.output }] };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { isError: true, content: [{ type: 'text' as const, text: message }] };
            }
        });
        return server;
    }, { responseMode: 'json' });
    const nodeHandler = toNodeHandler(handler);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        if (!validateHost(req, res) || !validateOrigin(req, res)) return;
        await nodeHandler(req, res);
    };
}
