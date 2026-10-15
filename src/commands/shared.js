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

/** Read piped stdin (returns null when stdin is a TTY or empty). */
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

/** "@file" → file contents, otherwise the literal string. */
export async function resolveTextArg(value, { cwd = process.cwd(), what = 'текст' } = {}) {
    if (typeof value !== 'string') return null;
    if (!value.startsWith('@')) return value;
    const file = path.resolve(cwd, value.slice(1));
    try { return (await readFile(file, 'utf8')).replace(/^\uFEFF/, ''); }
    catch (error) { throw new UsageError(`Не удалось прочитать ${what} из ${file}: ${error.message}`); }
}

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

export function composeInstructions(base, config, extra) {
    return [base, config.instructions, extra].filter((part) => typeof part === 'string' && part.trim()).join('\n\n');
}

export function createClientFor(config) {
    return createClient({
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY, baseURL: config.baseURL, organization: config.organization,
        project: config.project, retries: config.retries, idleTimeoutMs: config.limits.idleTimeoutMs, connectTimeoutMs: config.limits.connectTimeoutMs,
    });
}

export function createLedgerFor(config) {
    return createLedger({ prices: config.prices, budgetUsd: config.limits.budgetUsd, budgetTokens: config.limits.budgetTokens });
}

/** Open a named persistent session or create a throwaway one. */
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

export function approvalLevel(config, interactive) {
    return config.approve ?? (interactive ? 'ask' : 'read');
}

export function backupDirFor(config, tag = timestampSlug()) {
    return path.join(config.home, 'backups', tag);
}

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

export function exitCodeFor(status) {
    if (status === 'completed') return 0;
    if (status === 'cancelled') return 130;
    return 1;
}

export { resolveRole };

/** Open the long-term memory store for a working directory (null when disabled or unavailable). */
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

/** Human-readable list of models per role (for the run header). */
export function describeRoles(config, names) {
    return names.map((name) => {
        const role = resolveRole(config, name);
        return `${name}=${role.model}${role.effort ? `:${role.effort}` : ''}`;
    }).join(', ');
}

/** Usage breakdown by role (team runs) or by model. */
export function usageBreakdownRows(ledger) {
    const t = ledger.snapshot();
    const rows = [];
    const render = (items, label) => items.map((r) => `${r[label]}: ↑ ${formatNumber(r.input)} ↓ ${formatNumber(r.output)}${r.unknownCost ? '' : ` ${formatUsd(r.costUsd)}`} (${r.requests})`).join(' · ');
    const roles = (t.byRole ?? []).filter((r) => r.role);
    if (roles.length > 1) rows.push(['по ролям', render(roles, 'role')]);
    if ((t.byModel ?? []).length > 1) rows.push(['по моделям', render(t.byModel, 'model')]);
    return rows;
}

export function usageRow(ledger) {
    const t = ledger.snapshot();
    if (!t.requests) return '—';
    return `↑ ${formatNumber(t.input)}${t.cached ? ` (кеш ${formatNumber(t.cached)})` : ''} · ↓ ${formatNumber(t.output)}${t.reasoning ? ` (reasoning ${formatNumber(t.reasoning)})` : ''} · всего ${formatNumber(t.total)}` +
        `${t.costKnown ? ` · ${formatUsd(t.costUsd)}` : t.costUsd ? ` · ≥ ${formatUsd(t.costUsd)} (цены известны не для всех моделей)` : ' · стоимость неизвестна (задайте prices в конфигурации)'}` +
        `${t.budgetUsd ? ` · бюджет ${formatUsd(t.budgetUsd)}` : ''}${t.budgetTokens ? ` · лимит ${formatNumber(t.budgetTokens)} ток.` : ''}` +
        ` · ${t.requests} запрос(ов), ${formatDuration(t.elapsedMs)} в API`;
}

export function describeChanges(stats) {
    if (!stats?.changes?.length) return '';
    const marks = { create: '+', overwrite: '~', edit: '~', delete: '-' };
    const seen = new Map();
    for (const change of stats.changes) seen.set(change.path, marks[change.op] ?? '~');
    return [...seen.entries()].map(([file, mark]) => `${mark} ${file}`).join('  ');
}

/** Build a compact machine-readable result object for --json / jobs. */
export function resultObject({ result, ledger, toolset = null, outFile = null, session = null }) {
    return {
        type: 'result', status: result.status, text: result.text, refusal: result.refusal || undefined,
        turns: result.turns, toolCalls: result.toolCalls, images: result.images, outFile,
        responseId: result.response?.id ?? null, sessionId: session?.id ?? null,
        usage: ledger.snapshot(), tools: toolset?.stats() ?? null,
        error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
    };
}
