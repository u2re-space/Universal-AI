/**
 * @file src/util/toon-decode.js
 * @module util/toon-decode
 * @purpose Decode a TOON subset or a JSON document.
 * @depends util/toon-shared
 * @usedBy util/toon, interact/batch
 * @exports decodeDocument
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Split from util/toon.js. Table rows stay at indent + 2 spaces.
 */
import { NUMERIC, assign, fail } from './toon-shared.js';

/**
 * Read one JSON string that starts at `start`.
 * @param {string} text
 * @param {number} start
 * @returns {{ value: *, end: number }}
 * @ai.hint pure
 */
function readJsonString(text, start) {
    if (text[start] !== '"') throw fail('expected string');
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === '\\') {
            if (i + 1 >= text.length) throw fail('unterminated string');
            i += 2;
            continue;
        }
        if (text[i] === '"') {
            try {
                return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
            } catch {
                throw fail('invalid string');
            }
        }
        i += 1;
    }
    throw fail('unterminated string');
}

/**
 * Parse null, true, false, or a number. Anything else is returned as text.
 * @param {string} text
 * @returns {null|boolean|number|string}
 * @ai.hint pure
 */
function parseBare(text) {
    if (text === 'null') return null;
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (NUMERIC.test(text)) return Number(text);
    return text;
}

/**
 * Parse a quoted JSON string or a bare token. Extra characters after a quote are an error.
 * @param {string} text
 * @returns {null|boolean|number|string}
 * @ai.hint pure
 */
function parsePrimitive(text) {
    if (text.startsWith('"')) {
        const { value, end } = readJsonString(text, 0);
        if (end !== text.length) throw fail('trailing data');
        return value;
    }
    return parseBare(text);
}

/**
 * Split a comma-separated cell list. Commas inside quotes stay in the cell.
 * @param {string} text
 * @returns {Array<null|boolean|number|string>}
 * @ai.hint pure
 */
function parseCells(text) {
    if (text === '') return [];
    const cells = [];
    let i = 0;
    while (i <= text.length) {
        if (i < text.length && text[i] === '"') {
            const { value, end } = readJsonString(text, i);
            cells.push(value);
            i = end;
        } else {
            const comma = text.indexOf(',', i);
            const end = comma === -1 ? text.length : comma;
            cells.push(parseBare(text.slice(i, end)));
            i = end;
        }
        if (i === text.length) break;
        if (text[i] !== ',') throw fail('expected comma');
        i += 1;
        if (i === text.length) cells.push(parseBare(''));
    }
    return cells;
}

/**
 * Split a table field list. Empty names and duplicates are errors.
 * @param {string} text
 * @returns {string[]}
 * @ai.hint pure
 */
function parseFieldList(text) {
    if (text === '') return [];
    const fields = [];
    let i = 0;
    while (i <= text.length) {
        let name;
        if (i < text.length && text[i] === '"') {
            const parsed = readJsonString(text, i);
            if (typeof parsed.value !== 'string') throw fail('bad field');
            name = parsed.value;
            i = parsed.end;
        } else {
            const comma = text.indexOf(',', i);
            const end = comma === -1 ? text.length : comma;
            name = text.slice(i, end);
            i = end;
        }
        if (name === '' || fields.includes(name)) throw fail('bad field');
        fields.push(name);
        if (i === text.length) break;
        if (text[i] !== ',') throw fail('expected comma');
        i += 1;
        if (i === text.length) throw fail('bad field');
    }
    return fields;
}

/**
 * Index of the `}` that closes a field list, ignoring braces inside quotes.
 * @param {string} text
 * @returns {number}
 * @ai.hint pure
 */
function findClosingBrace(text) {
    let i = 1;
    while (i < text.length) {
        if (text[i] === '"') {
            i = readJsonString(text, i).end;
            continue;
        }
        if (text[i] === '}') return i;
        i += 1;
    }
    throw fail('unterminated field list');
}

/**
 * Parse a decimal array length. Leading zeros and non-integers are errors.
 * @param {string} text
 * @returns {number}
 * @ai.hint pure
 */
function parseLength(text) {
    if (!/^\d+$/.test(text)) throw fail('bad length');
    const length = Number(text);
    if (!Number.isSafeInteger(length) || String(length) !== text) throw fail('bad length');
    return length;
}

/**
 * Read a bare or quoted key and return the unmatched remainder of the line.
 * @param {string} text
 * @returns {{ key: string, rest: string }}
 * @ai.hint pure
 */
