/**
 * @file src/agent/handoff.js
 * @module agent/handoff
 * @purpose Spill an answer into `.tmp` and choose encoder or planner.
 * @depends node:path, node:crypto, node:fs/promises
 * @usedBy agent/team, agent/file-commands
 * @exports ANSWER_INSTRUCTIONS, INLINE_BYTES, spillFences, stripRoute, chooseRoute, referenceLine, renderArtifactRef, openHandoff, seedTextFile, readDirectory, seedDirectory
 * @ai.tags handoff, tmp
 * @ai.hint io
 * @changed 2026-10-15 First answer chain.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { NOISY_DIRS, resolveInside } from './paths.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Bytes at or under this size are inlined under the artifact reference. */
export const INLINE_BYTES = 2048;

/**
 * Prompt for the first prose answer. The last line is a route label.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const ANSWER_INSTRUCTIONS = `You write the first answer to the task. Reply in the user's language.
Put every file body in a fenced code block with a language tag. Name the file in the heading or the paragraph just before the block when you know it.
On the last line write exactly "route: encode" when those bodies are ready to save, or "route: plan" when a planner should decide the next steps.
Do not write files yourself.`;

/**
 * Drop a final `route: encode` or `route: plan` line. Anything else stays in the text.
 * @param {string} text
 * @returns {{ text: string, label: 'encode' | 'plan' | null }}
 * @exports
 * @ai.hint pure
 */
export function stripRoute(text) {
    const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
    while (lines.length && lines.at(-1).trim() === '') lines.pop();
    const match = /^route:\s*(encode|plan)\s*$/i.exec(lines.at(-1)?.trim() ?? '');
    if (!match) return { text: String(text ?? '').trim(), label: null };
    lines.pop();
    const label = match[1].toLowerCase() === 'encode' ? 'encode' : 'plan';
    return { text: lines.join('\n').trim(), label };
}

/**
 * One relative path in the paragraph before a fence, or null.
 * @param {string} before
 * @returns {string | null}
 * @ai.hint pure
 */
