/**
 * @file src/interact/batch.js
 * @module interact/batch
 * @purpose Parse a desktop action batch and run each action after approval.
 * @depends util/toon
 * @usedBy agent/desktop
 * @exports normalizeBatch, parseBatch, executeBatch
 * @ai.tags desktop, batch, validation
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

/** Parse a desktop batch and run each action after approval. `perform` is injected. */
import { decodeDocument } from '../util/toon.js';

const ACTION_TYPES = new Set(['screenshot', 'click', 'type', 'ahk']);
const CLICK_MODES = new Set(['coord', 'title', 'control', 'image']);
const BUTTONS = { left: 'Left', right: 'Right', middle: 'Middle' };

/**
 * Throw an Error whose text names the 1-based action index.
 * @param {number} index Action index shown in the message.
 * @param {string} message What failed the check.
 * @returns {never}
 * @ai.hint pure
 */
function fail(index, message) {
    throw new Error(`action ${index}: ${message}`);
}

/**
 * True when the value is a non-null object and not an array.
 * @param {unknown} value Field from a decoded batch document.
 * @returns {boolean}
 * @ai.hint pure
 */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalized action of the given type with every other field set to null.
 * @param {string} type screenshot, click, type, or ahk.
 * @returns {object}
 * @ai.hint pure
 */
function blankAction(type) {
    return {
        type,
        mode: null,
        x: null,
        y: null,
        button: null,
        clicks: null,
        text: null,
        title: null,
        control: null,
        image: null,
        script: null,
    };
}

/**
 * Return the string when it contains non-whitespace text, otherwise null.
 * @param {unknown} value Raw action field.
 * @returns {string | null}
 * @ai.hint pure
 */
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Return an integer, null when the field is empty, or undefined when it is not an integer.
 * @param {unknown} value Raw coordinate or count.
 * @returns {number | null | undefined}
 * @ai.hint pure
 */
function integerOrNull(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    return undefined;
}

/**
 * Map left, right, or middle to Left, Right, or Middle. An empty value becomes Left.
 * @param {unknown} value Raw button field.
 * @param {number} index Action index passed to fail.
 * @returns {string}
 * @ai.hint pure
 */
function normalizeButton(value, index) {
    if (value == null || value === '') return 'Left';
    if (typeof value !== 'string') fail(index, 'button must be left, right, or middle');
    const mapped = BUTTONS[value.trim().toLowerCase()];
    if (!mapped) fail(index, 'button must be left, right, or middle');
    return mapped;
}

/**
 * Keep a click count of 1 or 2. An empty value becomes 1.
 * @param {unknown} value Raw clicks field.
 * @param {number} index Action index passed to fail.
 * @returns {number}
 * @ai.hint pure
 */
function normalizeClicks(value, index) {
    if (value == null || value === '') return 1;
    if (value === 1 || value === 2) return value;
    fail(index, 'clicks must be 1 or 2');
}

/**
 * Read x and y when both are integers or both are empty.
 * @param {object} action Raw click action.
 * @param {number} index Action index passed to fail.
 * @returns {{ x: number | null, y: number | null }}
 * @ai.hint pure
 */
function optionalPoint(action, index) {
    const x = integerOrNull(action.x);
    const y = integerOrNull(action.y);
    if (x === undefined || y === undefined || (x == null) !== (y == null)) {
        fail(index, 'x and y must be integers or null');
    }
    return { x, y };
}

/**
 * Normalize a click whose mode is coord, title, control, or image.
 * @param {object} action Raw click action.
 * @param {number} index Action index passed to fail.
 * @returns {object}
 * @ai.hint pure
 */
