/**
 * @file src/util/text.js
 * @module util/text
 * @purpose Small formatting and byte helpers shared across the CLI.
 * @usedBy commands, agent, ui, core, jobs/manager, interact/filesystem
 * @exports byteSize, isRecord, positiveInteger, formatNumber, formatBytes, formatDuration, formatUsd, truncate, clipMiddle, errorMessage, timestampSlug, deepMerge, estimateTokens
 * @ai.tags text, format
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

/**
 * UTF-8 byte length of a string, or of its JSON form.
 * @param {*} value
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export const byteSize = (value) =>
    Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8');

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Round a finite number and format it with en-US grouping. Non-finite values become an em dash.
 * @param {number} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatNumber(value) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US').format(Math.round(value));
}

/**
 * Format a byte count as B, KiB, or MiB. Non-finite values become an em dash.
 * @param {number} bytes
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Format a duration in milliseconds, seconds, mm:ss, or h:mm:ss.
 * @param {number} ms
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${(ms / 1000).toFixed(1)} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Format a USD amount. Values under one cent keep four decimal places.
 * @param {number} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatUsd(value) {
    if (!Number.isFinite(value)) return '—';
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/** Truncate a string to `max` characters, appending an ellipsis. Keeps single line if asked. */
export function truncate(text, max = 80, { singleLine = true } = {}) {
    let value = String(text ?? '');
    if (singleLine) value = value.replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Keep the head and tail of a long text, cutting the middle. Operates on UTF-8 bytes. */
export function clipMiddle(text, limit) {
    const data = Buffer.from(text ?? '', 'utf8');
    if (data.length <= limit) return data.toString('utf8');
    const half = Math.floor(limit / 2);
    const head = data.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '');
    const tail = data.subarray(data.length - half).toString('utf8').replace(/^\uFFFD+/, '');
    return `${head}\n…[пропущено ${formatBytes(data.length - 2 * half)}]…\n${tail}`;
}

/**
 * Message of an Error, or the value coerced to a string.
 * @param {*} error
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function errorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * Local timestamp as `YYYYMMDD-HHMMSS`, used in file names.
 * @param {Date} [date]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function timestampSlug(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Deep merge of plain objects; arrays and scalars are replaced. Rejects prototype keys. */
export function deepMerge(base, extra) {
    const result = structuredClone(base ?? {});
    if (!isRecord(extra)) return result;
    for (const [key, value] of Object.entries(extra)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
            throw new Error(`Запрещённый ключ конфигурации: ${key}`);
        }
        if (isRecord(value) && isRecord(result[key])) result[key] = deepMerge(result[key], value);
        else if (value !== undefined) result[key] = structuredClone(value);
    }
    return result;
}

/** Rough token estimate for budgeting before a request (about 4 bytes per token, conservative). */
export function estimateTokens(value) {
    return Math.ceil(byteSize(value) / 3.5);
}
