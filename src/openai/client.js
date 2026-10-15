/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose Responses API client on node:https: create, retrieve, cancel, compact, and count tokens.
 * @depends node:crypto, node:timers/promises, openai/errors, openai/http, openai/sse, openai/stream
 * @usedBy commands/shared
 * @exports ApiError, createClient
 * @ai.tags openai, http
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { createHttp, readBody } from './http.js';
import { parseSSE } from './sse.js';
import { createStreamReducer, outputText } from './stream.js';
import { encodeMultipart, generationBody, imagePayloads } from './images.js';

export { ApiError };

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const defaults = Object.freeze({
    baseURL: 'https://api.openai.com/v1/',
    retries: 2,
    maxErrorBytes: 64 * 1024,
    maxResponseBytes: 256 * 1024 * 1024,
    maxEventBytes: 32 * 1024 * 1024,
});

/**
 * Parse a base URL and require a path that ends with `/`. Credentials, query, and hash are rejected.
 * @param {string} value
 * @returns {URL}
 * @ai.hint pure
 */
function normalizeBaseURL(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError('baseURL не должен содержать учётные данные, query или fragment.');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

/**
 * Delay before a retry. A positive Retry-After wins, capped at 60 seconds; otherwise backoff with jitter.
 * @param {number} attempt
 * @param {string|number|null} retryAfter
 * @returns {number}
 * @ai.hint pure
 */
function retryDelayMs(attempt, retryAfter) {
    const header = Number(retryAfter);
    if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);
    return Math.min(500 * 2 ** attempt + Math.random() * 250, 20_000);
}

/**
 * OpenAI Responses API client (plus /models) on node:https; no SDK.
 * All request bodies are passed through as documented by the API reference.
 *
 * `onEvent` receives the normalized streaming events described in stream.js plus
 * transport events: request.start / request.retry / request.headers / request.done.
 */
