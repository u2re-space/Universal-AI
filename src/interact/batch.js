/** Parse a desktop batch and run each action after approval. `perform` is injected. */
import { decodeDocument } from '../util/toon.js';

const ACTION_TYPES = new Set(['screenshot', 'click', 'type', 'ahk']);
const CLICK_MODES = new Set(['coord', 'title', 'control', 'image']);
const BUTTONS = { left: 'Left', right: 'Right', middle: 'Middle' };

function fail(index, message) {
    throw new Error(`action ${index}: ${message}`);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function integerOrNull(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    return undefined;
}

function normalizeButton(value, index) {
    if (value == null || value === '') return 'Left';
    if (typeof value !== 'string') fail(index, 'button must be left, right, or middle');
    const mapped = BUTTONS[value.trim().toLowerCase()];
    if (!mapped) fail(index, 'button must be left, right, or middle');
    return mapped;
}

function normalizeClicks(value, index) {
    if (value == null || value === '') return 1;
    if (value === 1 || value === 2) return value;
    fail(index, 'clicks must be 1 or 2');
}

function optionalPoint(action, index) {
    const x = integerOrNull(action.x);
    const y = integerOrNull(action.y);
    if (x === undefined || y === undefined || (x == null) !== (y == null)) {
        fail(index, 'x and y must be integers or null');
    }
    return { x, y };
}

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

function normalizeType(action, index) {
    if (action.mode !== 'text' && action.mode !== 'keys') fail(index, 'type requires mode text or keys');
    const text = nonEmpty(action.text);
    if (!text) fail(index, 'type requires non-empty text');
    const result = blankAction('type');
    result.mode = action.mode;
    result.text = text;
    return result;
}

function normalizeAhk(action, index) {
    const script = nonEmpty(action.script);
    if (!script) fail(index, 'ahk requires a non-empty script');
    const result = blankAction('ahk');
    result.script = script;
    return result;
}

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
