/**
 * @file src/util/toon-encode.js
 * @module util/toon-encode
 * @purpose Encode a plain object as a TOON subset. Nested objects use 2-space indent in the output, not the source indent.
 * @depends util/toon-shared
 * @usedBy util/toon, interact/batch
 * @exports encodeToon
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Split from util/toon.js.
 */
import { BARE_STRING, IDENTIFIER, NUMERIC, fail, isPlainObject } from './toon-shared.js';

/**
 * Leave identifier keys bare. Quote anything else as JSON.
 * @param {string} key
 * @returns {string}
 * @ai.hint pure
 */
function encodeKey(key) {
    return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/**
 * Encode null, a boolean, a finite number, or a string. Safe bare tokens stay unquoted.
 * @param {null|boolean|number|string} value
 * @returns {string}
 * @ai.hint pure
 */
function encodePrimitive(value) {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw fail('non-finite number');
        return String(value);
    }
    if (typeof value === 'string') {
        const reserved = value === 'true' || value === 'false' || value === 'null';
        // decodeDocument trims the document, so a bare token at either edge would lose spaces.
        if (BARE_STRING.test(value) && !reserved && !NUMERIC.test(value) && value === value.trim()) return value;
        return JSON.stringify(value);
    }
    throw fail('unsupported value');
}

/**
 * Reject holes. A sparse array cannot be written as a length-prefixed list.
 * @param {Array} items
 * @returns {void}
 * @ai.hint pure
 */
function assertDense(items) {
    for (let i = 0; i < items.length; i++) {
        if (!Object.hasOwn(items, i)) throw fail('sparse array');
    }
}

/**
 * True when every item has the same keys, in the same order, and every cell is primitive.
 * @param {Array} items
 * @returns {boolean}
 * @ai.hint pure
 */
function isTabular(items) {
    if (!items.every(isPlainObject)) return false;
    const fields = Object.keys(items[0]);
    return items.every((item) => {
        const keys = Object.keys(item);
        if (keys.length !== fields.length) return false;
        return keys.every((key, index) => key === fields[index] && isPrimitiveCell(item[key]));
    });
}

/**
 * True for null, string, boolean, or a finite number.
 * @param {*} value
 * @returns {boolean}
 * @ai.hint pure
 */
function isPrimitiveCell(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Write a dense array as an inline list, or as a table when every row shares primitive fields.
 * Row indent is two spaces past `indent`.
 * @param {string} key
 * @param {Array} items
 * @param {number} indent
 * @returns {string[]}
 * @ai.hint pure
 */
function encodeArray(key, items, indent) {
    assertDense(items);
    if (items.some((item) => isPlainObject(item) && Object.getOwnPropertySymbols(item).length > 0)) {
        throw fail('unsupported value');
    }
    const pad = ' '.repeat(indent);
    const primitive = items.every((item) => (
        item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number'
    ));
    if (items.length === 0 || primitive) {
        const body = items.map((item) => encodePrimitive(item)).join(',');
        return [`${pad}${key}[${items.length}]${body === '' ? ':' : `: ${body}`}`];
    }
    if (!isTabular(items)) throw fail('non-uniform array');
    const fields = Object.keys(items[0]);
    if (fields.length === 0) throw fail('unsupported value');
    const header = `${pad}${key}[${items.length}]{${fields.map(encodeKey).join(',')}}:`;
    const rows = items.map((item) => {
        const cells = fields.map((field) => encodePrimitive(item[field])).join(',');
        return `${pad}  ${cells}`;
    });
    return [header, ...rows];
}

/**
 * Write object fields at `indent`. Nested objects are indented two more spaces.
 * @param {object} value
 * @param {number} indent
 * @returns {string[]}
 * @ai.hint pure
 */
function encodeObject(value, indent) {
    if (Object.getOwnPropertySymbols(value).length > 0) throw fail('unsupported value');
    const pad = ' '.repeat(indent);
    const lines = [];
    for (const [key, item] of Object.entries(value)) {
        const encodedKey = encodeKey(key);
        if (Array.isArray(item)) {
            lines.push(...encodeArray(encodedKey, item, indent));
        } else if (isPlainObject(item)) {
            lines.push(`${pad}${encodedKey}:`);
            lines.push(...encodeObject(item, indent + 2));
        } else {
            lines.push(`${pad}${encodedKey}: ${encodePrimitive(item)}`);
        }
    }
    return lines;
}

/**
 * Encode a plain object as one TOON document with a trailing newline.
 * @param {object} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function encodeToon(value) {
    if (!isPlainObject(value)) throw fail('expected a plain object');
    return `${encodeObject(value, 0).join('\n')}\n`;
}
