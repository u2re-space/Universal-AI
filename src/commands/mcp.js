/**
 * @file src/commands/mcp.js
 * @module commands/mcp
 * @purpose `ai mcp` — list, add, remove, and probe user MCP servers, stdio and by URL.
 * @depends node:path, node:fs/promises, commands/shared, mcp/servers, mcp/session
 * @usedBy cli
 * @exports mcpCommand, parseHeaderArgs
 * @ai.tags cli, mcp
 * @ai.hint io
 * @changed 2026-11-04 --mcp-header stores headers of a URL server; list shows their names.
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { UsageError } from './shared.js';
import { normalizeMcpServer } from '../mcp/servers.js';
import { openMcpSources } from '../mcp/session.js';

/**
 * Read `~/.ai-agent/config.json`, or an empty object when the file is missing.
 * @param {string} home
 * @returns {Promise<{ file: string, raw: object }>}
 * @ai.hint io
 */
async function loadHomeFile(home) {
    const file = path.join(home, 'config.json');
    let text = null;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw new UsageError(`Не удалось прочитать ${file}: ${error.message}`);
    }
    if (text == null) return { file, raw: {} };
    try {
        const raw = JSON.parse(text);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('корень должен быть объектом');
        return { file, raw };
    } catch (error) {
        throw new UsageError(`Некорректный JSON в ${file}: ${error.message}`);
    }
}

/**
 * Write the home config back. Other keys are kept.
 * @param {string} file
 * @param {object} raw
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function saveHomeFile(file, raw) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

/**
 * `--mcp-header Name=value` and `--mcp-header "Name: value"` into one header map.
 * A repeated flag adds a header; the same name twice keeps the last value.
 * @param {string[]|undefined} items Raw values of the flag.
 * @returns {object|null} null when the flag was not used.
 * @exports
 * @ai.hint pure
 */