function hintFromPreamble(before) {
    const paragraph = before.trim().split(/\n\s*\n/).at(-1) ?? '';
    const found = new Set();
    const re = /(?:^|[\s`'"(])((?:[\w.+-]+\/)*[\w.+-]+\.[\w.+-]+)/g;
    for (const match of paragraph.matchAll(re)) {
        const token = match[1];
        if (token.split('/').includes('..')) continue;
        found.add(token);
    }
    return found.size === 1 ? [...found][0] : null;
}

/**
 * Replace fenced blocks with placeholders. Bodies are not given an extension.
 * @param {string} text
 * @returns {{ text: string, blocks: Array<{ id: string, body: string, hintLanguage: string | null, hintPath: string | null }> }}
 * @exports
 * @ai.hint pure
 */
export function spillFences(text) {
    const source = String(text ?? '');
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    const blocks = [];
    const parts = [];
    let cursor = 0;
    for (const match of source.matchAll(re)) {
        parts.push(source.slice(cursor, match.index));
        const info = match[1].trim();
        const id = `a${String(blocks.length + 1).padStart(3, '0')}`;
        blocks.push({
            id,
            body: match[2].replace(/\n$/, ''),
            hintLanguage: info ? info.split(/\s+/)[0] : null,
            hintPath: hintFromPreamble(source.slice(cursor, match.index)),
        });
        parts.push(`[[artifact ${id}]]`);
        cursor = match.index + match[0].length;
    }
    parts.push(source.slice(cursor));
    return { text: parts.join(''), blocks };
}

/**
 * True when a backtick span is one relative file path.
 * @param {string} text
 * @returns {boolean}
 * @ai.hint pure
 */
function hasBacktickPath(text) {
    for (const match of String(text ?? '').matchAll(/`([^`\n]+)`/g)) {
        const token = match[1];
        if (/\s/.test(token) || token.includes('://') || token.startsWith('/') || /^[A-Za-z]:/.test(token)) continue;
        if (token.split('/').includes('..')) continue;
        const base = token.split('/').at(-1) ?? '';
        if (base.includes('.') && base !== '.' && base !== '..') return true;
    }
    return false;
}

/**
 * Flag, then the model label, then fences or a backtick path.
 * @param {{ flag?: 'encoder' | 'planner' | null, label?: 'encode' | 'plan' | null, text?: string, artifacts?: object[] }} input
 * @returns {'encode' | 'plan'}
 * @exports
 * @ai.hint pure
 */
export function chooseRoute({ flag = null, label = null, text = '', artifacts = [] } = {}) {
    if (flag === 'encoder') return 'encode';
    if (flag === 'planner') return 'plan';
    if (label === 'encode' || label === 'plan') return label;
    if (artifacts.length || hasBacktickPath(text)) return 'encode';
    return 'plan';
}

/**
 * One line naming an artifact. Bodies stay out of this line.
 * @param {object} artifact
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function referenceLine(artifact) {
    const bits = [`[artifact ${artifact.id}] ${artifact.rel}`];
    if (artifact.origin) bits.push(`origin ${artifact.origin}`);
    if (artifact.hintPath) bits.push(`hint ${artifact.hintPath}`);
    if (artifact.hintLanguage) bits.push(artifact.hintLanguage);
    if (artifact.start != null) bits.push(`lines ${artifact.start}-${artifact.end}`);
    bits.push(`${artifact.bytes} bytes`);
    return bits.join(' · ');
}

/**
 * Reference line, plus the body when it is small enough to inline.
 * @param {object} artifact
 * @param {string} body
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderArtifactRef(artifact, body) {
    const line = referenceLine(artifact);
    if (artifact.bytes <= INLINE_BYTES) return `${line}\n\n\`\`\`\n${body}\n\`\`\``;
    return line;
}

/**
 * Create `.tmp/<id>/` and an empty handoff document.
 * @param {string} root
 * @param {{ profile?: object | null }} [options]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function openHandoff(root, { profile = null } = {}) {
    const id = randomBytes(4).toString('hex');
    const relDir = `.tmp/${id}`;
    const dir = path.join(root, '.tmp', id);
    await mkdir(dir, { recursive: true });
    const state = {
        id, relDir, from: 'operator', to: 'answer', route: null, text: '', artifacts: [], commands: [], profile,
    };
    await saveHandoff(root, state);
    return state;
}

/**
 * Write `handoff.json`. The directory is not removed.
 * @param {string} root
 * @param {object} state
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function saveHandoff(root, state) {
    const file = path.join(root, '.tmp', state.id, 'handoff.json');
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Store one body as `.tmp/<id>/a00N` with no extension.
 * @param {string} root
 * @param {object} state
 * @param {{ body: string, hintLanguage?: string | null, hintPath?: string | null, origin?: string | null, start?: number | null, end?: number | null, id?: string }} block
 * @returns {Promise<object>}
 * @ai.hint io
 */
export async function writeArtifact(root, state, block) {
    const id = block.id ?? `a${String(state.artifacts.length + 1).padStart(3, '0')}`;
    const rel = `${state.relDir}/${id}`;
    const body = String(block.body ?? '');
    await writeFile(path.join(root, '.tmp', state.id, id), body, 'utf8');
    const artifact = {
        id, rel,
        hintLanguage: block.hintLanguage ?? null,
        hintPath: block.hintPath ?? null,
        bytes: Buffer.byteLength(body),
        origin: block.origin ?? null,
        start: block.start ?? null,
        end: block.end ?? null,
        ...(block.entries ? { entries: block.entries } : {}),
    };
    state.artifacts.push(artifact);
    return artifact;
}

/**
 * Spill fences from a completed answer into the handoff.
 * @param {string} root
 * @param {object} state
 * @param {string} answer
 * @returns {Promise<{ label: 'encode' | 'plan' | null }>}
 * @exports
 * @ai.hint io
 */
export async function spillAnswer(root, state, answer) {
    const { text, label } = stripRoute(answer);
    const spilled = spillFences(text);
    let rendered = spilled.text;
    for (const block of spilled.blocks) {
        const artifact = await writeArtifact(root, state, block);
        rendered = rendered.replace(`[[artifact ${block.id}]]`, renderArtifactRef(artifact, block.body));
    }
    const next = rendered.trim();
    state.text = state.text ? `${state.text}\n\n${next}` : next;
    state.from = 'answer';
    await saveHandoff(root, state);
    return { label };
}

/**
 * Read a UTF-8 text file into the handoff when it fits the read limit.
 * Oversized, binary, and non-UTF-8 files are skipped.
 * @param {{ root: string, state: object, file: string, maxBytes: number }} options
 * @returns {Promise<object | null>}
 * @exports
 * @ai.hint io
 */
export async function seedTextFile({ root, state, file, maxBytes }) {
    let located;
    try { located = await resolveInside(root, file, { allowRoot: false }); }
    catch { return null; }
    const info = await stat(located.abs).catch(() => null);
    if (!info?.isFile() || info.size > maxBytes) return null;
    const sample = Buffer.alloc(Math.min(8192, info.size));
    const raw = await readFile(located.abs);
    if (raw.subarray(0, sample.length).includes(0)) return null;
    let text;
    try { text = utf8.decode(raw); }
    catch { return null; }
    const artifact = await writeArtifact(root, state, { body: text, origin: located.rel, hintPath: located.rel, hintLanguage: 'file' });
    const block = renderArtifactRef(artifact, text);
    state.text = state.text ? `${state.text}\n\n${block}` : block;
    await saveHandoff(root, state);
    return artifact;
}

/**
 * Nested tree or flat list of one directory. Hidden names and noisy directories are skipped.
 * @param {{ root: string, dir?: string, depth?: number, mode?: 'tree' | 'list', maxEntries?: number }} options
 * @returns {Promise<{ text: string, entries: Array<{ path: string, type: 'file' | 'dir' }>, truncated: boolean, rel: string }>}
 * @exports
 * @ai.hint io
 */
export async function readDirectory({ root, dir = '.', depth = 2, mode = 'tree', maxEntries = 400 }) {
    const { abs, rel } = await resolveInside(root, dir || '.', { allowRoot: true });
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`Каталог не найден: ${dir}`);
    if (!info.isDirectory()) throw new Error(`Не каталог: ${dir}`);
    const limit = Math.min(6, Math.max(1, depth || 2));
    const entries = [];
    let truncated = false;
    if (rel !== '.') entries.push({ path: rel, type: 'dir', level: 1 });
    /** One level of names. `level` is 1 at the first children of a `.` root. */
    async function walk(current, prefix, level) {
        if (truncated) return;
        let listed;
        try { listed = await readdir(current, { withFileTypes: true }); }
        catch { return; }
        listed.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (const entry of listed) {
            if (entry.name.startsWith('.') && entry.name !== '.github') continue;
            if (entries.length >= maxEntries) { truncated = true; return; }
            const child = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                entries.push({ path: child, type: 'dir', level });
                if (!NOISY_DIRS.test(entry.name) && level < limit) await walk(path.join(current, entry.name), child, level + 1);
            } else if (entry.isFile()) entries.push({ path: child, type: 'file', level });
        }
    }
    await walk(abs, rel === '.' ? '' : rel, rel === '.' ? 1 : 2);
    const lines = mode === 'list'
        ? entries.map((item) => item.type === 'dir' ? `${item.path}/` : item.path)
        : entries.map((item) => `${'  '.repeat(item.level - 1)}${item.path.split('/').at(-1)}${item.type === 'dir' ? '/' : ''}`);
    const text = `${lines.join('\n') || '(пусто)'}${truncated ? `\n…список усечён (${maxEntries} записей)` : ''}`;
    return { text, entries: entries.map(({ path: itemPath, type }) => ({ path: itemPath, type })), truncated, rel };
}

/**
 * Put a directory tree or flat list into the handoff.
 * @param {{ root: string, state: object, file: string, depth?: number, mode?: 'tree' | 'list' }} options
 * @returns {Promise<object | null>}
 * @exports
 * @ai.hint io
 */
export async function seedDirectory({ root, state, file, depth = 2, mode = 'tree' }) {
    let listing;
    try { listing = await readDirectory({ root, dir: file || '.', depth, mode }); }
    catch { return null; }
    const artifact = await writeArtifact(root, state, {
        body: listing.text, origin: listing.rel === '.' ? '.' : listing.rel, hintPath: listing.rel, hintLanguage: mode, entries: listing.entries,
    });
    const block = renderArtifactRef(artifact, listing.text);
    state.text = state.text ? `${state.text}\n\n${block}` : block;
    await saveHandoff(root, state);
    return artifact;
}
