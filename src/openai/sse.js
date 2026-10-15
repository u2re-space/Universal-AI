import { ApiError } from './errors.js';

const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Bounded Server-Sent Events parser over an async iterable of byte chunks.
 * Handles split UTF-8 sequences, CR / LF / CRLF line endings, comments, multiple `data:` lines
 * and a final event without a trailing blank line. Yields parsed JSON events; the literal
 * `[DONE]` sentinel is yielded as `{ type: '__done' }`.
 */
export async function* parseSSE(source, {
    maxEventBytes = 16 * 1024 * 1024, maxStreamBytes = 512 * 1024 * 1024, maxEvents = 1_000_000,
} = {}) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let streamBytes = 0, events = 0, eventBytes = 0;
    let line = '', lineBytes = 0, skipLF = false;
    let dataLines = [], eventName = '';

    const fail = (message, code = 'INVALID_SSE') => { throw new ApiError(message, { code }); };

    function append(fragment) {
        lineBytes += byteLength(fragment);
        if (lineBytes + eventBytes > maxEventBytes) fail('SSE-событие превышает лимит размера.', 'EVENT_LIMIT');
        line += fragment;
    }
    function dispatch() {
        const data = dataLines.length ? dataLines.join('\n') : null;
        const name = eventName;
        dataLines = []; eventName = ''; eventBytes = 0;
        if (data === null) return null;
        if (++events > maxEvents) fail('Слишком много SSE-событий.', 'EVENT_COUNT_LIMIT');
        if (data.trim() === '[DONE]') return { type: '__done' };
        let event;
        try { event = JSON.parse(data); } catch { fail('SSE data не является корректным JSON.'); }
        if (!isRecord(event) || typeof event.type !== 'string' || !event.type) fail('SSE-событие без поля type.');
        if (name && name !== 'message' && name !== event.type) fail('Имя SSE-события не совпадает с JSON type.');
        return event;
    }
    function endLine() {
        const current = line;
        eventBytes += lineBytes + 1;
        line = ''; lineBytes = 0;
        if (eventBytes > maxEventBytes) fail('SSE-событие превышает лимит размера.', 'EVENT_LIMIT');
        if (current === '') return dispatch();
        if (current.startsWith(':')) return null;
        const colon = current.indexOf(':');
        const field = colon < 0 ? current : current.slice(0, colon);
        let value = colon < 0 ? '' : current.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
        else if (field === 'event') eventName = value;
        return null;
    }
    function* consume(text) {
        let start = 0;
        if (skipLF && text.length) { if (text[0] === '\n') start = 1; skipLF = false; }
        const separators = /[\r\n]/g;
        separators.lastIndex = start;
        let match;
        while ((match = separators.exec(text))) {
            const index = match.index;
            append(text.slice(start, index));
            const event = endLine();
            if (event) yield event;
            start = index + 1;
            if (text[index] === '\r') {
                if (text[start] === '\n') { start++; separators.lastIndex = start; }
                else if (start === text.length) skipLF = true;
            }
        }
        append(text.slice(start));
    }

    for await (const chunk of source) {
        streamBytes += chunk.byteLength;
        if (streamBytes > maxStreamBytes) fail('SSE-поток превышает лимит размера.', 'RESPONSE_LIMIT');
        yield* consume(decoder.decode(chunk, { stream: true }));
    }
    yield* consume(decoder.decode());
    if (line.length) { const event = endLine(); if (event) yield event; }
    const last = dispatch();
    if (last) yield last;
}
