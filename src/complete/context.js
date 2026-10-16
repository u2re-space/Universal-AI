/**
 * @file src/complete/context.js
 * @module complete/context
 * @purpose Build a fixed completion window around the cursor. The rest of the file is not added on later requests.
 * @depends node:fs, complete/errors
 * @usedBy complete/complete, test/complete.test.js
 * @exports MAX_LINE_BYTES, formatCompletionProblems, formatCompletionTree, buildCompletionContext, readCompletionWindow
 * @ai.tags complete, context
 * @ai.hint pure
 * @changed 2026-10-15 Tab completion sends only the lines around the cursor.
 */

import { createReadStream } from 'node:fs';
import { CompletionError } from './errors.js';

/** 0.5 MiB. A longer line (often base64) is not sent to the model. */
export const MAX_LINE_BYTES = 512 * 1024;

/**
 * Drop a leading BOM and turn CR LF / CR into LF.
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function normalize(text) {
    return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Cursor position as 0-based UTF-16 indexes, matching an LSP Position.
 * @param {object|null|undefined} value
 * @param {string} what Name used in the error.
 * @returns {{ line: number, character: number }|null}
 * @ai.hint pure
 */
function readPosition(value, what) {
    if (value == null) return null;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new CompletionError(`${what} должен быть объектом { line, character }.`);
    }
    const line = value.line;
    const character = value.character ?? value.column ?? 0;
    if (!Number.isSafeInteger(line) || line < 0) throw new CompletionError(`${what}.line — целое ≥ 0.`);
    if (!Number.isSafeInteger(character) || character < 0) throw new CompletionError(`${what}.character — целое ≥ 0.`);
    return { line, character };
}

/**
 * LSP range. An inverted range is swapped so the start is the insertion point.
 * @param {object|null|undefined} value
 * @returns {{ start: { line: number, character: number }, end: { line: number, character: number } }|null}
 * @ai.hint pure
 */
function readSelection(value) {
    if (value == null) return null;
    const start = readPosition(value.start, 'selection.start');
    const end = readPosition(value.end, 'selection.end');
    if (!start || !end) throw new CompletionError('selection.start и selection.end обязательны.');
    const endFirst = end.line < start.line || (end.line === start.line && end.character < start.character);
    return endFirst ? { start: end, end: start } : { start, end };
}

/**
 * Byte offset of a position. The position is clamped to the text.
 * @param {string} text Normalized text.
 * @param {{ line: number, character: number }} position
 * @returns {number}
 * @ai.hint pure
 */
function positionToOffset(text, position) {
    const lines = text.split('\n');
    const line = Math.min(Math.max(position.line, 0), lines.length - 1);
    let offset = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    const character = Math.min(Math.max(position.character, 0), lines[line].length);
    return offset + character;
}

/**
 * Position of a byte-free string offset (UTF-16), clamped to the text.
 * @param {string} text
 * @param {number} offset
 * @returns {{ line: number, character: number }}
 * @ai.hint pure
 */
function offsetToPosition(text, offset) {
    const clamped = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let character = 0;
    for (let i = 0; i < clamped; i++) {
        if (text[i] === '\n') { line++; character = 0; }
        else character++;
    }
    return { line, character };
}

/**
 * Clamp a cursor so it lands on an existing line.
 * @param {string} text
 * @param {{ line: number, character: number }} cursor
 * @returns {{ line: number, character: number }}
 * @ai.hint pure
 */
function clampCursor(text, cursor) {
    return offsetToPosition(text, positionToOffset(text, cursor));
}

/**
 * Turn source text into the string the model sees, with the cursor on that string.
 * Prefix/suffix win over coordinates. Coordinates win over a `|` marker.
 * @param {object} input
 * @returns {{ text: string, cursor: { line: number, character: number }, replaced: string|null }}
 * @ai.hint pure
 */