export function createClient({
    apiKey = process.env.OPENAI_API_KEY, baseURL = process.env.OPENAI_BASE_URL || defaults.baseURL,
    organization = process.env.OPENAI_ORG_ID, project = process.env.OPENAI_PROJECT_ID,
    http, retries = defaults.retries, idleTimeoutMs, connectTimeoutMs, maxErrorBytes = defaults.maxErrorBytes,
    maxResponseBytes = defaults.maxResponseBytes, maxEventBytes = defaults.maxEventBytes,
    onEvent: globalOnEvent,
} = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
        throw new ApiError('Не задан OPENAI_API_KEY (или ключ содержит недопустимые символы).', { code: 'NO_API_KEY' });
    }
    const root = normalizeBaseURL(baseURL);
    const transport = http ?? createHttp({ idleTimeoutMs, connectTimeoutMs });

    /**
     * Auth and content headers for one call. Accept is event-stream only when streaming.
     * @param {boolean} stream
     * @param {string} clientRequestId
     * @returns {object}
     * @ai.hint pure
     */
    const headersFor = (stream, clientRequestId) => ({
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        'X-Client-Request-Id': clientRequestId,
        ...(organization ? { 'OpenAI-Organization': organization } : {}),
        ...(project ? { 'OpenAI-Project': project } : {}),
    });

    /**
     * Read a capped error body and build an ApiError. Retryable is true for the retry status set.
     * @param {{ status: number, headers: object, body: AsyncIterable<Buffer> }} res
     * @param {string} clientRequestId
     * @returns {Promise<ApiError>}
     * @ai.hint io
     */
    async function apiErrorFrom(res, clientRequestId) {
        const raw = await readBody(res.body, maxErrorBytes, { truncate: true }).catch(() => Buffer.alloc(0));
        let parsed = null;
        try { parsed = JSON.parse(raw.toString('utf8'))?.error ?? null; } catch { /* not JSON */ }
        const message = parsed?.message ? String(parsed.message).slice(0, 2000) : `HTTP ${res.status}`;
        return new ApiError(`OpenAI API: ${message}`, {
            code: 'HTTP_ERROR', status: res.status, apiCode: parsed?.code ?? null, apiType: parsed?.type ?? null,
            param: parsed?.param ?? null, requestId: res.headers['x-request-id'] ?? null, clientRequestId,
            retryAfter: res.headers['retry-after'] ?? null, retryable: RETRYABLE_STATUS.has(res.status),
        });
    }

    /**
   * Core call. `stream` = expect text/event-stream and reduce it; otherwise parse JSON.
   * Retries only before any response byte has been consumed, and only for retryable failures.
   */
    async function call(path, { method = 'POST', body, rawBody, contentType, query, stream = false, signal, onEvent, idleTimeout } = {}) {
        const url = new URL(path, root);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value === undefined || value === null) continue;
            for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
        }
        const emit = (event) => { try { onEvent?.(event); globalOnEvent?.(event); } catch { /* observer */ } };
        const payload = rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body));
        let attempt = 0;
        for (;;) {
            signal?.throwIfAborted();
            const clientRequestId = randomUUID();
            const startedAt = Date.now();
            emit({ type: 'request.start', method, path: url.pathname, clientRequestId, attempt,
                requestBytes: payload ? Buffer.byteLength(payload) : 0, stream });
            let res;
            try {
                const headers = headersFor(stream, clientRequestId);
                if (contentType) headers['Content-Type'] = contentType;
                res = await transport.request({ url, method, body: payload, signal, idleTimeout, headers });
            } catch (error) {
                if (error instanceof ApiError && error.retryable && attempt < retries && !signal?.aborted) {
                    const delay = retryDelayMs(attempt, null);
                    emit({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, reason: error.message });
                    await sleep(delay, undefined, { signal }).catch(() => {});
                    attempt++;
                    continue;
                }
                throw error;
            }
            const requestId = res.headers['x-request-id'] ?? null;
            emit({ type: 'request.headers', status: res.status, requestId, clientRequestId });
            if (res.status < 200 || res.status >= 300) {
                const error = await apiErrorFrom(res, clientRequestId);
                res.destroy();
                if (error.retryable && attempt < retries && !signal?.aborted) {
                    const delay = retryDelayMs(attempt, error.retryAfter);
                    emit({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, reason: error.message, status: error.status });
                    await sleep(delay, undefined, { signal }).catch(() => {});
                    attempt++;
                    continue;
                }
                throw error;
            }
            const mime = String(res.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
            let reducer = null;
            try {
                let result;
                if (mime === 'text/event-stream') {
                    reducer = createStreamReducer({ emit });
                    let done = false;
                    for await (const event of parseSSE(res.body, { maxEventBytes, maxStreamBytes: maxResponseBytes })) {
                        if (event.type === '__done') break;
                        reducer.handle(event);
                        if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) { done = true; break; }
                    }
                    const response = reducer.response;
                    if (!response || (!done && !['completed', 'failed', 'incomplete', 'cancelled'].includes(response.status))) {
                        if (reducer.streamError) throw reducer.streamError;
                        throw new ApiError('Поток завершился без финального состояния ответа.', {
                            code: 'STREAM_TRUNCATED', responseId: response?.id ?? null, requestId, clientRequestId,
                            details: { partialText: reducer.partialText(), lastSequence: reducer.lastSequence },
                        });
                    }
                    if (response.status === 'failed' && !response.error && reducer.streamError) {
                        response.error = { code: reducer.streamError.apiCode, message: reducer.streamError.message };
                    }
                    result = response;
                } else if (mime === 'application/json' || mime.endsWith('+json')) {
                    const raw = await readBody(res.body, maxResponseBytes);
                    try { result = JSON.parse(raw.toString('utf8')); } catch (cause) {
                        throw new ApiError('Ответ сервера не является корректным JSON.', { code: 'INVALID_RESPONSE', cause });
                    }
                } else {
                    throw new ApiError(`Неожиданный Content-Type ответа: ${mime || 'нет'}`, { code: 'CONTENT_TYPE' });
                }
                emit({ type: 'request.done', status: res.status, requestId, clientRequestId, elapsedMs: Date.now() - startedAt,
                    responseId: result?.id ?? null });
                return result;
            } catch (caught) {
                res.destroy();
                let error = caught;
                if (error instanceof ApiError && reducer && error.code === 'NETWORK_ERROR' && reducer.lastSequence !== null) {
                    // The connection dropped after the stream had started: report it as a truncated stream
                    // (resumable in background mode) rather than a generic network failure.
                    error = new ApiError(`Поток оборван: ${caught.message}`, { code: 'STREAM_TRUNCATED', cause: caught, retryable: false });
                }
                if (error instanceof ApiError) {
                    error.requestId ??= requestId;
                    error.clientRequestId ??= clientRequestId;
                    if (reducer) {
                        error.responseId ??= reducer.response?.id ?? null;
                        error.details ??= { partialText: reducer.partialText(), lastSequence: reducer.lastSequence };
                    }
                }
                throw error;
            }
        }
    }

    /**
     * Copy concatenated output text onto a response object.
     * @param {object|null} response
     * @returns {object|null}
     * @ai.hint pure
     */
    const withText = (response) => (response && typeof response === 'object'
        ? Object.assign(response, { output_text: outputText(response) }) : response);

    const responses = {
        /** POST /responses — streams when body.stream is true; resolves with the final response. */
        async create(body, options = {}) {
            return withText(await call('responses', { body, stream: Boolean(body?.stream), ...options }));
        },
        /** GET /responses/{id}; with {stream:true, startingAfter} resumes a background stream. */
        async retrieve(id, { stream = false, startingAfter, include, ...options } = {}) {
            const query = { ...(stream ? { stream: 'true' } : {}), ...(startingAfter != null ? { starting_after: startingAfter } : {}),
                ...(Array.isArray(include) && include.length ? { 'include[]': include } : {}) };
            return withText(await call(`responses/${encodeURIComponent(id)}`, { method: 'GET', query, stream, ...options }));
        },
        cancel: (id, options = {}) => call(`responses/${encodeURIComponent(id)}/cancel`, { method: 'POST', ...options }),
        delete: (id, options = {}) => call(`responses/${encodeURIComponent(id)}`, { method: 'DELETE', ...options }),
        /** POST /responses/compact — server-side context compaction. */
        compact: (body, options = {}) => call('responses/compact', { body, ...options }),
        /** POST /responses/input_tokens — count input tokens without generating. */
        inputTokens: (body, options = {}) => call('responses/input_tokens', { body, ...options }),
        inputItems: (id, options = {}) => call(`responses/${encodeURIComponent(id)}/input_items`, { method: 'GET', ...options }),
    };
    const images = {
        /** POST /images/generations. Returns base64 payloads from data[].b64_json. */
        async generate({ model, prompt, size, quality, n, signal } = {}) {
            const result = await call('images/generations', { body: generationBody({ model, prompt, size, quality, n }), signal });
            const payloads = imagePayloads(result);
            if (!payloads.length) throw new ApiError('Ответ images/generations не содержит b64_json.', { code: 'INVALID_RESPONSE' });
            return payloads;
        },
        /** POST /images/edits as multipart form data. `files` are { filename, mime, bytes }. */
        async edit({ model, prompt, files, size, signal } = {}) {
            const form = encodeMultipart({
                fields: { model, prompt, ...(size && size !== 'auto' ? { size } : {}) },
                files: files.map((file) => ({ ...file, field: 'image' })),
            });
            const result = await call('images/edits', { rawBody: form.body, contentType: form.contentType, signal });
            const payloads = imagePayloads(result);
            if (!payloads.length) throw new ApiError('Ответ images/edits не содержит b64_json.', { code: 'INVALID_RESPONSE' });
            return payloads;
        },
    };
    const models = {
        list: (options = {}) => call('models', { method: 'GET', ...options }),
        retrieve: (id, options = {}) => call(`models/${encodeURIComponent(id)}`, { method: 'GET', ...options }),
    };

    return Object.freeze({ responses, images, models, call, baseURL: root.href, close: () => transport.close() });
}
