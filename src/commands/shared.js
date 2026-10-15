/**
 * @file src/commands/shared.js
 * @module commands/shared
 * @purpose Shared CLI helpers for stdin, attachments, sessions, memory, usage text, and exit codes.
 * @depends node:path, node:fs/promises, openai/client, core/usage, core/session, core/attachments, core/config, core/memory, util/text, commands/flags
 * @usedBy cli, commands/ask, commands/chat, commands/flow, commands/run, commands/image, commands/jobs, commands/memory, commands/map, commands/misc
 * @exports UsageError, overridesFrom, readStdin, resolveTextArg, loadAttachments, composeInstructions, createClientFor, createLedgerFor, openSession, approvalLevel, backupDirFor, writeOutput, STATUS_LABELS, exitCodeFor, resolveRole, openMemoryFor, describeRoles, usageBreakdownRows, usageRow, describeChanges, resultObject
 * @ai.tags cli, session, usage
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import path from 'node:path';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createClient } from '../openai/client.js';
import { createLedger } from '../core/usage.js';
import { createSession, loadSession, sessionFile } from '../core/session.js';
import { loadImageAttachment, loadFileAttachment } from '../core/attachments.js';
import { resolveRole } from '../core/config.js';
import { openMemory, projectKey as computeProjectKey } from '../core/memory.js';
import { formatBytes, formatDuration, formatNumber, formatUsd, timestampSlug } from '../util/text.js';
import { UsageError, overridesFrom } from './flags.js';

export { UsageError, overridesFrom };

/**
 * Read piped stdin (returns null when stdin is a TTY or empty).
 * @param {{ maxBytes?: number, stdin?: object }} [options] Byte cap and stream. Defaults are 4 MiB and process.stdin.
 * @returns {Promise<string|null>} Text, or null when the stream is a TTY, empty, or unreadable.
 * @exports
 * @ai.hint io
 */
export async function readStdin({ maxBytes = 4 * 1024 * 1024, stdin = process.stdin } = {}) {
    if (stdin.isTTY) return null;
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of stdin) {
            total += chunk.length;
            if (total > maxBytes) throw new UsageError(`stdin больше лимита ${formatBytes(maxBytes)}.`);
            chunks.push(chunk);
        }
    } catch (error) {
        if (error instanceof UsageError) throw error;
        return null;
    }
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    return text.trim() ? text : null;
}

/**
 * "@file" → file contents, otherwise the literal string.
 * @param {string|null|undefined} value Argument text. A leading @ reads a file under cwd.
 * @param {{ cwd?: string, what?: string }} [options] cwd resolves the path; what names the value in the error.
 * @returns {Promise<string|null>} Null when value is not a string.
 * @exports
 * @ai.hint io
 */
export async function resolveTextArg(value, { cwd = process.cwd(), what = 'текст' } = {}) {
    if (typeof value !== 'string') return null;
    if (!value.startsWith('@')) return value;
    const file = path.resolve(cwd, value.slice(1));
    try { return (await readFile(file, 'utf8')).replace(/^\uFEFF/, ''); }
    catch (error) { throw new UsageError(`Не удалось прочитать ${what} из ${file}: ${error.message}`); }
}

/**
 * Load --image and --file inputs into Responses content parts and log each one.
 * @param {{ images?: string[], files?: string[], detail?: string, cwd: string, config: object, renderer?: object }} options Refs, vision detail, and size limits from config.
 * @returns {Promise<object[]>} input_image and input_file parts.
 * @exports
 * @ai.hint io
 */
export async function loadAttachments({ images = [], files = [], detail = 'auto', cwd, config, renderer }) {
    const parts = [];
    for (const ref of images) {
        const { part, meta } = await loadImageAttachment(ref, { detail, cwd, maxBytes: config.limits.maxImageBytes });
        parts.push(part);
        renderer?.line('info', `Изображение: ${meta.source}${meta.bytes ? ` (${formatBytes(meta.bytes)}, ${meta.mime})` : ''}`, { dim: true });
    }
    for (const ref of files) {
        const { part, meta } = await loadFileAttachment(ref, { cwd, maxBytes: config.limits.maxAttachmentBytes });
        parts.push(part);
        renderer?.line('info', `Файл: ${meta.source}${meta.bytes ? ` (${formatBytes(meta.bytes)}, ${meta.kind})` : ''}`, { dim: true });
    }
    return parts;
}

