/**
 * @file src/agent/file-commands.js
 * @module agent/file-commands
 * @purpose Validate and run fs:read and fs:write handoff commands.
 * @depends node:fs/promises, agent/paths, agent/fs-tools, agent/map, agent/handoff, openai/errors
 * @usedBy agent/team
 * @exports FILE_COMMANDS_SCHEMA, CommandBatchError, executeFileCommands
 * @ai.tags handoff, files
 * @ai.hint io
 * @changed 2026-10-15 File command batch.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { writeTextFile } from './fs-tools.js';
import { updateProjectMapPath } from './map.js';
import { readDirectory, renderArtifactRef, saveHandoff, writeArtifact } from './handoff.js';
import { CancelledError } from '../openai/errors.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const EXTENSIONS = { js: '.js', mjs: '.mjs', html: '.html', css: '.css', md: '.md', json: '.json', glsl: '.glsl' };

/**
 * Strict schema for the encoder file-command reply.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const FILE_COMMANDS_SCHEMA = object({
    summary: { ...string, description: 'What these file commands do.' },
    commands: {
        type: 'array',
        items: object({
            command: { type: 'string', enum: ['fs:read', 'fs:write', 'fs:list'] },
            path: string,
            cwd: string,
            type: { type: 'string', enum: ['code', 'text'] },
            language: string,
            content: nullableString,
            lines: { type: ['array', 'null'], items: string },
            source: nullableString,
            start: nullableInteger,
            end: nullableInteger,
            depth: nullableInteger,
            mode: { type: ['string', 'null'], enum: ['tree', 'list', null], description: 'fs:list: tree is nested, list is flat. Null for read and write.' },
        }),
    },
});

/**
 * A file-command batch failed shape checks or stopped while running.
 */
export class CommandBatchError extends Error {
    /**
     * @param {string} message
     * @param {{ fatal?: boolean }} [options] fatal means nothing in the batch ran.
     */
    constructor(message, options = {}) {
        const { fatal = false } = options;
        super(message);
        this.name = 'CommandBatchError';
        this.fatal = fatal;
        this.changes = options.changes ?? [];
        this.written = options.written ?? [];
    }
}

/**
 * @param {string} language
 * @returns {string}
 * @ai.hint pure
 */
function extensionFor(language) {
    return EXTENSIONS[String(language ?? '').toLowerCase()] ?? '.txt';
}

/**
 * @param {string} cwd
 * @param {string} file
 * @returns {string}
 * @ai.hint pure
 */
