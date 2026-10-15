/**
 * @file src/mcp/servers.js
 * @module mcp/servers
 * @purpose Validate one user MCP server and build the function name exposed to the model.
 * @depends node:crypto
 * @usedBy mcp/session, core/config, commands/mcp
 * @exports normalizeMcpServer, mcpToolName
 * @ai.tags mcp, config
 * @ai.hint pure
 * @changed 2026-10-15 Stdio server entries and mcp_ tool names.
 */
import { createHash } from 'node:crypto';

/**
 * Copy a server entry into the shape the client expects, or throw.
 * @param {object} entry
 * @returns {{ id: string, transport: 'stdio', command: string, args: string[], env: object, cwd: string|null, enabled: boolean }}
 * @exports
 * @ai.hint pure
 */
export function normalizeMcpServer(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Конфигурация: mcp.servers[] должен содержать объекты');
    for (const key of Object.keys(entry)) {
        if (!['id', 'transport', 'command', 'args', 'env', 'cwd', 'enabled'].includes(key)) {
            throw new Error(`Конфигурация: неизвестное поле mcp.servers.${key}`);
        }
    }
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id)) {
        throw new Error('Конфигурация: mcp.servers.id — строчные латинские буквы, цифры и дефис, до 32 символов');
    }
    const transport = entry.transport ?? 'stdio';
    if (transport !== 'stdio') throw new Error('Конфигурация: mcp.servers.transport: stdio');
    if (typeof entry.command !== 'string' || !entry.command.trim()) throw new Error('Конфигурация: mcp.servers.command — непустая строка');
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Конфигурация: mcp.servers.args — массив строк');
    const env = entry.env ?? {};
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
        throw new Error('Конфигурация: mcp.servers.env — объект со строковыми значениями');
    }
    if (entry.cwd != null && (typeof entry.cwd !== 'string' || !entry.cwd.trim())) throw new Error('Конфигурация: mcp.servers.cwd — путь или null');
    if (entry.enabled != null && typeof entry.enabled !== 'boolean') throw new Error('Конфигурация: mcp.servers.enabled: true | false');
    return {
        id: entry.id,
        transport,
        command: entry.command,
        args: [...args],
        env: { ...env },
        cwd: entry.cwd ?? null,
        enabled: entry.enabled !== false,
    };
}

/**
 * Function name for one MCP tool. Stable and at most 64 characters.
 * @param {string} serverId
 * @param {string} toolName
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function mcpToolName(serverId, toolName) {
    const raw = `mcp_${serverId}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
    if (raw.length <= 64) return raw;
    return `${raw.slice(0, 48)}_${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}
