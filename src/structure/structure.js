/**
 * @file src/structure/structure.js
 * @module structure/structure
 * @purpose Apply structure tasks to a file or a selected range, then an optional prompt.
 * @depends node:fs/promises, agent/paths, agent/fs-tools, complete/errors, complete/complete, structure/imports, structure/style
 * @usedBy commands/complete, agent/tools, index.js
 * @exports STRUCTURE_TASKS, structureText, structureCode
 * @ai.tags structure, edit
 * @ai.hint io
 * @changed 2026-10-15 User tasks, rules, and prompts for inline structure edits.
 */

import { readFile } from 'node:fs/promises';
import { resolveInside } from '../agent/paths.js';
import { writeTextFile } from '../agent/fs-tools.js';
import { CompletionError } from '../complete/errors.js';
import { buildCompletionBody, stripCompletion } from '../complete/complete.js';
import { sortImports } from './imports.js';
import { parseStyle, printStyle, styleTasks } from './style.js';

const ALIASES = {
    unify: 'group-selectors', 'merge-rules': 'merge', 'sort-css': 'sort-rules', 'sort-selectors': 'sort-rules', format: 'clean',
};
const STYLE = new Set(['css', 'scss', 'sass', 'less']);
const SCRIPT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']);
const STYLE_TASKS = new Set(Object.keys(styleTasks));

/** Built-in task names. Unknown names are sent to the model with the prompt. */
export const STRUCTURE_TASKS = ['sort-imports', 'sort-rules', 'sort-properties', 'group-properties', 'group-selectors', 'layers', 'clean', 'dedupe', 'merge', 'sort-lines'];

/**
 * @param {string} name
 * @returns {string}
 * @ai.hint pure
 */
function canonical(name) {
    const task = String(name ?? '').trim().toLowerCase();
    return ALIASES[task] ?? task;
}

/**
 * @param {string[]|string|null|undefined} tasks
 * @param {string} language
 * @returns {{ known: string[], unknown: string[] }}
 * @ai.hint pure
 */
function normalizeTasks(tasks, language) {
    const list = Array.isArray(tasks) ? tasks : typeof tasks === 'string' ? tasks.split(',') : [];
    const names = list.map(canonical).filter(Boolean);
    const chosen = names.length ? names : defaultTasks(language);
    const known = [];
    const unknown = [];
    for (const task of chosen) {
        if (STRUCTURE_TASKS.includes(task)) known.push(task);
        else unknown.push(task);
    }
    return { known, unknown };
}

/**
 * @param {string} language
 * @returns {string[]}
 * @ai.hint pure
 */
function defaultTasks(language) {
    if (STYLE.has(language)) return ['dedupe', 'merge', 'group-properties', 'sort-rules', 'clean'];
    if (SCRIPT.has(language)) return ['sort-imports', 'clean'];
    return ['clean'];
}

/**
 * @param {object} request
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function languageOf(request, text) {
    const named = typeof request.language === 'string' ? request.language.trim().toLowerCase().replace(/^\./, '') : '';
    if (named) return named;
    const path = typeof request.path === 'string' ? request.path : '';
    const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
    if (STYLE.has(ext) || SCRIPT.has(ext)) return ext;
    if (/^\s*(import|export)\b/m.test(text)) return 'ts';
    if (/\{[\s\S]*:[\s\S]*;/.test(text)) return 'scss';
    return 'text';
}

/**
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function cleanText(text) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    return text.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/g, '')).join(newline).replace(/(?:\r?\n){3,}/g, newline + newline);
}

/**
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function sortLines(text) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const trailing = lines.at(-1) === '' ? lines.pop() : null;
    lines.sort((a, b) => a.localeCompare(b));
    if (trailing === '') lines.push('');
    return lines.join(newline);
}

/**
 * Run the built-in tasks. Style tasks parse once and print once.
 * @param {string} text
 * @param {string[]} tasks
 * @param {string} language
 * @param {object} rules
 * @returns {string}
 * @ai.hint pure
 */
function applyKnown(text, tasks, language, rules) {
    let current = text;
    let tree = null;
    /**
     * Print a pending style tree back into text.
     * @returns {void}
     * @ai.hint pure
     */
    const flush = () => {
        if (!tree) return;
        const printed = printStyle(tree);
        current = printed ? `${printed}\n` : '';
        tree = null;
    };
    for (const task of tasks) {
        if (task === 'sort-imports') { flush(); current = sortImports(current, rules); continue; }
        if (task === 'sort-lines') { flush(); current = sortLines(current); continue; }
        if (task === 'clean' && !STYLE.has(language)) { flush(); current = cleanText(current); continue; }
        if (!STYLE_TASKS.has(task)) continue;
        if (!STYLE.has(language)) throw new CompletionError(`Задача ${task} применяется к CSS или SCSS.`);
        tree ??= parseStyle(current);
        tree = styleTasks[task](tree, rules);
    }
    flush();
    return current;
}

/**
 * Offsets of a 0-based selection. Without a selection the whole text is the slice.
 * @param {string} text LF text.
 * @param {object|null} selection
 * @returns {{ prefix: string, slice: string, suffix: string }}
 * @ai.hint pure
 */
