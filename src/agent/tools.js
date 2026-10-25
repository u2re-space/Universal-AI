/**
 * @file src/agent/tools.js
 * @module agent/tools
 * @purpose Build the local toolset: approval, handlers, and the re-exports from tool-specs.
 * @depends node:path, node:crypto, node:fs/promises, openai/errors, core/attachments, util/text, agent/paths, agent/fs-tools, agent/map, agent/shell, agent/desktop, agent/tool-specs, channels/tool-handlers, generate/scaffold
 * @usedBy commands/ask, commands/chat, commands/run, agent/team, index.js
 * @exports TOOL_SPECS, READ_ONLY_TOOLS, toolDefinitions, enabledToolNames, describeTool, toolCategory, createToolset, relativeToRoot
 * @ai.tags tools, approval
 * @ai.hint hot
 * @changed 2026-10-21 A noisy path is searched directly, and a timeout explains dev servers.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { CancelledError } from '../openai/errors.js';
import { createClient } from '../openai/client.js';
import { detectImageMime } from '../core/attachments.js';
import { errorMessage, formatBytes, truncate, clipMiddle } from '../util/text.js';
import { resolveInside, NOISY_DIRS } from './paths.js';
import { listProjectBackups, restoreProjectBackup } from './project-backup.js';
import { listFiles, readTextFile, searchFiles, writeTextFile, replaceInFile, deleteFile, makeDirectory } from './fs-tools.js';
import { loadProjectMap, searchMapped, updateProjectMapPath } from './map.js';
import { SHELLS, runCommand, runProgram, scriptLaunch, sshPlan } from './shell.js';
import { guardScaffold, isScaffoldCommand } from '../generate/scaffold.js';
import { structureCode } from '../structure/structure.js';
import { DESKTOP_TOOL_NAMES, createDesktopHandlers } from './desktop.js';
import { createImageHandlers } from './image-tools.js';
import { createChannelHandlers } from '../channels/tool-handlers.js';
import { detectMagick, magickSplit, magickCrop, magickTrimImage, magickIdentify } from './image-magick.js';
import { generateSvg, downloadFont, downloadIcons } from './assets.js';
import {
    TOOL_SPECS,
    READ_ONLY_TOOLS,
    toolDefinitions,
    enabledToolNames,
    describeTool,
    toolCategory,
} from './tool-specs.js';
export { TOOL_SPECS, READ_ONLY_TOOLS, toolDefinitions, enabledToolNames, describeTool, toolCategory };


/**
 * Why `crop_image(trim=true)` left the file alone, in the wording the model reads back.
 * @ai.hint pure
 */
const TRIM_REFUSED = {
    'no-padding': 'ни прозрачного, ни равномерного padding по краям нет',
    'too-small': 'trim снял бы больше 90 % кадра',
    'unreadable': 'размеры изображения не читаются',
    'failed': 'ImageMagick отклонил trim',
};

/**
 * Drop scripts, styles, and tags so fetched HTML becomes readable text.
 * `fetch_url` calls this when the response is HTML.
 * @param {string} html
 * @returns {string}
 * @ai.hint pure
 */
function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/**
 * Short click description for the approval card.
 * `preview` calls this for the `click` tool.
 * @param {object} args
 * @returns {string}
 * @ai.hint pure
 */
function clickTarget(args) {
    if (!args || typeof args !== 'object') return '';
    if (args.mode === 'coord') return `${args.x},${args.y}`;
    if (args.mode === 'title') return String(args.title ?? '');
    if (args.mode === 'control') return [args.title, args.control].filter((part) => typeof part === 'string' && part.trim()).join(' / ');
    if (args.mode === 'image') return String(args.image ?? '');
    return String(args.mode ?? '');
}

/**
 * First non-empty batch field among path, batch_json, and batch_toon.
 * `preview` calls this for `run_batch`.
 * @param {object} args
 * @returns {string}
 * @ai.hint pure
 */