/**
 * Join the command base, config instructions, and extra text with blank lines. Blank parts are dropped.
 * @param {string|null|undefined} base Built-in instruction text.
 * @param {{ instructions?: string|null }} config Resolved config.
 * @param {string|null|undefined} extra Text from --instructions or a slash command.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function composeInstructions(base, config, extra) {
    return [base, config.instructions, extra].filter((part) => typeof part === 'string' && part.trim()).join('\n\n');
}

/**
 * Build the OpenAI HTTP client from config and OPENAI_API_KEY.
 * @param {object} config Resolved config: apiKey, baseURL, organization, project, retries, and timeouts.
 * @returns {object} Client from createClient.
 * @exports
 * @ai.hint io
 */
export function createClientFor(config) {
    return createClient({
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY, baseURL: config.baseURL, organization: config.organization,
        project: config.project, retries: config.retries, idleTimeoutMs: config.limits.idleTimeoutMs, connectTimeoutMs: config.limits.connectTimeoutMs,
    });
}

/**
 * Build a usage ledger with the configured prices and budgets.
 * @param {object} config Resolved config: prices, limits.budgetUsd, and limits.budgetTokens.
 * @returns {object} Ledger from createLedger.
 * @exports
 * @ai.hint pure
 */
export function createLedgerFor(config) {
    return createLedger({ prices: config.prices, budgetUsd: config.limits.budgetUsd, budgetTokens: config.limits.budgetTokens });
}

/**
 * Open a named persistent session or create a throwaway one.
 * @param {{ config: object, name?: string|null, instructions?: string|null }} options name selects a file under the agent home; instructions seed a new session.
 * @returns {Promise<object>} session, file (null when unnamed), and resumed.
 * @exports
 * @ai.hint io
 */
export async function openSession({ config, name = null, instructions = null }) {
    if (!name) return { session: createSession({ store: config.store, model: config.model, instructions }), file: null, resumed: false };
    const file = sessionFile(config.home, name);
    const exists = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (exists) {
        const session = await loadSession(file, { store: config.store, model: config.model, instructions });
        return { session, file, resumed: true };
    }
    return { session: createSession({ store: config.store, model: config.model, name, instructions }), file, resumed: false };
}

/**
 * Approval policy for tool calls: config.approve, otherwise ask in a terminal and read otherwise.
 * @param {{ approve?: string }} config Resolved config.
 * @param {boolean} interactive True when the renderer is attached to a terminal.
 * @returns {string} ask, read, write, or all.
 * @exports
 * @ai.hint pure
 */
export function approvalLevel(config, interactive) {
    return config.approve ?? (interactive ? 'ask' : 'read');
}

/**
 * Path of a timestamped backup directory under the agent home. The directory is not created here.
 * @param {{ home: string }} config Resolved config.
 * @param {string} [tag] Directory name. Defaults to a timestamp slug.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function backupDirFor(config, tag = timestampSlug()) {
    return path.join(config.home, 'backups', tag);
}

/**
 * Write text to a file, creating parent directories. A missing trailing newline is added.
 * @param {string} file Path relative to cwd, or absolute.
 * @param {string} text Body to write.
 * @param {{ cwd?: string }} [options] Base directory for a relative file.
 * @returns {Promise<string>} Absolute path written.
 * @exports
 * @ai.hint io
 */
