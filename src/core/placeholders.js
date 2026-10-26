/**
 * @file src/core/placeholders.js
 * @module core/placeholders
 * @purpose Expand {{env:NAME}}, {{task:PROMPT}}, {{delegated:PROMPT}}, and {{fs:PATH}} in config strings and prompts.
 * @depends node:path, node:fs/promises, agent/paths
 * @usedBy core/config, agent/roles, commands/flow, commands/team-args, commands/chat
 * @exports PLACEHOLDER_PATTERN, renderPlaceholders, expandConfigStrings
 * @ai.tags config, prompt, templates
 * @ai.hint io
 * @changed 2026-10-27 Placeholders for environment values, the current and delegated task, and project files.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolveInside } from '../agent/paths.js';

/** `{{scope:name}}` with a lower-case scope and an optional value. */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^{}]*?)\s*\}\}/g;

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Read one file for a `{{fs:...}}` placeholder. The path stays inside the project root, secrets
 * are refused, and the file must be UTF-8 text under the byte cap.
 * @param {string} relative Project-relative path.
 * @param {{ root?: string, maxBytes?: number }} options
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function readPlaceholderFile(relative, { root = process.cwd(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!relative) throw new Error('{{fs:...}}: нужен путь к файлу');
    let target;
    try {
        target = await resolveInside(root, relative, { allowRoot: false });
    } catch (error) {
        throw new Error(`{{fs:${relative}}}: ${error.message}`);
    }
    const info = await stat(target.abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`{{fs:${relative}}}: файл не найден`);
    if (info.size > maxBytes) throw new Error(`{{fs:${relative}}}: файл больше лимита ${maxBytes} байт`);
    const buffer = await readFile(target.abs);
    if (buffer.includes(0)) throw new Error(`{{fs:${relative}}}: бинарный файл не подставляется`);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
    } catch {
        throw new Error(`{{fs:${relative}}}: файл не в UTF-8`);
    }
}

/**
 * Replace every recognized placeholder. An unknown scope or slot stays as written, so a template
 * can be expanded in two passes: config strings first, prompts later.
 *
 * `env` is empty when the variable is missing. `task` and `delegated` accept the `PROMPT` slot and
 * stay untouched when the scope itself was not supplied. `fs` reads a project file and throws when
 * the path escapes the root, names a secret, is binary, is not UTF-8, or exceeds `maxBytes`.
 *
 * @param {string} text
 * @param {{ env?: object|null, root?: string, task?: string|null, delegated?: string|null,
 *   maxBytes?: number, namespaces?: string[]|null }} [options] `namespaces` limits which scopes are expanded.
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function renderPlaceholders(text, {
    env = null, root = process.cwd(), task = undefined, delegated = undefined,
    maxBytes = DEFAULT_MAX_BYTES, namespaces = null,
} = {}) {
    if (typeof text !== 'string' || !text.includes('{{')) return text;
    const allowed = Array.isArray(namespaces) ? new Set(namespaces.map((name) => String(name).toLowerCase())) : null;
    let out = '';
    let last = 0;
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
        const [raw, rawScope, rawName] = match;
        const scope = rawScope.toLowerCase();
        const name = rawName.trim();
        out += text.slice(last, match.index);
        let replacement;
        if (!allowed || allowed.has(scope)) {
            if (scope === 'env') {
                const value = env?.[name];
                replacement = value == null ? '' : String(value);
            } else if (scope === 'task' || scope === 'delegated') {
                const value = scope === 'task' ? task : delegated;
                if (value !== undefined && name.toUpperCase() === 'PROMPT') replacement = value ?? '';
            } else if (scope === 'fs') {
                replacement = await readPlaceholderFile(name, { root, maxBytes });
            }
        }
        out += replacement === undefined ? raw : replacement;
        last = match.index + raw.length;
    }
    return out + text.slice(last);
}

/**
 * Expand placeholders in every string of a configuration tree. Only `env` and `fs` are resolved:
 * `task` and `delegated` have no value while the configuration is loaded and stay for a prompt pass.
 * @param {*} value
 * @param {{ env?: object|null, root?: string, maxBytes?: number }} [scope]
 * @returns {Promise<*>}
 * @exports
 * @ai.hint io
 */
export async function expandConfigStrings(value, scope = {}) {
    const options = { ...scope, namespaces: ['env', 'fs'] };
    if (typeof value === 'string') return renderPlaceholders(value, options);
    if (Array.isArray(value)) return Promise.all(value.map((item) => expandConfigStrings(item, scope)));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = await expandConfigStrings(item, scope);
        return out;
    }
    return value;
}
