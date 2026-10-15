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

/**
 * Build a TOON error. Callers throw it.
 * @param {string} message
 * @returns {Error}
 * @exports
 * @ai.hint pure
 */
export function fail(message) {
    return new Error(`TOON: ${message}`);
}

/**
 * True for ordinary objects and `Object.create(null)`. Arrays and class instances are false.
 * @param {*} value
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Define an enumerable property. A second write of the same key throws.
 * @param {object} target
 * @param {string} key
 * @param {*} value
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function assign(target, key, value) {
    if (Object.hasOwn(target, key)) throw fail('duplicate key');
    Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
    });
}