function splitSelection(text, selection) {
    if (!selection?.start || !selection?.end) return { prefix: '', slice: text, suffix: '' };
    const lines = text.split('\n');
    /**
     * @param {{ line: number, character: number }} position
     * @returns {number}
     * @ai.hint pure
     */
    const offset = (position) => {
        const line = Math.min(Math.max(position.line ?? 0, 0), Math.max(0, lines.length - 1));
        let cursor = 0;
        for (let i = 0; i < line; i++) cursor += lines[i].length + 1;
        return cursor + Math.min(Math.max(position.character ?? position.column ?? 0, 0), lines[line].length);
    };
    let start = offset(selection.start);
    let end = offset(selection.end);
    if (end < start) [start, end] = [end, start];
    return { prefix: text.slice(0, start), slice: text.slice(start, end), suffix: text.slice(end) };
}

/**
 * Ask the model for a structural rewrite of one slice. The reply replaces that slice.
 * @param {object} options
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function rewriteWithModel({ client, config, request, text, tasks, rules, signal }) {
    const model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : config.completion.model;
    const effort = typeof request.effort === 'string' && request.effort.trim() ? request.effort.trim() : 'low';
    const prompt = [
        request.path ? `File: ${request.path}` : null,
        request.language ? `Language: ${request.language}` : null,
        tasks.length ? `Tasks: ${tasks.join(', ')}` : null,
        Object.keys(rules).length ? `Rules:\n${JSON.stringify(rules)}` : null,
        typeof request.prompt === 'string' && request.prompt.trim() ? `Prompt:\n${request.prompt.trim()}` : null,
        '',
        'Text:',
        text,
    ].filter((line) => line !== null).join('\n');
    const maxOutputTokens = Math.min(4096, Math.max(256, Math.ceil(text.length / 2)));
    const body = buildCompletionBody({ model, effort, prompt, maxOutputTokens, config });
    body.instructions = 'You restructure source code. Return only the replacement text. Do not use a markdown fence or an explanation. Follow the tasks, rules, and prompt. Keep behavior the same while improving order, grouping, duplication, and formatting.';
    const response = await client.responses.create(body, { signal });
    return stripCompletion(response.output_text ?? '');
}

/**
 * Restructure text. `tasks` and `rules` are the user-defined part; `prompt` is optional model guidance.
 * A selection limits the edit to that range (an opened editor buffer).
 * @param {string} text
 * @param {{ language?: string, path?: string, tasks?: string[]|string, rules?: object, selection?: object }} request
 * @returns {{ text: string, slice: string, language: string, tasks: string[], unknown: string[] }}
 * @exports
 * @ai.hint pure
 */
export function structureText(text, request = {}) {
    const normalized = text.replace(/\r\n/g, '\n');
    const language = languageOf(request, normalized);
    const { known, unknown } = normalizeTasks(request.tasks, language);
    const rules = request.rules && typeof request.rules === 'object' && !Array.isArray(request.rules) ? request.rules : {};
    const parts = splitSelection(normalized, request.selection);
    const slice = applyKnown(parts.slice, known, language, rules);
    const next = `${parts.prefix}${slice}${parts.suffix}`;
    const restored = text.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next;
    return { text: restored, slice, language, tasks: known, unknown };
}

/**
 * Load, restructure, and optionally write a file. A prompt or an unknown task calls the model.
 * @param {{ request: object, cwd?: string, config: object, client?: object|null, signal?: AbortSignal }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function structureCode({ request, cwd = process.cwd(), config, client = null, signal }) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new CompletionError('Запрос структуры должен быть объектом.');
    let content = typeof request.content === 'string' ? request.content : null;
    if (content === null) {
        if (typeof request.path !== 'string' || !request.path.trim()) throw new CompletionError('Нужен content или path.');
        let abs;
        try { ({ abs } = await resolveInside(cwd, request.path)); }
        catch (error) { throw new CompletionError(error.message, { status: 400, code: 'BAD_PATH' }); }
        try { content = await readFile(abs, 'utf8'); }
        catch { throw new CompletionError(`Файл не найден: ${request.path}`, { status: 400, code: 'BAD_PATH' }); }
    }
    const built = structureText(content, request);
    let text = built.text;
    let modelUsed = false;
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (prompt || built.unknown.length) {
        if (!client) throw new CompletionError('Для prompt или своей задачи нужен API-ключ.', { status: 401, code: 'NO_API_KEY' });
        const parts = splitSelection(content.replace(/\r\n/g, '\n'), request.selection);
        const replacement = await rewriteWithModel({
            client, config, request, text: built.slice, tasks: [...built.tasks, ...built.unknown], rules: request.rules ?? {}, signal,
        });
        const merged = `${parts.prefix}${replacement}${parts.suffix}`;
        text = content.includes('\r\n') ? merged.replace(/\n/g, '\r\n') : merged;
        modelUsed = true;
    }
    let written = null;
    if (request.write && typeof request.path === 'string' && request.path.trim()) {
        written = await writeTextFile({
            root: cwd, file: request.path, content: text, overwrite: true, maxBytes: config.limits?.maxFileWriteBytes, backupDir: request.backupDir ?? null,
        });
    }
    return {
        text, language: built.language, tasks: built.tasks, unknown: built.unknown, modelUsed,
        changed: text !== content, path: written?.rel ?? request.path ?? null, bytes: written?.bytes ?? Buffer.byteLength(text),
    };
}
