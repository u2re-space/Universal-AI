/**
 * @file src/util/toon-shared.js
 * @module util/toon-shared
 * @purpose Shared TOON errors, object checks, and token patterns.
 * @usedBy util/toon-encode, util/toon-decode
 * @exports fail, isPlainObject, assign, IDENTIFIER, BARE_STRING, NUMERIC
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Split from util/toon.js.
 */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const BARE_STRING = /^[A-Za-z0-9_. -]+$/;

export const NUMERIC = /^-?\d+(?:\.\d+)?$/;

export function fail(message) {
    return new Error(`TOON: ${message}`);
}

export function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function assign(target, key, value) {
    if (Object.hasOwn(target, key)) throw fail('duplicate key');
    Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
    });
}