function resolveText(input) {
    const prefix = typeof input.prefix === 'string' ? input.prefix : null;
    const suffix = typeof input.suffix === 'string' ? input.suffix : null;
    if (prefix !== null || suffix !== null) {
        const head = normalize(prefix ?? '');
        const tail = normalize(suffix ?? '');
        return { text: head + tail, cursor: offsetToPosition(head, head.length), replaced: null };
    }
    const content = typeof input.content === 'string' ? normalize(input.content) : null;
    if (content === null) throw new CompletionError('Нужен content, prefix или path к файлу.');
    const selection = readSelection(input.selection);
    if (selection) {
        const start = positionToOffset(content, selection.start);
        const end = positionToOffset(content, selection.end);
        const selected = content.slice(start, end);
        const text = content.slice(0, start) + content.slice(end);
        const replaced = selected && Buffer.byteLength(selected, 'utf8') <= (input.maxLineBytes ?? MAX_LINE_BYTES) ? selected : null;
        return { text, cursor: clampCursor(text, selection.start), replaced: replaced && replaced.length ? replaced : null };
    }
    const cursor = readPosition(input.cursor, 'cursor');
    if (cursor) return { text: content, cursor: clampCursor(content, cursor), replaced: null };
    const at = content.indexOf('|');
    if (at >= 0) {
        const head = content.slice(0, at);
        return { text: head + content.slice(at + 1), cursor: offsetToPosition(head, head.length), replaced: null };
    }
    return { text: content, cursor: offsetToPosition(content, content.length), replaced: null };
}

/**
 * Split text into lines. A line over the byte cap, or listed in omitLines, is not kept.
 * @param {string} text
 * @param {number} maxLineBytes
 * @param {number[]} [omitLines] Indexes in this text whose original bytes were already discarded.
 * @returns {{ number: number, text: string, bytes: number, omitted: boolean }[]}
 * @ai.hint pure
 */
function classifyLines(text, maxLineBytes, omitLines = []) {
    const omit = new Set(omitLines);
    return text.split('\n').map((line, number) => {
        const bytes = Buffer.byteLength(line, 'utf8');
        if (omit.has(number) || bytes > maxLineBytes) return { number, text: '', bytes, omitted: true };
        return { number, text: line, bytes, omitted: false };
    });
}

/**
 * One visible line, or a short stand-in when the source line was too large.
 * @param {{ number: number, text: string, bytes: number, omitted: boolean }} line
 * @param {number} startLine Absolute index of line 0 in this window.
 * @returns {string}
 * @ai.hint pure
 */
function visibleLine(line, startLine) {
    if (!line.omitted) return line.text;
    const absolute = line.number + startLine + 1;
    return line.bytes > 0 ? `[line ${absolute} omitted, ${line.bytes} bytes]` : `[line ${absolute} omitted]`;
}

function clipPlain(text) {
    if (text.length <= 180) return text;
    return `[long line, ${text.length} chars]`;
}

/**
 * Keep the cursor visible and drop the opaque tails of a very long line.
 * @param {string} text
 * @param {number} at
 * @returns {string}
 * @ai.hint pure
 */
function clipCursor(text, at) {
    const character = Math.min(Math.max(at, 0), text.length);
    const marked = text.slice(0, character) + '|' + text.slice(character);
    if (marked.length <= 180) return marked;
    const start = Math.max(0, character - 80);
    const end = Math.min(text.length, character + 80);
    const head = start > 0 ? '…' : '';
    const tail = end < text.length ? '…' : '';
    return head + text.slice(start, character) + '|' + text.slice(character, end) + tail;
}

/**
 * Nearest lines around the cursor, with `|` at the insertion point.
 * @param {object[]} lines
 * @param {{ line: number, character: number }} cursor
 * @param {number} neighborLines
 * @param {number} startLine
 * @returns {{ focus: string, focusStart: number, focusEnd: number }}
 * @ai.hint pure
 */
function renderFocus(lines, cursor, neighborLines, startLine) {
    const cursorLine = Math.min(cursor.line, Math.max(0, lines.length - 1));
    if (lines[cursorLine]?.omitted) {
        let above = cursorLine - 1;
        while (above >= 0 && lines[above].omitted) above--;
        let below = cursorLine + 1;
        while (below < lines.length && lines[below].omitted) below++;
        const rows = [];
        if (above >= 0) rows.push(clipPlain(lines[above].text));
        rows.push('|');
        if (below < lines.length) rows.push(clipPlain(lines[below].text));
        return {
            focus: rows.join('\n'),
            focusStart: above >= 0 ? above : cursorLine,
            focusEnd: below < lines.length ? below : cursorLine,
        };
    }
    const focusStart = Math.max(0, cursorLine - neighborLines);
    const focusEnd = Math.min(lines.length - 1, cursorLine + neighborLines);
    const rows = [];
    for (let i = focusStart; i <= focusEnd; i++) {
        if (lines[i].omitted) rows.push(visibleLine(lines[i], startLine));
        else if (i === cursorLine) rows.push(clipCursor(lines[i].text, cursor.character));
        else rows.push(clipPlain(lines[i].text));
    }
    return { focus: rows.join('\n'), focusStart, focusEnd };
}