function batchSource(args) {
    if (!args || typeof args !== 'object') return '';
    for (const key of ['path', 'batch_json', 'batch_toon']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
}

/**
 * Named shell, or the fallback when the model left the field empty.
 * @param {string|null|undefined} value
 * @param {string|null} fallback
 * @returns {string|null}
 * @ai.hint pure
 */
function chosenShell(value, fallback) {
    if (value == null || value === '') return fallback ?? null;
    if (!SHELLS.includes(value)) throw new Error(`shell: ${SHELLS.join(' | ')}`);
    return value;
}

/**
 * Command timeout in milliseconds, capped at 900 seconds.
 * @param {{ timeout_seconds?: number|null }} args
 * @param {{ commandTimeoutMs: number }} limits
 * @returns {number}
 * @ai.hint pure
 */
function commandTimeout(args, limits) {
    return Math.min(900, Math.max(1, args.timeout_seconds ?? Math.round(limits.commandTimeoutMs / 1000))) * 1000;
}

/**
 * Status block shared by run_command, run_script, and ssh.
 * @param {object} result Result from runCommand or runProgram.
 * @param {number} timeoutMs
 * @param {{ maxCommandOutputBytes: number }} limits
 * @returns {{ output: string, summary: string, ok: boolean }}
 * @ai.hint pure
 */
function commandReport(result, timeoutMs, limits) {
    const status = result.cancelled ? 'отменена' : result.timedOut ? `таймаут ${timeoutMs / 1000} с` : result.error ? `ошибка запуска: ${result.error}` : `exit code ${result.exitCode}`;
    const body = [`status: ${status}`, `duration_ms: ${result.durationMs}`];
    if (result.stdout) body.push(`--- stdout ---\n${clipMiddle(result.stdout, limits.maxCommandOutputBytes)}`);
    if (result.stderr) body.push(`--- stderr ---\n${clipMiddle(result.stderr, limits.maxCommandOutputBytes)}`);
    if (result.timedOut) body.push('(команда не завершилась; dev- и preview-серверы не выходят сами — проверяйте npm run build и собранные файлы)');
    if (result.truncated) body.push('(вывод усечён)');
    return { output: body.join('\n'), summary: status, ok: result.exitCode === 0 };
}

const PROCESSABLE = new Set(['delete_file', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file']);
const WRITE_CHANGES = new Set(['write_file', 'replace_text', 'delete_file']);
const CHANGE_OPS = new Set(['create', 'overwrite', 'edit', 'delete']);

/**
 * Create the executable toolset for one agent run.
 *
 * approvalLevel: 'ask' | 'read' | 'write' | 'all'.
 * approve({ name, category, args, preview }) → 'yes' | 'no' | 'always' | 'abort' (used for 'ask').
 * askUser(question) → string | null (optional; enables the ask_user tool).
 * memory / projectKey / projectName — long-term memory store (enables recall / remember).
 * describeImage({ part, question }) → string — vision role delegation for view_image (optional).
 * summarizeFile({ rel, text, focus }) → string — summarizer role for summarize_file (optional).
 * describeScreen({ part, rel }) → string | { toon } — screen vision for a desktop capture (optional).
 * performDesktop(action) → { message, screenshotAbs, screenshotRel } — injected runner; skips AutoHotkey (optional).
 * delegate(role, task) → { output, summary, data? } — specialist call for delegate_role (optional).
 * subagent(kind, task) → { output, summary, ok, stats? } — nested agent run for run_subagent (optional).
 * extras — additional tools `{ name, description, parameters, category, handler }`, used for MCP.
 * processTool(name, args, signal) → null | { output, summary, changes? } — remote handler for a processable tool. null runs the local handler.
 */
export function createToolset({
    root = process.cwd(), config, names, approvalLevel = 'read', approve = async () => 'no', askUser = null,
    backupDir = null, signal, emit = () => {}, memory = null, projectKey = null, projectName = null,
    describeImage = null, summarizeFile = null, editPaths = () => null,
    describeScreen = null, performDesktop = null, delegate = null, subagent = null, extras = [], client = null, ledger = null,
    scaffoldTask = '', processTool = null,
}) {
    const limits = config.limits;
    const allowed = new Set(names);
    const extraByName = new Map();
    for (const extra of extras) {
        if (!extra?.name || TOOL_SPECS[extra.name] || extraByName.has(extra.name)) throw new Error(`Имя инструмента занято: ${extra.name}`);
        extraByName.set(extra.name, extra);
        allowed.add(extra.name);
    }
    if (!memory) { allowed.delete('recall'); allowed.delete('remember'); }
    if (!summarizeFile) allowed.delete('summarize_file');
    if (!subagent) allowed.delete('run_subagent');
    const alwaysAllowed = new Set();
    const stats = { calls: 0, byTool: {}, changes: [], commands: [], denied: 0, errors: 0, memories: [] };
    let backupSlot = 'write';
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };

    /** Record host changes for a write tool and refresh the map. */
    async function applyRemoteChanges(changes) {
        const list = Array.isArray(changes) ? changes : [];
        if (list.length > 100) notify({ type: 'warning', message: 'changes содержит больше 100 записей.' });
        for (const change of list.slice(0, 100)) {
            if (!change || typeof change.path !== 'string' || !CHANGE_OPS.has(change.op)) {
                notify({ type: 'warning', message: 'Некорректная запись changes.' });
                continue;
            }
            try {
                const { rel } = await resolveInside(root, change.path, { forWrite: true, allowRoot: false });
                if (rel === '.backup' || rel.startsWith('.backup/')) throw new Error(`Запись в .backup запрещена: ${rel}`);
                stats.changes.push({ op: change.op, path: rel });
                try { await updateProjectMapPath(root, rel); }
                catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
            } catch (error) {
                notify({ type: 'warning', message: error.message });
            }
        }
    }

    /** Fold the tool stats of a nested agent run into this run's stats. */
    function adoptStats(child) {
        if (!child || typeof child !== 'object') return;
        stats.calls += child.calls ?? 0;
        stats.denied += child.denied ?? 0;
        stats.errors += child.errors ?? 0;
        for (const [name, count] of Object.entries(child.byTool ?? {})) stats.byTool[name] = (stats.byTool[name] ?? 0) + count;
        stats.changes.push(...(child.changes ?? []));
        stats.commands.push(...(child.commands ?? []));
        stats.memories.push(...(child.memories ?? []));
    }

    /** Apply the approval level, and throw when the operator aborts. */
    async function decide(name, category, args, preview) {
        if (category === 'read' || category === 'user' || category === 'memory') return true;
        if (approvalLevel === 'all') return true;
        if (approvalLevel === 'write' && category === 'write') return true;
        if (approvalLevel !== 'ask') return false;
        if (alwaysAllowed.has(name)) return true;
        notify({ type: 'approval.request', name, category, preview });
        const answer = await approve({ name, category, args, preview });
        notify({ type: 'approval.result', name, answer });
        if (answer === 'abort') throw new CancelledError('Остановлено пользователем при запросе подтверждения.');
        if (answer === 'always') { alwaysAllowed.add(name); return true; }
        return answer === 'yes';
    }

    /** Build the approval card for a write, shell, or desktop call. */
    function preview(name, args) {
        switch (name) {
            case 'write_file': {
                const bytes = Buffer.byteLength(args.content ?? '');
                const head = String(args.content ?? '').split('\n').slice(0, 12).join('\n');
                return `${args.overwrite ? 'Записать' : 'Создать'} ${args.path} (${formatBytes(bytes)})\n${head}${bytes > Buffer.byteLength(head) ? '\n…' : ''}`;
            }
            case 'replace_text':
                return `Изменить ${args.path}${args.all ? ' (все вхождения)' : ''}\n--- было ---\n${truncate(args.search, 400, { singleLine: false })}\n--- станет ---\n${truncate(args.replacement, 400, { singleLine: false })}`;
            case 'delete_file': return `Удалить файл ${args.path} (копия сохранится в резервном каталоге)`;
            case 'list_backups': return `Снимки ${args.path || 'проекта'}`;
            case 'restore_backup': return `Вернуть снимок ${args.id}${args.path ? ` в ${args.path}` : ''}`;
            case 'make_dir': return `Создать каталог ${args.path}`;
            case 'structure_file': return `Структура ${args.path}: ${args.tasks || 'по умолчанию'}${args.prompt ? `\nПромпт: ${truncate(args.prompt, 200)}` : ''}\nПричина: ${args.reason ?? '—'}`;
            case 'run_command': return `Команда (${args.shell || 'по умолчанию'}): ${args.command}\nКаталог: ${args.cwd ?? '.'}\nПричина: ${args.reason ?? '—'}`;
            case 'run_script': return `Скрипт (${args.shell || 'по расширению'}): ${args.path}\nАргументы: ${(args.args ?? []).join(' ') || '—'}\nПричина: ${args.reason ?? '—'}`;
            case 'ssh': return `SSH ${args.mode} ${args.host}${args.command ? `: ${args.command}` : ''}${args.local_path ? `\nФайл: ${args.local_path}` : ''}${args.remote_path ? `\nУдалённый путь: ${args.remote_path}` : ''}\nПричина: ${args.reason ?? '—'}`;
            case 'fetch_url': return `Загрузить ${args.url}`;
            case 'decide': return `Решение ${args.preset || 'свои вопросы'}: ${truncate(args.state_json ?? '', 300)}`;
            case 'moderate_text': return `Модерация (${args.preset}): ${truncate(args.text ?? '', 300)}`;
            case 'channel_reply': return `Черновик ${args.purpose}: ${truncate(args.text ?? '', 300)}`;
            case 'telegram_call': return `Telegram ${args.method}`;
            case 'generate_image': return `Нарисовать: ${truncate(args.prompt ?? '', 400)}\nФайл: ${args.path || 'авто'}${args.reference ? `\nРеференс: ${args.reference}` : ''}${args.background ? `\nФон: ${args.background}` : ''}${args.to_svg ? '\nЗатем: SVG' : ''}`;
            case 'edit_image': return `Изменить ${args.image}: ${truncate(args.prompt ?? '', 400)}\nФайл: ${args.path || 'авто'}${args.extra_images ? `\nДоп. референсы: ${args.extra_images}` : ''}${args.background ? `\nФон: ${args.background}` : ''}${args.to_svg ? '\nЗатем: SVG' : ''}`;
            case 'click': return `Клик: ${truncate(clickTarget(args), 400)}`;
            case 'type': return `Ввод: ${truncate(args.text ?? '', 400)}`;
            case 'run_ahk': return `Скрипт: ${truncate(args.script ?? '', 400)}`;
            case 'run_batch': return `Пакет: ${truncate(batchSource(args), 400)}`;
            case 'split_image': return `Разбить ${args.path} на ${args.rows ?? 1}×${args.cols ?? 1} плиток\nВыход: ${args.output || 'авто'}\nПричина: ${args.reason ?? '—'}`;
            case 'crop_image': return `${args.trim ? `Снять padding ${args.path}` : `Обрезать ${args.path}: ${args.width ?? '?'}×${args.height ?? '?'} в (${args.x ?? 0},${args.y ?? 0}) `}\nВыход: ${args.output || 'авто'}\nПричина: ${args.reason ?? '—'}`;
            case 'generate_svg': return `SVG ${args.width ?? 512}×${args.height ?? 512}: ${truncate(args.prompt ?? '', 400)}\nФайл: ${args.path || 'авто'}\nПричина: ${args.reason ?? '—'}`;
            case 'vectorize_image': return `Векторизовать ${args.image || 'кроп из замеров'} в SVG`;
            case 'run_subagent': return `Суб-агент ${args.kind}: ${truncate(args.task ?? '', 400)}`;
            case 'download_font': return `Шрифт: ${args.name || args.url || '?'} ${args.style || ''}\nВыход: ${args.output || 'авто'}`;
            case 'download_icons': return `Иконки: ${args.name || '?'}${args.icon ? `/${args.icon}` : ' (набор)'} ${args.variant || 'regular'}\nВыход: ${args.output || 'авто'}`;
            default:
                if (name.startsWith('mcp_')) return `${name} ${truncate(args.arguments_json ?? args.uri ?? '', 400, { singleLine: false })}`;
                return `${name} ${JSON.stringify(args)}`;
        }
    }

    /** Prefix the tool output when `rel` is outside the worker edit set. */
    function labelOutsideEdit(rel, output) {
        const allowed = typeof editPaths === 'function' ? editPaths() : editPaths;
        if (allowed && !allowed.has(rel)) return `Не в карте правок (${rel}): ${output}`;
        return output;
    }

    const handlers = {
        /** List a directory and return the entry count. */
        async list_files(args) {
            const result = await listFiles({ root, dir: args.path || '.', depth: Math.min(6, Math.max(1, args.depth ?? 2)),
                includeHidden: Boolean(args.include_hidden), maxEntries: limits.maxListEntries });
            const summary = result.missing ? `${result.missing} не найден; записей рядом: ${result.count}` : `${result.count} записей`;
            return { output: result.text, summary };
        },
        /** Read numbered lines from a UTF-8 file. */
        async read_file(args) {
            const result = await readTextFile({ root, file: args.path, startLine: args.start_line, endLine: args.end_line, maxBytes: limits.maxFileReadBytes });
            return { output: result.text, summary: `${args.path}: строки ${result.from}-${result.to}/${result.totalLines}` };
        },
        /** Search the project map, or walk the tree when the map is missing or does not cover the path. */
        async search_files(args) {
            const scope = args.scope ?? 'all';
            if (!['path', 'symbol', 'content', 'all'].includes(scope)) throw new Error('scope: path, symbol, content или all.');
            const requested = String(args.path || '.').split(path.sep).join('/');
            const noisy = requested.split('/').some((part) => part && part !== '.' && NOISY_DIRS.test(part));
            const projectMap = noisy ? null : await loadProjectMap(root);
            if (projectMap) {
                const result = await searchMapped(projectMap, { query: args.query, dir: args.path || '.', scope, regex: Boolean(args.regex), maxResults: limits.maxSearchResults });
                return { output: result.text, summary: `${result.count} совпадений` };
            }
            const result = await searchFiles({ root, query: args.query, dir: args.path || '.', regex: Boolean(args.regex), maxResults: limits.maxSearchResults, includeNoisy: noisy });
            const note = noisy ? 'Путь исключён из карты проекта; поиск по дереву.' : 'Карта проекта недоступна; поиск по дереву.';
            return { output: `${note}\n${result.text}`, summary: `${result.count} совпадений` };
        },
        /** Write the file, record the change, and refresh that map path. */
        async write_file(args) {
            const result = await writeTextFile({ root, file: args.path, content: args.content, overwrite: args.overwrite !== false,
                maxBytes: limits.maxFileWriteBytes, backupDir, backupSlot });
            stats.changes.push({ op: result.created ? 'create' : 'overwrite', path: result.rel, backupPath: result.backupPath });
            try { await updateProjectMapPath(root, result.rel); }
            catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
            const shot = result.projectBackup ? ` Снимок ${result.projectBackup.id} (${result.projectBackup.slot}).` : '';
            const output = labelOutsideEdit(result.rel, `${result.created ? 'Создан' : 'Перезаписан'} ${result.rel} (${formatBytes(result.bytes)}).${shot}`);
            return { output, summary: `${result.created ? '+' : '~'} ${result.rel}` };
        },
        /** Replace the fragment, record the edit, and refresh that map path. */
        async replace_text(args) {
            const result = await replaceInFile({ root, file: args.path, search: args.search, replacement: args.replacement, all: Boolean(args.all),
                maxBytes: limits.maxFileWriteBytes, backupDir, backupSlot });
            stats.changes.push({ op: 'edit', path: result.rel, backupPath: result.backupPath });
            try { await updateProjectMapPath(root, result.rel); }
            catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
            const output = labelOutsideEdit(result.rel, `Изменён ${result.rel}: замен ${result.replacements}.`);
            return { output, summary: `~ ${result.rel}` };
        },
        /** Delete the file, record it, and refresh that map path. */
        async delete_file(args) {
            const result = await deleteFile({ root, file: args.path, backupDir, backupSlot });
            stats.changes.push({ op: 'delete', path: result.rel, backupPath: result.backupPath });
            try { await updateProjectMapPath(root, result.rel); }
            catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
            const output = labelOutsideEdit(result.rel, `Удалён ${result.rel}.`);
            return { output, summary: `- ${result.rel}` };
        },
        /** Create a directory under `root`. */
        async make_dir(args) {
            const result = await makeDirectory({ root, dir: args.path });
            return { output: `Каталог ${result.rel} создан.`, summary: result.rel };
        },
        /** List snapshots stored in `.backup`. */
        async list_backups(args) {
            const records = await listProjectBackups({ root, file: args.path || null });
            if (!records.length) return { output: 'Снимков нет.', summary: '0 снимков' };
            const text = records.map((record) => `${record.id} ${record.slot} ${record.path} (${formatBytes(record.bytes)})`).join('\n');
            return { output: text, summary: `${records.length} снимков` };
        },
        /** Put a snapshot back. The current bytes are kept as a new snapshot. */
        async restore_backup(args) {
            const result = await restoreProjectBackup({ root, id: args.id, file: args.path || null });
            try { await updateProjectMapPath(root, result.path); }
            catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
            const prior = result.replaced ? ` Текущая версия сохранена как ${result.replaced}.` : '';
            return { output: `Восстановлен ${result.path} из ${result.id} (${result.slot}).${prior}`, summary: `= ${result.path}` };
        },
        /** Restructure a file or a selected range using tasks, rules, and an optional prompt. */
        async structure_file(args) {
            let rules = {};
            if (typeof args.rules_json === 'string' && args.rules_json.trim()) {
                try { rules = JSON.parse(args.rules_json); }
                catch { throw new Error('rules_json не является JSON.'); }
            }
            if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('rules_json должен быть объектом.');
            const prompt = typeof args.prompt === 'string' ? args.prompt : '';
            const selection = args.selection_start_line == null && args.selection_end_line == null ? null : {
                start: { line: args.selection_start_line ?? 0, character: args.selection_start_character ?? 0 },
                end: { line: args.selection_end_line ?? args.selection_start_line ?? 0, character: args.selection_end_character ?? 0 },
            };
            const client = prompt.trim() && config.apiKey ? createClient({
                apiKey: config.apiKey, baseURL: config.baseURL, organization: config.organization, project: config.project,
            }) : null;
            try {
                const result = await structureCode({
                    request: {
                        path: args.path, language: args.language || undefined, tasks: args.tasks, rules, prompt, selection,
                        write: args.write !== false, backupDir,
                    },
                    cwd: root, config, client, signal,
                });
                if (result.path && args.write !== false) {
                    try { await updateProjectMapPath(root, result.path); }
                    catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
                }
                const summary = result.changed ? `структура ${result.path ?? args.path}` : 'без изменений';
                const output = args.write === false ? result.text : `${summary}\nзадачи: ${result.tasks.join(', ') || '—'}`;
                return { output, summary, ok: true };
            } finally { client?.close(); }
        },
        /** Run the command under `root` and return a status block. */
        async run_command(args) {
            if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('Пустая команда.');
            const cwd = args.cwd ? (await resolveInside(root, args.cwd)).abs : root;
            const timeoutMs = commandTimeout(args, limits);
            const shell = chosenShell(args.shell, config.shell ?? null);
            if (isScaffoldCommand(args.command)) {
                const result = await guardScaffold({
                    command: args.command, root: cwd, task: scaffoldTask,
                    run: (options) => runCommand({ ...options, timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, signal, shell }),
                });
                stats.commands.push({ command: args.command, exitCode: result.exitCode, durationMs: result.durationMs });
                const report = commandReport(result, timeoutMs, limits);
                const extra = [`Copied: ${result.copied.join(', ') || '(none)'}`, `Skipped: ${result.skipped.join(', ') || '(none)'}`, `package.json added: ${result.added.join(', ') || '(none)'}`];
                return { output: `${report.output}\n${extra.join('\n')}`, summary: report.summary, ok: report.ok };
            }
            const result = await runCommand({ command: args.command, cwd, timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, signal, shell });
            stats.commands.push({ command: args.command, exitCode: result.exitCode, durationMs: result.durationMs });
            return commandReport(result, timeoutMs, limits);
        },
        /** Run a .ps1, .cmd, .bat, .sh, or .bash file inside the working directory. */
        async run_script(args) {
            if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('Укажите путь к скрипту.');
            const { abs } = await resolveInside(root, args.path, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
            const cwd = args.cwd ? (await resolveInside(root, args.cwd)).abs : root;
            const timeoutMs = commandTimeout(args, limits);
            const launched = scriptLaunch(abs, { shell: chosenShell(args.shell, null), args: Array.isArray(args.args) ? args.args : [] });
            const result = await runProgram({ ...launched, cwd, timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, signal });
            stats.commands.push({ command: args.path, exitCode: result.exitCode, durationMs: result.durationMs });
            return commandReport(result, timeoutMs, limits);
        },
        /** Remote command or one-file copy through the system ssh/scp client. */
        async ssh(args) {
            const timeoutMs = commandTimeout(args, limits);
            const port = args.port == null ? null : Math.min(65535, Math.max(1, args.port));
            let identity = null;
            if (typeof args.identity === 'string' && args.identity.trim()) {
                identity = (await resolveInside(root, args.identity, { allowRoot: false })).abs;
            }
            let localPath = null;
            if (typeof args.local_path === 'string' && args.local_path.trim()) {
                localPath = (await resolveInside(root, args.local_path, { allowRoot: false, forWrite: args.mode === 'get' })).abs;
            }
            const plan = sshPlan({
                mode: args.mode, host: args.host, command: args.command ?? '', port, identity, localPath,
                remotePath: args.remote_path ?? '', shell: chosenShell(args.shell, null),
            });
            let input = null;
            if (plan.sendFile) {
                const info = await stat(localPath).catch(() => null);
                if (!info?.isFile()) throw new Error(`Файл не найден: ${args.local_path}`);
                if (info.size > limits.maxFileReadBytes) throw new Error(`Скрипт больше лимита ${formatBytes(limits.maxFileReadBytes)}.`);
                input = await readFile(localPath);
            }
            const result = await runProgram({ file: plan.file, args: plan.args, cwd: root, input, timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, signal });
            const label = `${plan.file} ${args.host}`;
            stats.commands.push({ command: label, exitCode: result.exitCode, durationMs: result.durationMs });
            return commandReport(result, timeoutMs, limits);
        },
        /** GET an http(s) URL and return text, reducing HTML with `htmlToText`. */
        async fetch_url(args) {
            let url;
            try { url = new URL(args.url); } catch { throw new Error('Некорректный URL.'); }
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Разрешены только http(s) URL.');
            const cap = Math.min(limits.maxFetchBytes, Math.max(1024, args.max_bytes ?? limits.maxFetchBytes));
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('Таймаут загрузки (45 с).')), 45_000);
            const onAbort = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'ai-agent-cli/1.0', Accept: 'text/html, text/plain, application/json, */*' } });
                const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
                const reader = res.body?.getReader();
                const chunks = []; let total = 0; let truncated = false;
                if (reader) {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (total + value.length > cap) { chunks.push(value.subarray(0, cap - total)); total = cap; truncated = true; await reader.cancel().catch(() => {}); break; }
                        chunks.push(value); total += value.length;
                    }
                }
                let text = Buffer.concat(chunks.map((c) => Buffer.from(c)), total).toString('utf8');
                if (mime.includes('html')) text = htmlToText(text);
                else if (!(mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime === '')) {
                    throw new Error(`Неподдерживаемый тип содержимого: ${mime}`);
                }
                const header = `HTTP ${res.status} ${mime}${truncated ? ` (усечено до ${formatBytes(cap)})` : ''}\n`;
                return { output: header + text, summary: `HTTP ${res.status}, ${formatBytes(total)}`, ok: res.ok };
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
        },
        /** Attach a local image, or ask the vision role when `describeImage` is set. */
        async view_image(args) {
            const { abs, rel } = await resolveInside(root, args.path, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
            if (info.size > limits.maxImageBytes) throw new Error(`Изображение больше лимита ${formatBytes(limits.maxImageBytes)}.`);
            const buffer = await readFile(abs);
            const mime = detectImageMime(buffer, abs);
            if (!mime) throw new Error('Не изображение (нужны PNG, JPEG, GIF или WebP).');
            const part = { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}`, detail: args.detail ?? 'auto' };
            if (describeImage) {
                const description = await describeImage({ part, question: args.question ?? null, rel, buffer });
                return { output: `Описание изображения ${rel} (модель vision):\n${description}`, summary: `${rel} → vision (${formatBytes(buffer.length)})` };
            }
            return {
                output: [{ type: 'input_text', text: `Изображение ${rel} (${mime}, ${formatBytes(buffer.length)}):` }, part],
                summary: `${rel} (${formatBytes(buffer.length)})`,
            };
        },
        /** Summarize a UTF-8 file, reusing the memory cache when the bytes match. */
        async summarize_file(args) {
            const { abs, rel } = await resolveInside(root, args.path, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
            if (info.size > 8 * 1024 * 1024) throw new Error(`Файл больше 8 MiB: ${rel}`);
            const buffer = await readFile(abs);
            if (buffer.subarray(0, 8192).includes(0)) throw new Error(`Бинарный файл: ${rel}`);
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error(`Файл ${rel} не в UTF-8.`); }
            const sha256 = createHash('sha256').update(buffer).digest('hex');
            const focus = args.focus ?? null;
            const cacheKey = focus ? `${rel}#${createHash('sha1').update(focus).digest('hex').slice(0, 8)}` : rel;
            const cached = memory && projectKey ? memory.getFileSummary(projectKey, cacheKey, sha256) : null;
            if (cached) return { output: `Сводка ${rel} (из кеша):\n${cached.summary}`, summary: `${rel} (кеш)` };
            const { summary, model } = await summarizeFile({ rel, text, focus });
            if (memory && projectKey) memory.putFileSummary(projectKey, cacheKey, sha256, summary, model ?? null);
            return { output: `Сводка ${rel} (${formatBytes(buffer.length)}):\n${summary}`, summary: `${rel} (${formatBytes(buffer.length)})` };
        },
        /** Search long-term memory and return the matching rows. */
        async recall(args) {
            const rows = memory.recall(String(args.query ?? ''), { project: projectKey, limit: 10 });
            if (!rows.length) return { output: 'В памяти ничего подходящего не найдено.', summary: '0 записей' };
            return { output: rows.map((r) => `[${r.scope}/${r.kind}#${r.id}] ${r.content}${r.tags ? ` (теги: ${r.tags})` : ''}`).join('\n'), summary: `${rows.length} записей` };
        },
        /** Save one memory row and emit `memory.saved`. */
        async remember(args) {
            const row = memory.remember({ scope: args.scope ?? 'project', project: projectKey, projectName, kind: args.kind ?? 'fact',
                content: args.content, tags: args.tags ?? [], source: 'agent' });
            stats.memories.push({ id: row.id, scope: row.scope, kind: row.kind, content: row.content });
            notify({ type: 'memory.saved', count: 1, items: [row] });
            return { output: `Сохранено в память (#${row.id}, ${row.scope}/${row.kind}).`, summary: truncate(row.content, 60) };
        },
        /** Ask the operator, or tell the model to continue when nobody is there. */
        async ask_user(args) {
            if (!askUser) return { output: 'Оператор недоступен (неинтерактивный режим). Примите разумное решение самостоятельно и перечислите допущения в итоговом ответе.', summary: 'нет оператора' };
            const answer = await askUser(String(args.question ?? ''));
            return { output: answer === null || answer === '' ? '(оператор не ответил)' : answer, summary: truncate(answer ?? '', 60) };
        },
        /** Split an image into a grid of tiles. Returns coordinates and source dimensions for each tile. */
        async split_image(args) {
            const { abs, rel } = await resolveInside(root, args.path, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
            if (info.size > limits.maxImageBytes) throw new Error(`Изображение больше лимита ${formatBytes(limits.maxImageBytes)}.`);
            const rows = Math.max(1, Math.min(20, args.rows ?? 1));
            const cols = Math.max(1, Math.min(20, args.cols ?? 1));
            if (rows === 1 && cols === 1) throw new Error('Укажите rows > 1 или cols > 1 для разбивки.');
            const requested = String(args.output ?? '').trim() || `.tmp/split-${Date.now()}`;
            const outputDir = (await resolveInside(root, requested, { forWrite: true, allowRoot: false })).rel;
            const exe = await detectMagick({ magickPath: config.magickPath ?? null });
            if (exe) {
                // Get source dimensions for planning
                let srcDims = '';
                try {
                    const id = await magickIdentify({ exe, input: abs, cwd: root, signal });
                    srcDims = ` (исходный: ${id.width}x${id.height})`;
                } catch { /* optional */ }
                const tiles = await magickSplit({ exe, input: abs, outputDir, rows, cols, cwd: root, signal, baseName: 'tile' });
                const lines = tiles.map((t) => `${t.rel} (${t.width}×${t.height}, x=${t.x}, y=${t.y}, ${formatBytes(t.bytes)})`);
                return { output: `Разбито ${rel}${srcDims} на ${rows}×${cols} (${tiles.length} плиток):\n${lines.join('\n')}`, summary: `${rows}×${cols} → ${outputDir}/` };
            }
            throw new Error('ImageMagick не найден. Установите ImageMagick (magick или convert) или используйте generate_image/edit_image для работы с изображениями.');
        },
        /** Crop a box from an image, or cut its padding off when `trim` is set. Reports source dimensions. */
        async crop_image(args) {
            const { abs, rel } = await resolveInside(root, args.path, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
            const trim = Boolean(args.trim);
            const x = Math.max(0, args.x ?? 0);
            const y = Math.max(0, args.y ?? 0);
            const width = args.width ?? 0;
            const height = args.height ?? 0;
            if (!trim && (!width || !height)) throw new Error('Укажите width и height для обрезки — или trim=true, чтобы снять padding по краям.');
            const requested = String(args.output ?? '').trim() || `.tmp/${trim ? 'trim' : 'crop'}-${Date.now()}.png`;
            const output = (await resolveInside(root, requested, { forWrite: true, allowRoot: false })).rel;
            const exe = await detectMagick({ magickPath: config.magickPath ?? null });
            if (exe) {
                // Get source dimensions for planning
                let srcDims = '';
                try {
                    const id = await magickIdentify({ exe, input: abs, cwd: root, signal });
                    srcDims = ` (исходный: ${id.width}x${id.height})`;
                } catch { /* optional */ }
                if (trim) {
                    // `fuzz` lets a uniform opaque padding go too, not only the transparent one.
                    const cut = await magickTrimImage({ exe, input: abs, output, cwd: root, signal, fuzz: 6 });
                    if (!cut.changed) return { output: `Padding не снят (${TRIM_REFUSED[cut.reason] ?? cut.reason}): ${rel}${srcDims}`, summary: rel };
                    const size = await stat(path.isAbsolute(output) ? output : path.join(root, output)).catch(() => null);
                    const box = `${cut.before.width}×${cut.before.height} → ${cut.after.width}×${cut.after.height}`;
                    return { output: `Снят padding ${rel}${srcDims} → ${output} (${box}, ${formatBytes(size?.size ?? 0)})`, summary: output };
                }
                const result = await magickCrop({ exe, input: abs, output, x, y, width, height, cwd: root, signal });
                return { output: `Обрезано ${rel}${srcDims} → ${result.rel} (${width}×${height} в ${x},${y}, ${formatBytes(result.bytes)})`, summary: result.rel };
            }
            throw new Error('ImageMagick не найден. Установите ImageMagick (magick или convert).');
        },
        /** Generate an SVG file from a prompt. */
        async generate_svg(args) {
            const result = await generateSvg({
                prompt: args.prompt, width: args.width ?? 512, height: args.height ?? 512,
                output: args.path || '', cwd: root, signal,
            });
            return { output: `SVG создан: ${result.rel} (${formatBytes(result.bytes)})`, summary: result.rel };
        },
        /** Download a font file. */
        async download_font(args) {
            const result = await downloadFont({ name: args.name, style: args.style, url: args.url ?? null, output: args.output, cwd: root, signal });
            return { output: `Шрифт ${result.family} сохранён: ${result.rel} (${formatBytes(result.bytes)})`, summary: result.rel };
        },
        /** Download an icon set or single icon. */
        async download_icons(args) {
            const result = await downloadIcons({ name: args.name, icon: args.icon ?? null, variant: args.variant || 'regular', output: args.output, cwd: root, signal });
            return {
                output: `Скачано ${result.count} иконок:\n${result.paths.slice(0, 20).join('\n')}${result.paths.length > 20 ? `\n… ещё ${result.paths.length - 20}` : ''}`,
                summary: `${result.count} иконок`,
            };
        },
        /** Start one nested agent on its own context and fold its tool stats into this run. */
        async run_subagent(args) {
            const result = await subagent(args.kind, args.task);
            adoptStats(result.stats);
            return { output: result.output, summary: result.summary, ok: result.ok !== false };
        },
    };

    if (allowed.has('generate_image') || allowed.has('edit_image') || allowed.has('vectorize_image')) {
        const imageHandlers = createImageHandlers({ root, client, config, signal, describeImage });
        if (allowed.has('generate_image')) handlers.generate_image = imageHandlers.generate_image;
        if (allowed.has('edit_image')) handlers.edit_image = imageHandlers.edit_image;
        if (allowed.has('vectorize_image')) handlers.vectorize_image = imageHandlers.vectorize_image;
    }
    const desktopNames = DESKTOP_TOOL_NAMES.filter((name) => allowed.has(name));
    if (desktopNames.length) {
        const desktopHandlers = createDesktopHandlers({ root, config, decide, describeScreen, performDesktop, delegate });
        for (const name of desktopNames) handlers[name] = desktopHandlers[name];
    }
    if (['decide', 'moderate_text', 'channel_reply', 'telegram_call'].some((name) => allowed.has(name))) {
        Object.assign(handlers, createChannelHandlers({ client, config, signal, ledger }));
    }
    for (const extra of extraByName.values()) handlers[extra.name] = extra.handler;

    /** Execute one function_call item. Never throws for tool errors; throws only on cancellation. */
    async function execute(call) {
        const name = call.name;
        const started = Date.now();
        stats.calls++;
        stats.byTool[name] = (stats.byTool[name] ?? 0) + 1;
        let args = {};
        const fail = (message) => ({ output: `Ошибка: ${message}`, summary: message, ok: false, durationMs: Date.now() - started, category: (TOOL_SPECS[name] ?? extraByName.get(name))?.category ?? null });
        if (!allowed.has(name) || !handlers[name]) { stats.errors++; return fail(`инструмент ${name} недоступен.`); }
        try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
        catch { stats.errors++; return fail('аргументы не являются корректным JSON.'); }
        const spec = TOOL_SPECS[name] ?? extraByName.get(name);
        if (!spec?.category) { stats.errors++; return fail(`инструмент ${name} недоступен.`); }
        const { category } = spec;
        let permitted;
        try { permitted = await decide(name, category, args, preview(name, args)); }
        catch (error) { if (error instanceof CancelledError) throw error; permitted = false; }
        if (!permitted) {
            stats.denied++;
            return fail(`операция ${name} отклонена пользователем или политикой доступа (${approvalLevel}). Не повторяйте её; предложите альтернативу или завершите с описанием.`);
        }
        signal?.throwIfAborted();
        if (PROCESSABLE.has(name) && processTool) {
            let remote = null;
            try {
                remote = await processTool(name, args, signal);
            } catch (error) {
                if (signal?.aborted || error instanceof CancelledError || error?.name === 'AbortError') {
                    throw error instanceof CancelledError ? error : new CancelledError('Отменено.');
                }
                stats.errors++;
                return fail(errorMessage(error));
            }
            if (remote) {
                if (typeof remote.output !== 'string' || typeof remote.summary !== 'string') {
                    stats.errors++;
                    return fail('output и summary должны быть строками.');
                }
                if (WRITE_CHANGES.has(name)) await applyRemoteChanges(remote.changes);
                return { ok: true, output: remote.output, summary: remote.summary, durationMs: Date.now() - started, category };
            }
        }
        try {
            const result = await handlers[name](args);
            return { ok: true, ...result, durationMs: Date.now() - started, category };
        } catch (error) {
            if (signal?.aborted || error instanceof CancelledError) throw error;
            stats.errors++;
            return fail(errorMessage(error));
        }
    }

    return Object.freeze({
        definitions: () => [
            ...toolDefinitions([...allowed].filter((name) => TOOL_SPECS[name])),
            ...[...extraByName.values()].filter((extra) => allowed.has(extra.name)).map((extra) => ({
                type: 'function', name: extra.name, description: extra.description, parameters: extra.parameters, strict: true,
            })),
        ],
        execute,
        names: () => [...allowed],
        stats: () => structuredClone(stats),
        get approvalLevel() { return approvalLevel; },
        set approvalLevel(value) { approvalLevel = value; },
        root,
        setBackupSlot(slot) { backupSlot = slot || 'write'; },
    });
}

/**
 * POSIX path of `abs` relative to `root`.
 * @param {string} root
 * @param {string} abs
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const relativeToRoot = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