export function parseHeaderArgs(items) {
    const list = Array.isArray(items) ? items : (items == null ? [] : [items]);
    if (!list.length) return null;
    const out = {};
    for (const item of list) {
        const text = String(item ?? '');
        const split = text.indexOf('=');
        const colon = text.indexOf(':');
        const at = split === -1 ? colon : (colon === -1 ? split : Math.min(split, colon));
        if (at <= 0) throw new UsageError(`--mcp-header: ожидается "Имя=значение", получено "${text}"`);
        const name = text.slice(0, at).trim();
        const value = text.slice(at + 1).trim();
        if (!name) throw new UsageError(`--mcp-header: пустое имя заголовка в "${text}"`);
        out[name] = value;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Servers stored in the home file, still un-normalized until add/remove.
 * @param {object} raw
 * @returns {object[]}
 * @ai.hint pure
 */
function homeServers(raw) {
    const servers = raw.mcp?.servers ?? [];
    if (!Array.isArray(servers)) throw new UsageError('mcp.servers в конфигурации должен быть массивом');
    return servers;
}

/**
 * `ai mcp list|add|remove|probe`. Does not require an API key.
 * add and remove edit the home config only. list and probe use the merged config.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function mcpCommand(ctx) {
    const { config, renderer, positionals, values } = ctx;
    const sub = positionals[0] ?? 'list';
    if (sub === 'list') {
        const servers = config.mcp.servers;
        if (!servers.length) {
            renderer.write('MCP-серверы не заданы.\nЛокальный: ai mcp add <id> --mcp-command <команда>\nСторонний: ai mcp add <id> --mcp-url https://…\n');
            return 0;
        }
        for (const server of servers) {
            const state = server.enabled ? 'включён' : 'выключен';
            const where = server.transport === 'http' ? server.server_url : `${server.command} ${(server.args ?? []).join(' ')}`;
            const names = server.transport === 'http' ? Object.keys(server.headers ?? {}) : [];
            renderer.write(`${server.id}\t${state}\t${where}${names.length ? `\tзаголовки: ${names.join(', ')}` : ''}\n`);
        }
        return 0;
    }
    if (sub === 'add') {
        const id = positionals[1];
        if (!id) throw new UsageError('Укажите id: ai mcp add <id> --mcp-command <команда> или --mcp-url <https://…>');
        if (!values['mcp-command'] && !values['mcp-url']) throw new UsageError('Укажите --mcp-command или --mcp-url.');
        const headers = parseHeaderArgs(values['mcp-header']);
        if (headers && !values['mcp-url']) throw new UsageError('--mcp-header относится к серверу с --mcp-url: локальному серверу заголовки не нужны.');
        const entry = values['mcp-url']
            ? normalizeMcpServer({
                id, server_url: values['mcp-url'], server_description: values['mcp-description'] ?? '',
                require_approval: values['mcp-approval'] ?? 'never', ...(headers ? { headers } : {}),
            })
            : normalizeMcpServer({ id, command: values['mcp-command'], args: values['mcp-arg'] ?? [] });
        const stored = entry.transport === 'http'
            ? {
                id: entry.id, server_url: entry.server_url, server_description: entry.server_description,
                require_approval: entry.require_approval, ...(entry.headers ? { headers: entry.headers } : {}),
            }
            : { id: entry.id, transport: entry.transport, command: entry.command, args: entry.args };
        const { file, raw } = await loadHomeFile(config.home);
        const servers = homeServers(raw);
        if (servers.some((server) => server.id === id)) throw new UsageError(`MCP-сервер уже есть: ${id}`);
        raw.mcp = { ...(raw.mcp ?? {}), servers: [...servers, stored] };
        await saveHomeFile(file, raw);
        const detail = entry.transport === 'http' ? entry.server_url : `stdio: ${entry.command} ${entry.args.join(' ')}`;
        const sent = entry.headers ? `, заголовки: ${Object.keys(entry.headers).join(', ')}` : '';
        renderer.write(`Добавлен MCP-сервер ${id} (${detail}${sent})\n`);
        return 0;
    }
    if (sub === 'remove') {
        const id = positionals[1];
        if (!id) throw new UsageError('Укажите id: ai mcp remove <id>');
        const { file, raw } = await loadHomeFile(config.home);
        const servers = homeServers(raw);
        if (!servers.some((server) => server.id === id)) throw new UsageError(`MCP-сервер не найден в ${file}: ${id}`);
        raw.mcp = { ...(raw.mcp ?? {}), servers: servers.filter((server) => server.id !== id) };
        await saveHomeFile(file, raw);
        renderer.write(`Удалён MCP-сервер ${id}\n`);
        return 0;
    }
    if (sub === 'probe') {
        const id = positionals[1];
        if (!id) throw new UsageError('Укажите id: ai mcp probe <id>');
        const server = config.mcp.servers.find((item) => item.id === id);
        if (!server) throw new UsageError(`MCP-сервер не найден: ${id}`);
        if (server.transport === 'http') throw new UsageError('Сторонний сервер вызывает Responses API. probe смотрит только локальный stdio.');
        const session = await openMcpSources({
            tools: { mcp: true },
            mcp: { servers: [server] },
            limits: config.limits,
        }, { signal: ctx.signal });
        try {
            if (session.errors.length) {
                renderer.line('fail', session.errors.map((error) => `${error.id}: ${error.message}`).join('\n'));
                return 1;
            }
            const tools = session.extras.filter((extra) => extra.category === 'network');
            renderer.write(`${id}: инструментов ${tools.length}\n`);
            for (const tool of tools) renderer.write(`tool ${tool.name}\n`);
            const list = session.extras.find((extra) => extra.name === 'mcp_list_resources');
            if (list) {
                const listed = await list.handler({ server_id: id });
                renderer.write(listed.output.endsWith('\n') ? listed.output : `${listed.output}\n`);
            }
            return 0;
        } finally {
            await session.close();
        }
    }
    throw new UsageError('Доступно: ai mcp list | add | remove | probe');
}