/**
 * File text outside the focus is not sent. A later keystroke does not add more of the file.
 * @param {number} focusStart
 * @param {number} focusEnd
 * @param {number} lineCount
 * @returns {{ excerpt: string, truncated: boolean }}
 * @ai.hint pure
 */
function windowOnly(focusStart, focusEnd, lineCount) {
    const covered = Math.max(0, focusEnd - focusStart + 1);
    return { excerpt: '', truncated: covered < lineCount };
}

/**
 * Instructions-facing prompt. The model is told to answer with the insertion only.
 * @param {object} built
 * @returns {string}
 * @ai.hint pure
 */
const PROBLEM_SEVERITY = new Set(['error', 'warning', 'info', 'hint']);

/**
 * One diagnostics list for the focused file. Lines are 0-based, matching the editor.
 * @param {unknown} items
 * @param {{ max?: number }} [options]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatCompletionProblems(items, { max = 24 } = {}) {
    const rows = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object' || typeof item.message !== 'string' || !item.message.trim()) continue;
        const line = Number.isSafeInteger(item.line) ? item.line + 1 : '?';
        const character = Number.isSafeInteger(item.character) ? item.character + 1 : 1;
        const severity = PROBLEM_SEVERITY.has(item.severity) ? item.severity : 'info';
        const source = typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'check';
        const message = item.message.trim().replace(/\s+/g, ' ').slice(0, 180);
        rows.push(`L${line}:C${character} ${severity} ${source}: ${message}`);
        if (rows.length >= max) break;
    }
    return rows.join('\n');
}

/**
 * A workspace tree. `node_modules` and `.git` are left out. A directory with too many
 * names keeps the first `maxPerDirectory` and counts the rest.
 * @param {unknown} paths Relative file paths.
 * @param {{ maxPerDirectory?: number, maxEntries?: number }} [options]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatCompletionTree(paths, { maxPerDirectory = 40, maxEntries = 200 } = {}) {
    const root = { dirs: new Map(), files: [] };
    let kept = 0;
    for (const raw of Array.isArray(paths) ? paths : []) {
        if (typeof raw !== 'string' || kept >= maxEntries) continue;
        const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
        const parts = rel.split('/').filter(Boolean);
        if (!parts.length || parts.some((part) => part === 'node_modules' || part === '.git')) continue;
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
            node = node.dirs.get(parts[i]);
        }
        node.files.push(parts[parts.length - 1]);
        kept++;
    }
    /**
     * @param {{ dirs: Map<string, { dirs: Map, files: string[] }>, files: string[] }} node
     * @param {string} indent
     * @returns {string[]}
     * @ai.hint pure
     */
    const render = (node, indent) => {
        const lines = [];
        for (const name of [...node.dirs.keys()].sort()) {
            lines.push(`${indent}${name}/`);
            lines.push(...render(node.dirs.get(name), `${indent}  `));
        }
        const files = [...node.files].sort();
        for (const file of files.slice(0, maxPerDirectory)) lines.push(`${indent}${file}`);
        if (files.length > maxPerDirectory) lines.push(`${indent}… (${files.length - maxPerDirectory} more)`);
        return lines;
    };
    return render(root, '').join('\n');
}

