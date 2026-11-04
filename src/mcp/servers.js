/**
 * @file src/mcp/servers.js
 * @module mcp/servers
 * @purpose Validate one user MCP server and build the function name exposed to the model.
 * @depends node:crypto
 * @usedBy mcp/session, core/config, commands/mcp
 * @exports normalizeMcpServer, mcpToolName, remoteMcpTools
 * @ai.tags mcp, config
 * @ai.hint pure
 * @changed 2026-11-04 headers of a URL server are checked as header names and stringified scalars.
 */
import { createHash } from 'node:crypto';

/** Header name as RFC 7230 defines a token: a space or a colon means a typo, not a header. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Header values for a remote server. Scalars become strings, a `null` value drops the entry, and a
 * value stays on one line so it cannot smuggle a second header into the upstream request.
 * @param {unknown} headers
 * @param {string} id Server id, for the message.
 * @returns {object|null} null when nothing is left to send.
 * @ai.hint pure
 */
function normalizeServerHeaders(headers, id) {
    if (headers == null) return null;
    if (typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error(`Конфигурация: mcp.servers.${id}.headers — объект со строковыми значениями`);
    }
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name === '__proto__' || !HEADER_NAME.test(name)) {
            throw new Error(`Конфигурация: mcp.servers.${id}.headers.${name} — некорректное имя заголовка`);
        }
        if (value == null) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            throw new Error(`Конфигурация: mcp.servers.${id}.headers.${name} — строка, число или флаг`);
        }
        const text = String(value);
        if (/[\r\n]/.test(text)) {
            throw new Error(`Конфигурация: mcp.servers.${id}.headers.${name} — строка без перевода строки`);
        }
        out[name] = text;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Copy a server entry into the shape the client expects, or throw.
 * @param {object} entry
 * @returns {object} A stdio server or a remote HTTPS server.
 * @exports
 * @ai.hint pure
 */
export function normalizeMcpServer(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Конфигурация: mcp.servers[] должен содержать объекты');
    for (const key of Object.keys(entry)) {
        if (!['id', 'transport', 'command', 'args', 'env', 'cwd', 'enabled', 'server_url', 'server_description', 'require_approval', 'allowed_tools', 'authorization', 'headers'].includes(key)) {
            throw new Error(`Конфигурация: неизвестное поле mcp.servers.${key}`);
        }
    }
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9_-]{0,40}$/.test(entry.id)) {
        throw new Error('Конфигурация: mcp.servers.id — строчные латинские буквы, цифры, дефис и подчёркивание, до 41 символа');
    }
    const remote = entry.transport === 'http' || typeof entry.server_url === 'string';
    if (remote && entry.command) throw new Error('Конфигурация: mcp.servers — либо command, либо server_url');
    if (remote) return normalizeRemoteServer(entry);
    const transport = entry.transport ?? 'stdio';
    if (transport !== 'stdio') throw new Error('Конфигурация: mcp.servers.transport: stdio | http');
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
 * Remote server OpenAI calls itself. `require_approval` defaults to never so a public server does not pause the turn.
 * @param {object} entry
 * @returns {object}
 * @ai.hint pure
 */
function normalizeRemoteServer(entry) {
    let url;
    try { url = new URL(entry.server_url); }
    catch { throw new Error('Конфигурация: mcp.servers.server_url должен быть URL'); }
    if (url.protocol !== 'https:') throw new Error('Конфигурация: mcp.servers.server_url — только https');
    const serverUrl = entry.server_url.trim();
    const approval = entry.require_approval ?? 'never';
    if (approval !== 'always' && approval !== 'never') throw new Error('Конфигурация: mcp.servers.require_approval: always | never');
    const description = entry.server_description ?? '';
    if (typeof description !== 'string') throw new Error('Конфигурация: mcp.servers.server_description — строка');
    const allowed = entry.allowed_tools ?? null;
    if (allowed != null && (!Array.isArray(allowed) || allowed.some((name) => typeof name !== 'string' || !name.trim()))) {
        throw new Error('Конфигурация: mcp.servers.allowed_tools — массив имён инструментов');
    }
    const authorization = entry.authorization ?? null;
    if (authorization != null && (typeof authorization !== 'string' || !authorization.trim() || /[\r\n]/.test(authorization))) {
        throw new Error('Конфигурация: mcp.servers.authorization — строка без перевода строки');
    }
    const headers = normalizeServerHeaders(entry.headers, entry.id);
    if (entry.enabled != null && typeof entry.enabled !== 'boolean') throw new Error('Конфигурация: mcp.servers.enabled: true | false');
    return {
        id: entry.id,
        transport: 'http',
        server_url: serverUrl,
        server_description: description,
        require_approval: approval,
        allowed_tools: allowed ? [...allowed] : null,
        authorization,
        headers,
        enabled: entry.enabled !== false,
    };
}

/**
 * Responses API tool objects for remote servers. Stdio entries are omitted.
 * @param {object[]|null|undefined} servers
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function remoteMcpTools(servers) {
    const tools = [];
    for (const server of servers ?? []) {
        if (!server || server.transport !== 'http' || server.enabled === false) continue;
        const tool = {
            type: 'mcp',
            server_label: server.id,
            server_url: server.server_url,
            require_approval: server.require_approval ?? 'never',
        };
        if (server.server_description) tool.server_description = server.server_description;
        if (server.allowed_tools?.length) tool.allowed_tools = [...server.allowed_tools];
        if (server.authorization) tool.authorization = server.authorization;
        if (server.headers && Object.keys(server.headers).length) tool.headers = { ...server.headers };
        tools.push(tool);
    }
    return tools;
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