function joinCwd(cwd, file) {
    const base = !cwd || cwd === '.' || cwd === './' ? '' : cwd.replace(/^\.\//, '').replace(/\/$/, '');
    const leaf = String(file ?? '').replace(/^\.\//, '');
    if (!base) return leaf;
    if (leaf.startsWith('/') || /^[A-Za-z]:/.test(leaf)) return leaf;
    return `${base}/${leaf}`;
}

/**
 * @param {string} value
 * @returns {{ path: string, start: number | null, end: number | null } | null}
 * @ai.hint pure
 */
export function parseMention(value) {
    if (typeof value !== 'string' || value.includes('://') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
    const match = /^((?:[\w.+-]+\/)*[\w.+-]+\.[\w.+-]+)(?:#(\d+)-(\d+))?$/.exec(value);
    if (!match) return null;
    if (match[1].split('/').includes('..')) return null;
    if (match[2] == null) return { path: match[1], start: null, end: null };
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (start < 1 || end < start) return null;
    return { path: match[1], start, end };
}

/**
 * String values that name a relative file. Keys are ignored.
 * @param {unknown} value
 * @param {Array<{ path: string, start: number | null, end: number | null }>} out
 * @returns {void}
 * @ai.hint pure
 */
export function collectMentions(value, out) {
    if (typeof value === 'string') {
        const mention = parseMention(value);
        if (mention) out.push(mention);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectMentions(item, out);
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectMentions(item, out);
    }
}

/**
 * Fill empty write paths and languages. Read commands keep an empty path for the shape check.
 * @param {object[]} commands
 * @param {object[]} artifacts
 * @returns {object[]}
 * @ai.hint pure
 */
export function normalizeCommands(commands, artifacts) {
    let snippet = 0;
    return commands.map((command) => {
        const next = { ...command, cwd: command.cwd ? command.cwd : '.' };
        if (next.command === 'fs:list') {
            if (!next.path) next.path = '.';
            if (next.depth == null) next.depth = 2;
            if (!next.mode) next.mode = 'tree';
            return next;
        }
        if (next.command !== 'fs:write') return next;
        const artifact = artifacts.find((item) => item.rel === next.source);
        if (!next.language) next.language = artifact?.hintLanguage || 'text';
        if (!next.type) next.type = next.language === 'text' ? 'text' : 'code';
        if (!next.path) {
            if (artifact?.hintPath && !artifact.hintPath.split('/').includes('..')) next.path = artifact.hintPath;
            else {
                snippet += 1;
                next.path = `snippet-${String(snippet).padStart(3, '0')}${extensionFor(next.language)}`;
            }
        }
        return next;
    });
}

/**
 * Reject a batch before any command runs.
 * @param {object[]} commands
 * @param {{ runRel: string, maxWriteBytes: number }} limits
 * @returns {void}
 * @ai.hint pure
 */
export function assertCommandShape(commands, { runRel, maxWriteBytes }) {
    const fail = (message) => { throw new CommandBatchError(message, { fatal: true }); };
    for (const [index, command] of commands.entries()) {
        const where = `Команда ${index + 1}`;
        if (command.command !== 'fs:read' && command.command !== 'fs:write' && command.command !== 'fs:list') fail(`${where}: ожидается fs:read, fs:write или fs:list.`);
        const ranged = command.start != null || command.end != null;
        if (ranged && (command.start == null || command.end == null || command.start < 1 || command.end < command.start)) {
            fail(`${where}: start и end задаются вместе, строки с 1.`);
        }
        if (command.command === 'fs:write' && ranged) fail(`${where}: запись не принимает диапазон строк.`);
        const bodies = [command.content, command.lines, command.source].filter((item) => item != null);
        if (command.command === 'fs:list') {
            if (bodies.length) fail(`${where}: fs:list не содержит тела.`);
            if (command.depth != null && (!Number.isSafeInteger(command.depth) || command.depth < 1 || command.depth > 6)) fail(`${where}: depth от 1 до 6.`);
            if (command.mode != null && command.mode !== 'tree' && command.mode !== 'list') fail(`${where}: mode tree или list.`);
            continue;
        }
        if (command.command === 'fs:read') {
            if (!command.path) fail(`${where}: fs:read требует path.`);
            if (bodies.length) fail(`${where}: fs:read не содержит тела.`);
            continue;
        }
        if (bodies.length !== 1) fail(`${where}: у записи ровно одно тело.`);
        const inline = command.content != null ? command.content : command.lines != null ? command.lines.join('\n') : null;
        if (inline != null && Buffer.byteLength(inline) > 2048) fail(`${where}: тело больше 2048 байт передаётся через source.`);
        if (inline != null && Buffer.byteLength(inline) > maxWriteBytes) fail(`${where}: тело больше лимита записи.`);
        if (command.source != null && !command.source.startsWith(`${runRel}/`)) fail(`${where}: source вне ${runRel}.`);
        if (command.source != null && command.source.split('/').includes('..')) fail(`${where}: source вне ${runRel}.`);
    }
}

/**
 * @param {string} root
 * @param {string} file
 * @param {number | null} start
 * @param {number | null} end
 * @param {number} maxBytes
 * @returns {Promise<{ rel: string, text: string, start: number | null, end: number | null }>}
 * @ai.hint io
 */
async function readFragment(root, file, start, end, maxBytes) {
    const { abs, rel } = await resolveInside(root, file, { allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info) throw new CommandBatchError(`Файл не найден: ${file}`);
    if (!info.isFile()) throw new CommandBatchError(`Не файл: ${file}`);
    const raw = await readFile(abs);
    if (raw.subarray(0, Math.min(8192, raw.length)).includes(0)) throw new CommandBatchError(`Бинарный файл: ${rel}`);
    let text;
    try { text = utf8.decode(raw); }
    catch { throw new CommandBatchError(`Файл ${rel} не в UTF-8.`); }
    if (start == null) {
        if (Buffer.byteLength(text) > maxBytes) throw new CommandBatchError(`Фрагмент больше лимита чтения: ${rel}`);
        return { rel, text, start: null, end: null };
    }
    const lines = text.split(/\r?\n/);
    if (start > lines.length) throw new CommandBatchError(`start ${start} больше числа строк (${lines.length}).`);
    const to = Math.min(lines.length, end);
    const selected = lines.slice(start - 1, to).join('\n');
    if (Buffer.byteLength(selected) > maxBytes) throw new CommandBatchError(`Фрагмент больше лимита чтения: ${rel}`);
    return { rel, text: selected, start, end: to };
}

/**
 * @param {object} state
 * @param {string} origin
 * @param {number | null} start
 * @param {number | null} end
 * @returns {boolean}
 * @ai.hint pure
 */
function alreadyRead(state, origin, start, end) {
    return state.artifacts.some((item) => item.origin === origin && item.start === start && item.end === end);
}

/**
 * Run a normalized command list. Shape errors throw fatal. A later failure keeps earlier results.
 * @param {object} options
 * @returns {Promise<{ status: 'completed' | 'incomplete', changes: object[], written: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function executeFileCommands({
    root, state, commands, limits, approvalLevel = 'read', approve = async () => 'no', backupDir = null, emit = () => {},
}) {
    const prepared = normalizeCommands(commands, state.artifacts);
    assertCommandShape(prepared, { runRel: state.relDir, maxWriteBytes: limits.maxFileWriteBytes });
    const changes = [];
    const written = [];
    let allowWrites = approvalLevel === 'all' || approvalLevel === 'write';
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };

    /**
     * @param {object} command
     * @param {boolean} followMentions
     * @returns {Promise<void>}
     */
    async function readCommand(command, followMentions) {
        const fragment = await readFragment(root, joinCwd(command.cwd, command.path), command.start, command.end, limits.maxFileReadBytes);
        if (alreadyRead(state, fragment.rel, fragment.start, fragment.end)) return;
        const artifact = await writeArtifact(root, state, {
            body: fragment.text,
            origin: fragment.rel,
            hintPath: fragment.rel,
            hintLanguage: command.language || null,
            start: fragment.start,
            end: fragment.end,
        });
        const block = renderArtifactRef(artifact, fragment.text);
        state.text = state.text ? `${state.text}\n\n${block}` : block;
        if (!followMentions) return;
        let parsed;
        try { parsed = JSON.parse(fragment.text); }
        catch { return; }
        if (!parsed || typeof parsed !== 'object') return;
        const mentions = [];
        collectMentions(parsed, mentions);
        let taken = 0;
        for (const mention of mentions) {
            if (taken >= 32) break;
            if (alreadyRead(state, mention.path, mention.start, mention.end)) continue;
            taken += 1;
            try {
                await readCommand({ ...command, path: mention.path, cwd: '.', start: mention.start, end: mention.end, language: '' }, false);
            } catch { /* a mention that cannot be read is skipped */ }
        }
    }

    try {
    for (const command of prepared) {
        if (command.command === 'fs:list') {
            let listing;
            try { listing = await readDirectory({ root, dir: joinCwd(command.cwd, command.path), depth: command.depth, mode: command.mode }); }
            catch (error) { throw new CommandBatchError(error.message); }
            const artifact = await writeArtifact(root, state, {
                body: listing.text, origin: listing.rel, hintPath: listing.rel, hintLanguage: command.mode, entries: listing.entries,
            });
            const block = renderArtifactRef(artifact, listing.text);
            state.text = state.text ? `${state.text}\n\n${block}` : block;
            continue;
        }
        if (command.command === 'fs:read') {
            try { await readCommand(command, true); }
            catch (error) {
                if (error instanceof CancelledError || error instanceof CommandBatchError) throw error;
                throw new CommandBatchError(error.message);
            }
            continue;
        }
        if (!allowWrites) {
            if (approvalLevel === 'ask' && !allowWrites) {
                const inline = command.content ?? (command.lines ? command.lines.join('\n') : '');
                const preview = `Записать ${joinCwd(command.cwd, command.path)}${command.source ? ` из ${command.source}` : ''}\n${String(inline).split('\n').slice(0, 12).join('\n')}`;
                notify({ type: 'approval.request', name: 'fs:write', category: 'write', preview });
                const answer = await approve({ name: 'fs:write', category: 'write', args: command, preview });
                notify({ type: 'approval.result', name: 'fs:write', answer });
                if (answer === 'abort') throw new CancelledError('Остановлено пользователем при запросе подтверждения.');
                if (answer === 'always') allowWrites = true;
                else if (answer !== 'yes') throw new CommandBatchError('Запись отклонена.', { changes, written });
            } else if (!allowWrites) throw new CommandBatchError('Запись отклонена политикой доступа.', { changes, written });
        }
        let body = command.content;
        if (command.lines) body = command.lines.join('\n');
        if (command.source) {
            const { abs } = await resolveInside(root, command.source, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new CommandBatchError(`source не найден: ${command.source}`);
            if (info.size > limits.maxFileWriteBytes) throw new CommandBatchError(`source больше лимита записи: ${command.source}`);
            body = await readFile(abs, 'utf8');
        }
        const target = joinCwd(command.cwd, command.path);
        const result = await writeTextFile({
            root, file: target, content: body, overwrite: true, maxBytes: limits.maxFileWriteBytes, backupDir,
        });
        changes.push({ op: result.created ? 'create' : 'overwrite', path: result.rel, backupPath: result.backupPath });
        written.push(result.rel);
        try { await updateProjectMapPath(root, result.rel); }
        catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
    }
    } catch (error) {
        state.commands = prepared;
        state.from = 'executor';
        await saveHandoff(root, state);
        if (error instanceof CommandBatchError) {
            error.changes = changes;
            error.written = written;
        }
        throw error;
    }
    state.commands = prepared;
    state.from = 'executor';
    await saveHandoff(root, state);
    return { status: 'completed', changes, written };
}