function renderPrompt(built) {
    const rows = [];
    rows.push(built.path ? `Focused file: ${built.path}` : 'Focused file:');
    if (built.language) rows.push(`Language: ${built.language}`);
    rows.push(`Cursor: line ${built.cursorLine + 1}, character ${built.cursorCharacter + 1}.`);
    rows.push('The | marks the cursor in this file. Code before | and code after | are already in the buffer.');
    if (built.cursorLineOmitted) rows.push('The cursor line is omitted because it is larger than 0.5 MiB. Insert at the | between the nearest lines.');
    if (built.truncated) rows.push('Only the lines around the cursor are shown.');
    if (built.omittedLines.length) {
        const shown = built.omittedLines.slice(0, 20).map((n) => n + 1).join(', ');
        const more = built.omittedLines.length > 20 ? ` (+${built.omittedLines.length - 20} more)` : '';
        rows.push(`Oversized lines omitted: ${shown}${more}.`);
    }
    if (built.replaced) {
        const clip = built.replaced.length > 200 ? `${built.replaced.slice(0, 200)}…` : built.replaced;
        rows.push(`Replace this selection: ${clip}`);
    }
    rows.push('', built.focus);
    const problems = formatCompletionProblems(built.problems);
    if (problems) rows.push('', 'Problems (syntax and lint):', problems);
    const validation = formatCompletionProblems(built.validation);
    if (validation && validation !== problems) rows.push('', 'Validation:', validation);
    const tree = formatCompletionTree(built.files);
    if (tree) rows.push('', 'Workspace files:', tree);
    return rows.join('\n');
}

/**
 * Shorten a file to the lines around the cursor and mark the insertion point with `|`.
 * Positions are 0-based. A line over maxLineBytes is omitted. Lines outside the window are not sent,
 * so a longer file does not make the next completion request larger.
 * @param {object} input content or prefix/suffix, optional cursor, selection, path, language, and limits.
 * @returns {object} Prompt fields: focus, excerpt, prompt, omittedLines, truncated, cursorLineOmitted.
 * @exports
 * @ai.hint pure
 */
export function buildCompletionContext(input = {}) {
    const maxLineBytes = input.maxLineBytes ?? MAX_LINE_BYTES;
    const neighborLines = input.neighborLines ?? 16;
    const startLine = input.startLine ?? 0;
    const { text, cursor, replaced } = resolveText({ ...input, maxLineBytes });
    const lines = classifyLines(text, maxLineBytes, input.omitLines ?? []);
    const cursorLine = Math.min(cursor.line, Math.max(0, lines.length - 1));
    const { focus, focusStart, focusEnd } = renderFocus(lines, { ...cursor, line: cursorLine }, neighborLines, startLine);
    const { excerpt, truncated } = windowOnly(focusStart, focusEnd, lines.length);
    const cursorEntry = lines[cursorLine];
    const rest = cursorEntry && !cursorEntry.omitted ? cursorEntry.text.slice(Math.min(cursor.character, cursorEntry.text.length)) : '';
    const nextEntry = lines[cursorLine + 1];
    const following = nextEntry && !nextEntry.omitted ? nextEntry.text : '';
    const afterCursor = following ? `${rest}\n${following}` : rest;
    const omittedLines = lines
        .filter((line) => line.omitted && line.number >= focusStart && line.number <= focusEnd)
        .map((line) => line.number + startLine);
    const built = {
        path: typeof input.path === 'string' && input.path.trim() ? input.path : null,
        language: typeof input.language === 'string' && input.language.trim() ? input.language : null,
        focus,
        excerpt,
        omittedLines,
        truncated,
        cursorLineOmitted: Boolean(lines[cursorLine]?.omitted),
        cursorLine: cursorLine + startLine,
        cursorCharacter: cursor.character,
        replaced,
        startLine,
        afterCursor,
        problems: input.problems,
        validation: input.validation,
        files: input.files,
    };
    built.prompt = renderPrompt(built);
    return built;
}

/**
 * Walk a file line by line. A line over maxLineBytes is discarded as soon as it exceeds the cap.
 * `onLine(text, omitted)` returns false to stop.
 * @param {string} abs Absolute path.
 * @param {number} maxLineBytes
 * @param {(text: string|null, omitted: boolean) => boolean|void} onLine
 * @returns {Promise<void>}
 * @ai.hint io
 */
