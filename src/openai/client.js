/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose Responses API client on node:https: create, retrieve, cancel, compact, and count tokens.
 * @depends node:crypto, node:timers/promises, openai/errors, openai/http, openai/sse, openai/stream
 * @usedBy commands/shared
 * @exports ApiError, createClient, retryDelayMs
 * @ai.tags openai, http
 * @ai.hint io
 * @changed 2026-10-22 Vector models use aspect_ratio and svg on the edit route.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { createHttp, readBody } from './http.js';
import { parseSSE } from './sse.js';
import { createStreamReducer, outputText } from './stream.js';
import { envValue } from '../core/runtime-env.js';
import { detectMagick, magickPadImageBytes, magickRemoveImagePadding } from '../agent/image-magick.js';
import { rasterPadImageBytes, rasterRemoveImagePadding } from '../agent/image-raster.js';
import { backgroundValue, encodeMultipart, generationBody, imageFormatField, imagePayloads, imageRequestSize, imageSizeAttempts, isImageSizeError, isVectorModel, normalizeVectorRatio, resolveImageFormat } from './images.js';

export { ApiError };

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const PERSISTENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 410, 411, 413, 415, 422, 451]);
const defaults = Object.freeze({
    baseURL: 'https://api.openai.com/v1/',
    retries: 4,                    // extra tries after the first, for timeout and network loss only
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

/** Headers the client sets itself; a custom header must not replace them. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-client-request-id', 'openai-organization', 'openai-project']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Stringify and check per-backend headers. Reserved names are ignored, because auth and content
 * headers belong to the client.
 * @param {object|null|undefined} headers
 * @returns {Record<string, string>}
 * @ai.hint pure
 */
function normalizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || value == null) continue;
        const text = String(value);
        if (/[\r\n]/.test(text)) throw new TypeError(`Заголовок ${name} содержит перевод строки.`);
        out[name] = text;
    }
    return out;
}

/**
 * Delay before a retry. A positive Retry-After wins, capped at 60 seconds; otherwise backoff with jitter.
 * HTTP 429 waits at least 3 seconds so a repeat does not look like a burst.
 * @param {number} attempt
 * @param {string|number|null} retryAfter
 * @param {number|null} [status]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function retryDelayMs(attempt, retryAfter, status = null) {
    const header = Number(retryAfter);
    const fromHeader = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 60_000) : 0;
    const backoff = Math.min(500 * 2 ** attempt + Math.random() * 250, 20_000);
    const delay = Math.max(fromHeader, backoff);
    if (status === 429) return Math.max(delay, 3000);
    return fromHeader > 0 ? fromHeader : backoff;
}

/**
 * OpenAI Responses API client (plus /models) on node:https; no SDK.
 * All request bodies are passed through as documented by the API reference.
 *
 * `onEvent` receives the normalized streaming events described in stream.js plus
 * transport events: request.start / request.retry / request.headers / request.done.
 */
