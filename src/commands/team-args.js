/**
 * @file src/commands/team-args.js
 * @module commands/team-args
 * @purpose Shared task, kind, and message template for `ai run` and `ai gen`.
 * @depends node:path, node:fs/promises, commands/flags, generate/brief, core/placeholders, core/runtime-env
 * @usedBy commands/run
 * @exports splitTeamPositionals, resolveKind, applyTemplate, prepareTeamInvocation
 * @ai.tags cli, team
 * @ai.hint io
 * @changed 2026-10-27 Task text expands {{env:NAME}} and {{fs:PATH}}.
 */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { UsageError, resolveTextArg } from './shared.js';
import { GENERATION_KINDS } from '../generate/brief.js';
import { renderPlaceholders } from '../core/placeholders.js';
import { liveEnv } from '../core/runtime-env.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const KIND_WORD = /\b(landing|site|backend|app)\b/gi;

/**
 * A leading kind token is the generation kind. The rest is the task.
 * @param {string[]} positionals
 * @returns {{ kindToken: string | null, task: string }}
 * @exports
 * @ai.hint pure
 */
export function splitTeamPositionals(positionals) {
    const [first, ...rest] = positionals;
    if (first && GENERATION_KINDS.includes(first)) return { kindToken: first, task: rest.join(' ').trim() };
    return { kindToken: null, task: positionals.join(' ').trim() };
}

/**
 * `--kind`, then the leading token, then one kind word in the task.
 * @param {{ flag?: string | null, token?: string | null, task?: string }} input
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function resolveKind({ flag = null, token = null, task = '' } = {}) {
    if (flag && !GENERATION_KINDS.includes(flag)) throw new UsageError(`--kind: ${GENERATION_KINDS.join('|')}`);
    if (flag && token && flag !== token) throw new UsageError(`--kind ${flag} не совпадает с видом ${token}.`);
    if (flag) return flag;
    if (token) return token;
    const found = new Set();
    for (const match of String(task).matchAll(KIND_WORD)) found.add(match[1].toLowerCase());
    return found.size === 1 ? [...found][0] : null;
}

/**
 * The template is the whole task, a wrapper around `{{message}}`, or a prefix.
 * @param {string} template
 * @param {string} message
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function applyTemplate(template, message) {
    const body = String(template ?? '').trim();
    const inline = String(message ?? '').trim();
    if (!body) return inline;
    if (!inline) return body.replaceAll('{{message}}', '');
    if (body.includes('{{message}}')) return body.replaceAll('{{message}}', inline);
    return `${body}\n\n${inline}`;
}

/**
 * Read UTF-8 message templates in order.
 * @param {string[] | undefined} files
 * @param {string} cwd
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function readTemplates(files, cwd) {
    const chunks = [];
    for (const file of files ?? []) {
        const target = path.resolve(cwd, file);
        const info = await stat(target).catch(() => null);
        if (!info?.isFile()) throw new UsageError(`--template: нужен файл UTF-8, получено ${file}`);
        let text;
        try { text = utf8.decode(await readFile(target)); }
        catch { throw new UsageError(`--template: файл не в UTF-8: ${file}`); }
        if (text.includes('\0')) throw new UsageError(`--template: файл не в UTF-8: ${file}`);
        chunks.push(text.trim());
    }
    return chunks.join('\n\n');
}

/**
 * Build the task text and the kind shared by `run` and `gen`.
 * @param {{ positionals: string[], values: object, cwd: string, stdinText?: string }} input
 * @returns {Promise<{ task: string, kind: string | null, wantsProfile: boolean, seedFiles: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function prepareTeamInvocation({ positionals, values, cwd, stdinText = '' }) {
    const split = splitTeamPositionals(positionals);
    let inline = split.task;
    if (inline.startsWith('@') && !inline.includes(' ')) {
        inline = (await resolveTextArg(inline, { cwd, what: 'задачу' })).trim();
    }
    if (!inline && stdinText) inline = stdinText;
    const template = await readTemplates(values.template, cwd);
    const task = await renderPlaceholders(applyTemplate(template, inline), {
        env: liveEnv(), root: cwd, namespaces: ['env', 'fs'],
    });
    const kind = resolveKind({ flag: values.kind ?? null, token: split.kindToken, task });
    const wantsProfile = Boolean(kind) || values.fidelity !== undefined || values.creativity !== undefined || Boolean(values.platform) || Boolean(values.example?.length);
    const images = values.image ?? [];
    const files = values.file ?? [];
    const examples = values.example ?? [];
    if (!task && !images.length && !files.length && !examples.length) {
        throw new UsageError('Укажите задачу: текст, --template, --image, --file или --example.');
    }
    return { task, kind, wantsProfile, seedFiles: files };
}