function forEachFileLine(abs, maxLineBytes, onLine) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(abs);
        let acc = Buffer.alloc(0);
        let skipping = false;
        let trailingNewline = false;
        let settled = false;
        let stop = false;

        /**
         * Resolve once. After a requested stop, a destroy error is ignored.
         * @param {Error|undefined} error
         * @returns {void}
         * @ai.hint io
         */
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error && !stop) reject(error);
            else resolve();
        };
        /**
         * Hand one line to the caller. False stops the stream.
         * @param {string|null} text Null when the line was too large to keep.
         * @param {boolean} omitted
         * @returns {void}
         * @ai.hint io
         */
        const emit = (text, omitted) => {
            if (stop) return;
            if (onLine(text, omitted) === false) {
                stop = true;
                stream.destroy();
            }
        };
        /**
         * Pull complete lines out of the accumulator. A remainder over the cap starts a skip.
         * @returns {void}
         * @ai.hint io
         */
        const takeLines = () => {
            let nl = acc.indexOf(0x0a);
            while (nl !== -1) {
                let row = acc.subarray(0, nl);
                acc = acc.subarray(nl + 1);
                if (row.length && row[row.length - 1] === 0x0d) row = row.subarray(0, row.length - 1);
                trailingNewline = true;
                if (skipping || row.length > maxLineBytes) emit(null, true);
                else emit(row.toString('utf8'), false);
                skipping = false;
                if (stop) return;
                nl = acc.indexOf(0x0a);
            }
            if (acc.length > 0) trailingNewline = false;
            if (stop) return;
            if (skipping) { acc = Buffer.alloc(0); return; }
            if (acc.length > maxLineBytes) { skipping = true; acc = Buffer.alloc(0); }
        };

        stream.on('data', (chunk) => {
            if (stop) return;
            if (skipping) {
                const nl = chunk.indexOf(0x0a);
                if (nl === -1) return;
                skipping = false;
                trailingNewline = true;
                emit(null, true);
                if (stop) return;
                const rest = chunk.subarray(nl + 1);
                acc = rest.length ? Buffer.from(rest) : Buffer.alloc(0);
                takeLines();
                return;
            }
            acc = acc.length ? Buffer.concat([acc, chunk]) : Buffer.from(chunk);
            takeLines();
        });
        stream.on('end', () => {
            if (stop) return finish();
            if (skipping || acc.length > maxLineBytes) emit(null, true);
            else if (acc.length > 0) emit(acc.toString('utf8'), false);
            else emit('', false);
            finish();
        });
        stream.on('error', (error) => finish(stop ? undefined : error));
        stream.on('close', () => { if (stop) finish(); });
    });
}

/**
 * Read a window around `cursorLine` from a large file without keeping an oversized line.
 * @param {string} abs Absolute file path.
 * @param {{ cursorLine?: number, maxLineBytes: number, maxContextBytes: number }} options
 * @returns {Promise<{ text: string, omittedLines: number[], startLine: number, cursorLine: number }>}
 * @exports
 * @ai.hint io
 */
export async function readCompletionWindow(abs, { cursorLine = 0, maxLineBytes, maxContextBytes }) {
    const budget = Math.max(256, maxContextBytes);
    const before = [];
    let beforeBytes = 0;
    let lineNo = 0;
    /** @type {{ line: number, text: string, omitted: boolean }|null} */
    let cursorEntry = null;
    const after = [];
    let afterBytes = 0;

    await forEachFileLine(abs, maxLineBytes, (text, omitted) => {
        const entry = { line: lineNo, text: omitted ? '' : text, omitted, keepBytes: omitted ? 24 : Buffer.byteLength(text ?? '', 'utf8') + 1 };
        if (lineNo < cursorLine) {
            before.push(entry);
            beforeBytes += entry.keepBytes;
            while (before.length > 1 && beforeBytes > budget) {
                beforeBytes -= before[0].keepBytes;
                before.shift();
            }
        } else if (lineNo === cursorLine) cursorEntry = entry;
        else {
            if (after.length > 0 && afterBytes + entry.keepBytes > budget) return false;
            after.push(entry);
            afterBytes += entry.keepBytes;
            if (after.length >= 80) return false;
        }
        lineNo++;
        return true;
    });

    if (!cursorEntry) cursorEntry = before.pop() ?? { line: 0, text: '', omitted: false };
    const entries = [...before, cursorEntry, ...after];
    const startLine = entries[0]?.line ?? 0;
    return {
        text: entries.map((entry) => entry.text).join('\n'),
        omittedLines: entries.filter((entry) => entry.omitted).map((entry) => entry.line - startLine),
        startLine,
        cursorLine: cursorEntry.line - startLine,
    };
}