export function createClient({
    apiKey = envValue('OPENAI_API_KEY'), baseURL = envValue('OPENAI_BASE_URL') || defaults.baseURL,
    organization = envValue('OPENAI_ORG_ID'), project = envValue('OPENAI_PROJECT_ID'),
    headers = null,
    http, retries = defaults.retries, idleTimeoutMs, connectTimeoutMs, maxErrorBytes = defaults.maxErrorBytes,
    maxResponseBytes = defaults.maxResponseBytes, maxEventBytes = defaults.maxEventBytes,
    magickPath = null, rasterEngine = 'auto',
    onEvent: globalOnEvent,
} = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
        throw new ApiError('Не задан OPENAI_API_KEY (или ключ содержит недопустимые символы).', { code: 'NO_API_KEY' });
    }
    const root = normalizeBaseURL(baseURL);
    const customHeaders = normalizeHeaders(headers);
    const transport = http ?? createHttp({ idleTimeoutMs, connectTimeoutMs });

    /**
     * Auth and content headers for one call. Accept is event-stream only when streaming.
     * @param {boolean} stream
     * @param {string} clientRequestId
     * @returns {object}
     * @ai.hint pure
     */
    const headersFor = (stream, clientRequestId) => ({
        ...customHeaders,
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
        const text = raw.toString('utf8').trim();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        const err = parsed && typeof parsed === 'object' ? (parsed.error ?? parsed) : null;
        const details = err && typeof err === 'object' ? err : {};
        const fromBody = typeof err === 'string' ? err : (typeof details.message === 'string' ? details.message : '');
        const message = (fromBody || text).slice(0, 2000) || `HTTP ${res.status}`;
        return new ApiError(`OpenAI API: ${message}`, {
            code: 'HTTP_ERROR', status: res.status, apiCode: details.code ?? null, apiType: details.type ?? null,
            param: details.param ?? null, requestId: res.headers['x-request-id'] ?? null, clientRequestId,
            retryAfter: res.headers['retry-after'] ?? null, retryable: RETRYABLE_STATUS.has(res.status) && !PERSISTENT_STATUS.has(res.status),
        });
    }

    /**
   * Core call. `stream` = expect text/event-stream and reduce it; otherwise parse JSON.
   * Retries only before any response byte has been consumed, and only for retryable failures.
   * A foreground stream that drops after it started is restarted once; a background one is resumed by the caller.
   */
    async function call(path, { method = 'POST', body, rawBody, contentType, query, stream = false, signal, onEvent, idleTimeout, extraHeaders = null } = {}) {
        const url = new URL(path, root);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value === undefined || value === null) continue;
            for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
        }
        const emit = (event) => { try { onEvent?.(event); globalOnEvent?.(event); } catch { /* observer */ } };
        const payload = rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body));
        const background = body?.background === true;
        let attempt = 0;
        let streamRestarts = 0;
        /**
         * Retry a timeout or a dropped connection. A persistent status ends the call at once.
         * @param {Error} error
         * @returns {Promise<boolean>}
         */
        const retryOrStop = async (error) => {
            /*if (PERSISTENT_STATUS.has(error?.status)) {
                emit({ type: 'warning', message: `HTTP ${error.status}: повтор не выполняется, выполнение остановлено.` });
                return false;
            }*/
            if (error instanceof ApiError && error.retryable && attempt < retries && !signal?.aborted) {
                const delay = retryDelayMs(attempt, error.retryAfter, error.status);
                const reason = error.status === 429
                    ? `HTTP 429: слишком много запросов. Пауза ${Math.max(2, Math.round(delay / 1000))} с перед повтором.`
                    : error.message;
                emit({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, reason, status: error.status ?? null });
                await sleep(delay, undefined, { signal }).catch(() => {});
                attempt++;
                if (error.code === 'STREAM_TRUNCATED') streamRestarts++;
                return true;
            }
            if (error instanceof ApiError && error.retryable && retries > 0) {
                emit({ type: 'warning', message: `Запрос не удался после ${attempt + 1} попыток. Дальнейшие обращения остановлены.` });
            }
            return false;
        };
        for (;;) {
            signal?.throwIfAborted();
            const clientRequestId = randomUUID();
            const startedAt = Date.now();
            emit({ type: 'request.start', method, path: url.pathname, clientRequestId, attempt,
                requestBytes: payload ? Buffer.byteLength(payload) : 0, stream });
            let res;
            try {
                const headers = { ...headersFor(stream, clientRequestId), ...(extraHeaders ?? {}) };
                if (contentType) headers['Content-Type'] = contentType;
                res = await transport.request({ url, method, body: payload, signal, idleTimeout, headers });
            } catch (error) {
                if (await retryOrStop(error)) continue;
                throw error;
            }
            const requestId = res.headers['x-request-id'] ?? null;
            emit({ type: 'request.headers', status: res.status, requestId, clientRequestId });
            if (res.status < 200 || res.status >= 300) {
                const error = await apiErrorFrom(res, clientRequestId);
                res.destroy();
                if (await retryOrStop(error)) continue;
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
                            retryable: !background && streamRestarts < 1,
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
                    error = new ApiError(`Поток оборван: ${caught.message}`, {
                        code: 'STREAM_TRUNCATED', cause: caught,
                        retryable: !background && streamRestarts < 1,
                    });
                }
                if (error instanceof ApiError) {
                    error.requestId ??= requestId;
                    error.clientRequestId ??= clientRequestId;
                    if (reducer) {
                        error.responseId ??= reducer.response?.id ?? null;
                        error.details ??= { partialText: reducer.partialText(), lastSequence: reducer.lastSequence };
                    }
                }
                if (await retryOrStop(error)) continue;
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
        async generate({ model, prompt, size, quality, n, format, background, signal } = {}) {
            const attempts = imageSizeAttempts(size, model);
            let result;
            for (let index = 0; ; index++) {
                const requestedSize = attempts[index] ?? size;
                try {
                    result = await call('images/generations', { body: generationBody({ model, response_format: "b64_json", prompt, size: requestedSize, quality, n, format, background }), signal });
                    break;
                } catch (error) {
                    if (index >= attempts.length - 1 || !isImageSizeError(error)) throw error;
                }
            }
            const payloads = imagePayloads(result);
            if (!payloads.length) throw new ApiError('Ответ images/generations не содержит b64_json.', { code: 'INVALID_RESPONSE' });
            return payloads;
        },
        /** POST /images/edits as multipart form data. `files` are { filename, mime, bytes }. */
        async edit({ model, prompt, files, size, format, background, signal } = {}) {
            const vector = isVectorModel(model);
            let requestFiles = files;
            let padding = null;
            let requestedFrame = size;
            if (!vector && /^(?:openai\/)?gpt-image-2\.5(?:-|$)/i.test(String(model ?? '')) && files?.length) {
                const prepared = [];
                for (const file of files) {
                    let frame = null;
                    try { frame = await rasterPadImageBytes({ bytes: file.bytes, engine: rasterEngine }); }
                    catch { frame = null; }
                    if (!frame) {
                        const exe = await detectMagick({ magickPath });
                        if (!exe) throw new ApiError('Для добавления прозрачного padding к входному изображению GPT Image 2.5 требуется sharp, canvas или ImageMagick.', { code: 'IMAGE_PADDING_UNAVAILABLE' });
                        frame = await magickPadImageBytes({ exe, bytes: file.bytes, signal });
                        frame.engine = 'magick';
                        frame.exe = exe;
                    }
                    prepared.push({
                        file: frame.padded ? { ...file, filename: `${path.parse(file.filename || 'image.png').name}.png`, mime: 'image/png', bytes: frame.bytes } : file,
                        frame,
                    });
                }
                requestFiles = prepared.map((item) => item.file);
                padding = prepared[0].frame;
                requestedFrame = `${padding.width}x${padding.height}`;
            }
            const attempts = vector ? [] : imageSizeAttempts(requestedFrame, model);
            let result;
            for (let index = 0; ; index++) {
                const attemptSize = attempts[index] ?? requestedFrame;
                const fields = { model, prompt };
                if (isVectorModel(model)) {
                    const aspect = normalizeVectorRatio(attemptSize);
                    if (aspect) fields.aspect_ratio = aspect;
                    fields['response_format'] = "b64_json";
                    fields[imageFormatField(model)] = 'svg';
                } else {
                    const frame = imageRequestSize(attemptSize, model);
                    if (frame) fields.size = frame;
                    const fmt = resolveImageFormat({ model, format });
                    if (fmt) fields[imageFormatField(model)] = fmt;
                    const backgroundField = backgroundValue({ model, format: fmt, background });
                    if (backgroundField) fields.background = backgroundField;
                    fields['response_format'] = "b64_json";
                }
                const form = encodeMultipart({
                    fields,
                    files: requestFiles.map((file) => ({ ...file, field: 'image' })),
                });
                try {
                    result = await call('images/edits', { rawBody: form.body, contentType: form.contentType, signal });
                    break;
                } catch (error) {
                    if (index >= attempts.length - 1 || !isImageSizeError(error)) throw error;
                }
            }
            const payloads = imagePayloads(result);
            if (!payloads.length) throw new ApiError('Ответ images/edits не содержит b64_json.', { code: 'INVALID_RESPONSE' });
            if (!padding) return payloads;
            return Promise.all(payloads.map(async (payload) => {
                const bytes = Buffer.from(payload, 'base64');
                const restored = padding.engine === 'magick'
                    ? await magickRemoveImagePadding({ ...padding, bytes, signal })
                    : await rasterRemoveImagePadding({ ...padding, bytes, engine: padding.engine });
                return restored.toString('base64');
            }));
        },
        /**
         * Vectorize one raster into SVG with a vector model. The source goes through the edit
         * route as a multipart `image` field: the generation route ignores an image reference
         * for these models, while the edit route conditions on the pixels and keeps the source frame.
         * @param {{ model: string, prompt: string, image: { mime: string, bytes: Buffer, filename?: string }, signal?: AbortSignal }} options
         * @returns {Promise<string[]>} base64 SVG payloads
         */
        async vectorize({ model, prompt, image, signal } = {}) {
            if (!image?.bytes?.length) throw new ApiError('vectorize: нужен исходный растр.', { code: 'INVALID_REQUEST' });
            return images.edit({
                model, prompt, format: 'svg', signal,
                files: [{ filename: image.filename || 'source.png', mime: image.mime, bytes: image.bytes }],
            });
        },
    };
    const models = {
        list: (options = {}) => call('models', { method: 'GET', ...options }),
        retrieve: (id, options = {}) => call(`models/${encodeURIComponent(id)}`, { method: 'GET', ...options }),
    };
    const decisions = {
        /** POST /decisions — probabilities for noul, choice, and score questions. No stream. */
        create: (body, options = {}) => call('decisions', { body, ...options }),
    };
    const moderations = {
        /** POST /moderations — omni moderation when the gateway exposes it. */
        create: (body, options = {}) => call('moderations', { body, ...options }),
    };

    return Object.freeze({ responses, images, models, decisions, moderations, call, baseURL: root.href, close: () => transport.close() });
}