function normalizeClick(action, index) {
    if (typeof action.mode !== 'string' || !CLICK_MODES.has(action.mode)) {
        fail(index, 'click mode must be coord, title, control, or image');
    }
    const result = blankAction('click');
    result.mode = action.mode;
    result.button = normalizeButton(action.button, index);
    result.clicks = normalizeClicks(action.clicks, index);
    if (action.mode === 'coord') {
        const x = integerOrNull(action.x);
        const y = integerOrNull(action.y);
        if (typeof x !== 'number' || typeof y !== 'number') fail(index, 'coord requires integer x and y');
        result.x = x;
        result.y = y;
        return result;
    }
    if (action.mode === 'title') {
        const title = nonEmpty(action.title);
        if (!title) fail(index, 'title mode requires title');
        const point = optionalPoint(action, index);
        result.title = title;
        result.x = point.x;
        result.y = point.y;
        return result;
    }
    if (action.mode === 'control') {
        const title = nonEmpty(action.title);
        const control = nonEmpty(action.control);
        if (!title || !control) fail(index, 'control mode requires title and control');
        result.title = title;
        result.control = control;
        return result;
    }
    const image = nonEmpty(action.image);
    if (!image) fail(index, 'image mode requires image');
    result.image = image;
    return result;
}

/**
 * Normalize a type action whose mode is text or keys and whose text is non-empty.
 * @param {object} action Raw type action.
 * @param {number} index Action index passed to fail.
 * @returns {object}
 * @ai.hint pure
 */
function normalizeType(action, index) {
    if (action.mode !== 'text' && action.mode !== 'keys') fail(index, 'type requires mode text or keys');
    const text = nonEmpty(action.text);
    if (!text) fail(index, 'type requires non-empty text');
    const result = blankAction('type');
    result.mode = action.mode;
    result.text = text;
    return result;
}

/**
 * Normalize an ahk action that carries a non-empty script.
 * @param {object} action Raw ahk action.
 * @param {number} index Action index passed to fail.
 * @returns {object}
 * @ai.hint pure
 */
function normalizeAhk(action, index) {
    const script = nonEmpty(action.script);
    if (!script) fail(index, 'ahk requires a non-empty script');
    const result = blankAction('ahk');
    result.script = script;
    return result;
}

/**
 * Build one normalized screenshot, click, type, or ahk action.
 * @param {unknown} action One entry from the actions array.
 * @param {number} index Action index passed to fail.
 * @returns {object}
 * @ai.hint pure
 */
function normalizeAction(action, index) {
    const type = isRecord(action) ? action.type : undefined;
    if (typeof type !== 'string' || !ACTION_TYPES.has(type)) {
        const name = typeof type === 'string' && type !== '' ? ` ${type}` : '';
        throw new Error(`action ${index}: unknown type${name}`);
    }
    if (type === 'screenshot') return blankAction('screenshot');
    if (type === 'click') return normalizeClick(action, index);
    if (type === 'type') return normalizeType(action, index);
    return normalizeAhk(action, index);
}

/** Check summary and actions, then map each action to the normalized shape. */
export function normalizeBatch(data) {
    if (!isRecord(data) || typeof data.summary !== 'string' || data.summary.trim() === '') {
        throw new Error('summary must be a non-empty string');
    }
    if (!Array.isArray(data.actions)) throw new Error('actions must be an array');
    return {
        summary: data.summary,
        actions: data.actions.map((action, offset) => normalizeAction(action, offset + 1)),
    };
}

/** Accept a JSON or TOON document and return a normalized batch. */
export function parseBatch(text) {
    return normalizeBatch(decodeDocument(text));
}

/**
 * Normalize, then approve and perform actions in order.
 * `false` from `approveAction` throws and does not call `perform` for that action.
 */
export async function executeBatch({ batch, perform, approveAction }) {
    const normalized = normalizeBatch(batch);
    const results = [];
    for (let index = 0; index < normalized.actions.length; index += 1) {
        const action = normalized.actions[index];
        if (typeof approveAction === 'function') {
            const allowed = await approveAction(action, index);
            if (allowed === false) throw new Error(`действие ${index + 1} отклонено`);
        }
        results.push(await perform(action));
    }
    return results;
}