function parseKey(text) {
    if (text.startsWith('"')) {
        const parsed = readJsonString(text, 0);
        if (typeof parsed.value !== 'string') throw fail('bad key');
        return { key: parsed.value, rest: text.slice(parsed.end) };
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (!match) throw fail('bad key');
    return { key: match[0], rest: text.slice(match[0].length) };
}

/**
 * Classify one content line as an inline array, a table header, or a field.
 * @param {string} text
 * @returns {{ kind: string, key: string }}
 * @ai.hint pure
 */
function parseHeader(text) {
    const { key, rest } = parseKey(text);
    const array = /^\[(\d+)\]/.exec(rest);
    if (array) {
        const length = parseLength(array[1]);
        const after = rest.slice(array[0].length);
        if (after.startsWith('{')) {
            const end = findClosingBrace(after);
            const fields = parseFieldList(after.slice(1, end));
            if (!/^:\s*$/.test(after.slice(end + 1))) throw fail('expected table header');
            return { kind: 'tabular', key, length, fields };
        }
        if (after === ':') {
            if (length !== 0) throw fail('array length mismatch');
            return { kind: 'array', key, cells: [], length };
        }
        if (after.startsWith(': ')) {
            const cells = parseCells(after.slice(2));
            if (cells.length !== length) throw fail('array length mismatch');
            return { kind: 'array', key, cells, length };
        }
        throw fail('expected colon');
    }
    if (rest === ':') return { kind: 'field', key, rawValue: null };
    if (rest.startsWith(': ')) return { kind: 'field', key, rawValue: rest.slice(2) };
    throw fail('expected colon');
}

/**
 * True for a blank line or a `#` comment.
 * @param {string} line
 * @returns {boolean}
 * @ai.hint pure
 */
function isIgnorable(line) {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('#');
}

/**
 * Count leading spaces. A tab is an error.
 * @param {string} line
 * @returns {number}
 * @ai.hint pure
 */
function lineIndent(line) {
    let i = 0;
    while (line[i] === ' ') i += 1;
    if (line[i] === '\t') throw fail('bad indent');
    return i;
}

/**
 * Index of the next line that is not blank or a comment, or `end` when none remains.
 * @param {string[]} lines
 * @param {number} index
 * @param {number} end
 * @returns {number}
 * @ai.hint pure
 */
function nextContent(lines, index, end) {
    let i = index;
    while (i < end && isIgnorable(lines[i])) i += 1;
    return i;
}

/**
 * First line at or after `start` whose indent is below `minIndent`. Blanks and comments are skipped.
 * @param {string[]} lines
 * @param {number} start
 * @param {number} minIndent
 * @returns {number}
 * @ai.hint pure
 */
function blockEnd(lines, start, minIndent) {
    let i = start;
    while (i < lines.length) {
        if (isIgnorable(lines[i])) {
            i += 1;
            continue;
        }
        if (lineIndent(lines[i]) < minIndent) break;
        i += 1;
    }
    return i;
}

/**
 * Build one table row. The cell count must match `fields`.
 * @param {string} text
 * @param {string[]} fields
 * @returns {object}
 * @ai.hint pure
 */
function parseRow(text, fields) {
    const cells = parseCells(text);
    if (cells.length !== fields.length) throw fail('row width mismatch');
    const row = {};
    for (let i = 0; i < fields.length; i++) assign(row, fields[i], cells[i]);
    return row;
}

/**
 * Parse one object from `lines` in `[start, end)` at a fixed indent. Nested objects sit two spaces deeper.
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @param {number} indent
 * @returns {object}
 * @ai.hint pure
 */
function parseObject(lines, start, end, indent) {
    const obj = {};
    let i = start;
    while (i < end) {
        if (isIgnorable(lines[i])) {
            i += 1;
            continue;
        }
        if (lineIndent(lines[i]) !== indent) throw fail('unexpected indent');
        const parsed = parseHeader(lines[i].slice(indent));
        if (parsed.kind === 'array') {
            assign(obj, parsed.key, parsed.cells);
            i += 1;
            continue;
        }
        if (parsed.kind === 'tabular') {
            const rows = [];
            let cursor = i + 1;
            const prefix = ' '.repeat(indent + 2);
            for (let r = 0; r < parsed.length; r++) {
                cursor = nextContent(lines, cursor, end);
                if (cursor >= end || !lines[cursor].startsWith(prefix)) throw fail('missing table row');
                rows.push(parseRow(lines[cursor].slice(prefix.length), parsed.fields));
                cursor += 1;
            }
            assign(obj, parsed.key, rows);
            i = cursor;
            continue;
        }
        if (parsed.rawValue === null) {
            const next = nextContent(lines, i + 1, end);
            if (next < end && lineIndent(lines[next]) > indent) {
                if (lineIndent(lines[next]) !== indent + 2) throw fail('unexpected indent');
                const childEnd = blockEnd(lines, next, indent + 2);
                assign(obj, parsed.key, parseObject(lines, next, childEnd, indent + 2));
                i = childEnd;
            } else {
                assign(obj, parsed.key, {});
                i += 1;
            }
            continue;
        }
        const next = nextContent(lines, i + 1, end);
        if (next < end && lineIndent(lines[next]) > indent) throw fail('unexpected indent');
        assign(obj, parsed.key, parsePrimitive(parsed.rawValue));
        i += 1;
    }
    return obj;
}

/**
 * Parse a TOON document into one plain object.
 * @param {string} text
 * @returns {object}
 * @ai.hint pure
 */
function decodeToon(text) {
    const lines = text.split(/\r?\n/);
    return parseObject(lines, 0, lines.length, 0);
}

/**
 * Parse JSON when the trimmed text starts with `{` or `[`. Otherwise parse TOON.
 * @param {string} text
 * @returns {*}
 * @exports
 * @ai.hint pure
 */
export function decodeDocument(text) {
    if (typeof text !== 'string') throw fail('expected a string');
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    return decodeToon(trimmed);
}