export async function writeOutput(file, text, { cwd = process.cwd() } = {}) {
    const target = path.resolve(cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return target;
}

export const STATUS_LABELS = {
    completed: 'завершено', incomplete: 'ответ неполный', refused: 'отказ модели', max_turns: 'лимит ходов',
    budget: 'лимит бюджета', cancelled: 'отменено', failed: 'ошибка', revise: 'требуются правки',
};

/**
 * Map a turn or team status to a process exit code.
 * @param {string} status completed, cancelled, or any other status.
 * @returns {number} 0, 130, or 1.
 * @exports
 * @ai.hint pure
 */
export function exitCodeFor(status) {
    if (status === 'completed') return 0;
    if (status === 'cancelled') return 130;
    return 1;
}

export { resolveRole };

/**
 * Open the long-term memory store for a working directory (null when disabled or unavailable).
 * @param {object} config Resolved config. memory.enabled and memory.dbFile are read.
 * @param {string} root Working directory used as the project key.
 * @param {object|null} [renderer] Receives a warning when the database cannot be opened.
 * @returns {object|null} memory, projectKey, and projectName, or null.
 * @exports
 * @ai.hint io
 */
export function openMemoryFor(config, root, renderer = null) {
    if (!config.memory.enabled) return null;
    try {
        const memory = openMemory({ file: config.memory.dbFile });
        return { memory, projectKey: computeProjectKey(root), projectName: path.basename(root) };
    } catch (error) {
        renderer?.line('warn', `Память недоступна (${error.message}); продолжаем без неё.`);
        return null;
    }
}

/**
 * Human-readable list of models per role (for the run header).
 * @param {object} config Resolved config passed to resolveRole.
 * @param {string[]} names Role names to describe.
 * @returns {string} Comma-separated role=model or role=model:effort.
 * @exports
 * @ai.hint pure
 */
export function describeRoles(config, names) {
    return names.map((name) => {
        const role = resolveRole(config, name);
        return `${name}=${role.model}${role.effort ? `:${role.effort}` : ''}`;
    }).join(', ');
}

/**
 * Usage breakdown by role (team runs) or by model.
 * @param {object} ledger Ledger with snapshot().
 * @returns {Array<[string, string]>} Summary rows. Empty when one role and one model were used.
 * @exports
 * @ai.hint pure
 */
export function usageBreakdownRows(ledger) {
    const t = ledger.snapshot();
    const rows = [];
    const render = (items, label) => items.map((r) => `${r[label]}: ↑ ${formatNumber(r.input)} ↓ ${formatNumber(r.output)}${r.unknownCost ? '' : ` ${formatUsd(r.costUsd)}`} (${r.requests})`).join(' · ');
    const roles = (t.byRole ?? []).filter((r) => r.role);
    if (roles.length > 1) rows.push(['по ролям', render(roles, 'role')]);
    if ((t.byModel ?? []).length > 1) rows.push(['по моделям', render(t.byModel, 'model')]);
    return rows;
}

/**
 * One-line token, cost, budget, and elapsed-time summary.
 * @param {object} ledger Ledger with snapshot().
 * @returns {string} An em dash when no API requests were recorded.
 * @exports
 * @ai.hint pure
 */
export function usageRow(ledger) {
    const t = ledger.snapshot();
    if (!t.requests) return '—';
    return `↑ ${formatNumber(t.input)}${t.cached ? ` (кеш ${formatNumber(t.cached)})` : ''} · ↓ ${formatNumber(t.output)}${t.reasoning ? ` (reasoning ${formatNumber(t.reasoning)})` : ''} · всего ${formatNumber(t.total)}` +
        `${t.costKnown ? ` · ${formatUsd(t.costUsd)}` : t.costUsd ? ` · ≥ ${formatUsd(t.costUsd)} (цены известны не для всех моделей)` : ' · стоимость неизвестна (задайте prices в конфигурации)'}` +
        `${t.budgetUsd ? ` · бюджет ${formatUsd(t.budgetUsd)}` : ''}${t.budgetTokens ? ` · лимит ${formatNumber(t.budgetTokens)} ток.` : ''}` +
        ` · ${t.requests} запрос(ов), ${formatDuration(t.elapsedMs)} в API`;
}

/**
 * Compact file-change list. Each path is kept once: + create, ~ edit or overwrite, - delete.
 * @param {object|null|undefined} stats Toolset stats with a changes array.
 * @returns {string} Empty when there are no changes.
 * @exports
 * @ai.hint pure
 */
export function describeChanges(stats) {
    if (!stats?.changes?.length) return '';
    const marks = { create: '+', overwrite: '~', edit: '~', delete: '-' };
    const seen = new Map();
    for (const change of stats.changes) seen.set(change.path, marks[change.op] ?? '~');
    return [...seen.entries()].map(([file, mark]) => `${mark} ${file}`).join('  ');
}

/**
 * Build a compact machine-readable result object for --json / jobs.
 * @param {{ result: object, ledger: object, toolset?: object|null, outFile?: string|null, session?: object|null }} options Turn result and accounting.
 * @returns {object} JSON event with type "result".
 * @exports
 * @ai.hint pure
 */
export function resultObject({ result, ledger, toolset = null, outFile = null, session = null }) {
    return {
        type: 'result', status: result.status, text: result.text, refusal: result.refusal || undefined,
        turns: result.turns, toolCalls: result.toolCalls, images: result.images,
        ...(result.sources?.length ? { sources: result.sources } : {}), outFile,
        responseId: result.response?.id ?? null, sessionId: session?.id ?? null,
        usage: ledger.snapshot(), tools: toolset?.stats() ?? null,
        error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
    };
}
