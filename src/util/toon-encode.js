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

function encodeKey(key) {
    return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

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

function assertDense(items) {
    for (let i = 0; i < items.length; i++) {
        if (!Object.hasOwn(items, i)) throw fail('sparse array');
    }
}

function isTabular(items) {
    if (!items.every(isPlainObject)) return false;
    const fields = Object.keys(items[0]);
    return items.every((item) => {
        const keys = Object.keys(item);
        if (keys.length !== fields.length) return false;
        return keys.every((key, index) => key === fields[index] && isPrimitiveCell(item[key]));
    });
}

function isPrimitiveCell(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    return typeof value === 'number' && Number.isFinite(value);
}

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

export function encodeToon(value) {
    if (!isPlainObject(value)) throw fail('expected a plain object');
    return `${encodeObject(value, 0).join('\n')}\n`;
}
