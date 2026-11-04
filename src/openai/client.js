/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose API client on node:https: Responses routes, with a /chat/completions transport when the host lacks them.
 * @depends node:crypto, node:timers/promises, openai/errors, openai/http, openai/sse, openai/stream, openai/chat
 * @usedBy commands/shared
 * @exports ApiError, createClient, retryDelayMs
 * @ai.tags openai, http, chat
 * @ai.hint io
 * @changed 2026-11-04 createClient answers /v1/chat/completions when the host has no /v1/responses route.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { createHttp, readBody } from './http.js';
import { parseSSE } from './sse.js';
import { createStreamReducer, outputText } from './stream.js';
import { CHAT_PATH, chatGaps, createChatStreamReducer, droppedTools, normalizeChatResult, responsesRouteUnsupported, stripRejectedFields, toChatBody } from './chat.js';
import { envValue } from '../core/runtime-env.js';
import { detectMagick, magickPadImageBytes, magickRemoveImagePadding } from '../agent/image-magick.js';
import { rasterPadImageBytes, rasterRemoveImagePadding } from '../agent/image-raster.js';
import { acceptsResponseFormat, backgroundValue, encodeMultipart, generationBody, imageFormatField, imageRequestSize, imageSources, imageSizeAttempts, isImageSizeError, isVectorModel, normalizeVectorRatio, resolveImageFormat } from './images.js';

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
 * When the host has no /v1/responses route, `responses.create` translates the request to
 * /v1/chat/completions and translates the answer back, so the rest of the program keeps reading
 * Responses-shaped output items. `transport` reports which one the host actually answers.
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
    chat: chatSetting = null,
    onEvent: globalOnEvent,
} = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
        throw new ApiError('Не задан OPENAI_API_KEY (или ключ содержит недопустимые символы).', { code: 'NO_API_KEY' });
    }
    const root = normalizeBaseURL(baseURL);
    const customHeaders = normalizeHeaders(headers);
    const transport = http ?? createHttp({ idleTimeoutMs, connectTimeoutMs });
    /** Chat transport switches: `enabled: false` keeps a missing /responses route a hard error. */
    const chatSwitches = {
        enabled: chatSetting?.enabled !== false,
        /** Off by default, like `chat.strict`: a dropped tool is named, not fatal. */
        strict: chatSetting?.strict === true,
        streamUsage: chatSetting?.streamUsage !== false,
        reasoningEffort: chatSetting?.reasoningEffort !== false,
    };
    /** Sticky once the host has refused /responses (or `chat.force` said so up front). */
    let chatOnly = chatSetting?.force === true;

    /**
     * Forward an event that belongs to the transport rather than to one HTTP call.
     * @param {object} event
     * @param {Function} [onEvent]
     * @returns {void}
     * @ai.hint io
     */
    const announce = (event, onEvent) => { try { onEvent?.(event); globalOnEvent?.(event); } catch { /* observer */ } };

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
   * `streamReducer` swaps the Responses reducer for another one over the same byte stream
   * (`eventTypesRequired: false` for transports whose events carry no type field).
   * Retries only before any response byte has been consumed, and only for retryable failures.
   * A foreground stream that drops after it started is restarted once; a background one is resumed by the caller.
   */
    async function call(path, { method = 'POST', body, rawBody, contentType, query, stream = false, signal, onEvent, idleTimeout, extraHeaders = null, streamReducer = null, eventTypesRequired = true } = {}) {
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
                    reducer = streamReducer ? streamReducer({ emit }) : createStreamReducer({ emit });
                    let done = false;
                    for await (const event of parseSSE(res.body, { maxEventBytes, maxStreamBytes: maxResponseBytes, requireType: eventTypesRequired })) {
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

    /**
     * Download one image a gateway handed back as a URL instead of inline base64.
     * @param {string} url
     * @param {AbortSignal} [signal]
     * @returns {Promise<Buffer>}
     * @ai.hint io
     */
    async function fetchImageBytes(url, signal) {
        let target;
        try { target = new URL(url); }
        catch { throw new ApiError(`Некорректный URL изображения: ${url}`, { code: 'INVALID_RESPONSE' }); }
        const res = await transport.request({ url: target, method: 'GET', signal });
        if (res.status < 200 || res.status >= 300) {
            res.destroy();
            throw new ApiError(`Не удалось скачать изображение: HTTP ${res.status}`, {
                code: 'HTTP_ERROR', status: res.status, retryable: RETRYABLE_STATUS.has(res.status),
            });
        }
        const raw = await readBody(res.body, maxResponseBytes);
        if (!raw.length) throw new ApiError('Скачанное изображение пусто.', { code: 'INVALID_RESPONSE' });
        return raw;
    }

    /**
     * Base64 payloads from an images response. Inline `b64_json` is used as is; a `url` row is
     * downloaded, because many OpenAI-compatible hosts ignore `response_format` and always answer
     * with a link.
     * @param {object} result
     * @param {AbortSignal} [signal]
     * @param {string} route Route name, for the error text.
     * @returns {Promise<string[]>}
     * @ai.hint io
     */
    async function payloadList(result, signal, route) {
        const sources = imageSources(result);
        if (!sources.length) {
            throw new ApiError(`Ответ ${route} не содержит ни b64_json, ни url.`, { code: 'INVALID_RESPONSE' });
        }
        const out = [];
        for (const source of sources) {
            if (source.kind === 'b64') { out.push(source.value); continue; }
            out.push((await fetchImageBytes(source.value, signal)).toString('base64'));
        }
        return out;
    }

    /** The lost-capability notice is printed once per client, and only by whoever announces the switch. */
    let chatFitWarned = false;

    /** Names of the `type: 'mcp'` servers in this body; they are reported, never fatal. */
    const mcpLabels = (body) => droppedTools((Array.isArray(body?.tools) ? body.tools : []).filter((tool) => tool?.type === 'mcp'));

    /**
     * "нет web_search и серверов type: mcp (figma)" — what this body asks for and the chat route
     * does not have. Empty string when the request fits the transport.
     * @param {object} body Responses API body
     * @returns {string}
     * @ai.hint pure
     */
    const missingOnChat = (body) => {
        const parts = [];
        const gaps = chatGaps(body);
        if (gaps.length) parts.push(gaps.join(', '));
        const mcp = mcpLabels(body);
        if (mcp.length) parts.push(`серверов type: mcp (${mcp.join(', ')})`);
        return parts.length ? `нет ${parts.join(' и ')}` : '';
    };

    /**
     * Why this body cannot be answered on the chat transport in full, or null when it can.
     * `chat.strict: true` refuses such a request instead of quietly dropping a capability it asked
     * for; the default sends it without those tools and says so once. A `type: 'mcp'` server never
     * stops a request — the run works without it, so it is only named in the warning.
     * @param {object} body Responses API body
     * @param {{ onEvent?: Function, announce?: boolean }} [options] announce: false when the caller states the losses itself
     * @returns {ApiError|null}
     * @ai.hint io
     */
    function chatFit(body, { onEvent = null, announce: tell = true } = {}) {
        if (chatGaps(body).length && chatSwitches.strict) {
            return new ApiError(`Запросу нужен маршрут /v1/responses: на /v1/chat/completions ${missingOnChat(body)}. `
                + 'Возьмите бэкенд с /v1/responses, выключите эти инструменты (--no-web, --no-images) или напишите '
                + 'chat.strict: false, чтобы запрос ушёл без них.', { code: 'CHAT_CAPABILITY_MISSING', status: 404 });
        }
        const missing = missingOnChat(body);
        if (tell && missing && !chatFitWarned) {
            chatFitWarned = true;
            announce({
                type: 'warning',
                message: `На /v1/chat/completions ${missing} — запрос уходит без них; `
                    + 'chat.strict: true отказывает в таком переводе.',
            }, onEvent);
        }
        return null;
    }

    /**
     * POST /chat/completions with a Responses-shaped body, answered in the Responses shape.
     * A host that refuses one optional chat field gets the same request once without that field.
     * @param {object} body Responses API body
     * @param {{ signal?: AbortSignal, onEvent?: Function }} [options]
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function chatCreate(body, options = {}) {
        const stream = Boolean(body?.stream);
        if (body?.previous_response_id) {
            throw new ApiError('Серверное хранение разговора (store / previous_response_id) работает только на /v1/responses; '
                + 'хост отвечает на /v1/chat/completions — выключите store.', { code: 'CHAT_STATE_UNSUPPORTED', status: 400 });
        }
        const gap = chatFit(body, { onEvent: options.onEvent });
        if (gap) throw gap;
        let chatBody = toChatBody(body, { includeUsage: chatSwitches.streamUsage, withReasoning: chatSwitches.reasoningEffort });
        for (let attempt = 0; ; attempt++) {
            try {
                const result = await call(CHAT_PATH, {
                    body: chatBody,
                    stream,
                    eventTypesRequired: false,
                    ...(stream ? { streamReducer: ({ emit }) => createChatStreamReducer({ emit, model: body?.model }) } : {}),
                    ...options,
                });
                return withText(normalizeChatResult(result, { model: body?.model }));
            } catch (error) {
                if (attempt > 0) throw error;
                const stripped = stripRejectedFields(chatBody, error);
                if (!stripped.removed.length) throw error;
                chatBody = stripped.body;
                announce({ type: 'warning', message: `Хост отклонил ${stripped.removed.join(', ')} в /v1/chat/completions — запрос повторён без этих полей.` }, options.onEvent);
            }
        }
    }

    /**
     * Guard a route that exists only on /responses, so a chat-only host says why it cannot answer
     * instead of sending a request nobody serves.
     * @param {string} route Route name for the message.
     * @param {Function} fn The real call.
     * @returns {Function}
     * @ai.hint io
     */
    const responsesOnly = (route, fn) => async (...args) => {
        if (!chatOnly) return fn(...args);
        throw new ApiError(`${route} есть только в Responses API; этот хост отвечает на /v1/chat/completions.`, {
            code: 'ROUTE_UNAVAILABLE', status: 404,
        });
    };

    const responses = {
        /**
         * POST /responses — streams when body.stream is true; resolves with the final response.
         * A host without this route is answered through /v1/chat/completions instead, once and
         * then remembered for the life of the client.
         */
        async create(body, options = {}) {
            if (chatOnly) return chatCreate(body, options);
            try {
                return withText(await call('responses', { body, stream: Boolean(body?.stream), ...options }));
            } catch (error) {
                if (!chatSwitches.enabled || !responsesRouteUnsupported(error)) throw error;
                const gaps = chatGaps(body);
                // The route is missing for sure: remember it even when this request cannot move.
                chatOnly = true;
                if (gaps.length && chatSwitches.strict) {
                    throw new ApiError('Хост не отвечает на /v1/responses, а запросу нужен именно он: '
                        + `на /v1/chat/completions нет ${gaps.join(', ')}. Возьмите бэкенд с /v1/responses, `
                        + 'выключите эти инструменты (--no-web, --no-images) или напишите chat.strict: false.',
                    { code: 'ROUTE_UNSUPPORTED', status: 404, cause: error });
                }
                const missing = missingOnChat(body);
                // One line says both facts; chatCreate must not repeat the capability part.
                if (missing) chatFitWarned = true;
                announce({
                    type: 'warning',
                    message: 'Хост не отвечает на /v1/responses — запросы идут через /v1/chat/completions'
                        + (missing ? `; там ${missing}, запрос уходит без них (chat.strict: true отказывает в переводе)` : '') + '.',
                }, options.onEvent);
                return chatCreate(body, options);
            }
        },
        /** GET /responses/{id}; with {stream:true, startingAfter} resumes a background stream. */
        retrieve: responsesOnly('GET /responses/{id}', async (id, { stream = false, startingAfter, include, ...options } = {}) => {
            const query = { ...(stream ? { stream: 'true' } : {}), ...(startingAfter != null ? { starting_after: startingAfter } : {}),
                ...(Array.isArray(include) && include.length ? { 'include[]': include } : {}) };
            return withText(await call(`responses/${encodeURIComponent(id)}`, { method: 'GET', query, stream, ...options }));
        }),
        cancel: responsesOnly('POST /responses/{id}/cancel', (id, options = {}) => call(`responses/${encodeURIComponent(id)}/cancel`, { method: 'POST', ...options })),
        delete: responsesOnly('DELETE /responses/{id}', (id, options = {}) => call(`responses/${encodeURIComponent(id)}`, { method: 'DELETE', ...options })),
        /** POST /responses/compact — server-side context compaction. */
        compact: responsesOnly('POST /responses/compact', (body, options = {}) => call('responses/compact', { body, ...options })),
        /** POST /responses/input_tokens — count input tokens without generating. */
        inputTokens: responsesOnly('POST /responses/input_tokens', (body, options = {}) => call('responses/input_tokens', { body, ...options })),
        inputItems: responsesOnly('GET /responses/{id}/input_items', (id, options = {}) => call(`responses/${encodeURIComponent(id)}/input_items`, { method: 'GET', ...options })),
    };
    const chat = {
        /** POST /chat/completions: takes a Responses body, resolves with a Responses-shaped answer. */
        create: (body, options = {}) => chatCreate(body, options),
        /** Whether this host is served by the chat transport. */
        get isFallback() { return chatOnly; },
    };
    const images = {
        /** POST /images/generations. Returns base64 payloads from data[].b64_json or data[].url. */
        async generate({ model, prompt, size, quality, n, format, background, signal } = {}) {
            const attempts = imageSizeAttempts(size, model);
            let result;
            for (let index = 0; ; index++) {
                const requestedSize = attempts[index] ?? size;
                try {
                    result = await call('images/generations', { body: generationBody({ model, prompt, size: requestedSize, quality, n, format, background }), signal });
                    break;
                } catch (error) {
                    if (index >= attempts.length - 1 || !isImageSizeError(error)) throw error;
                }
            }
            return await payloadList(result, signal, 'images/generations');
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
                    //if (acceptsResponseFormat(model)) fields.response_format = 'b64_json';
                    fields[imageFormatField(model)] = 'svg';
                } else {
                    const frame = imageRequestSize(attemptSize, model);
                    if (frame) fields.size = frame;
                    const fmt = resolveImageFormat({ model, format });
                    if (fmt) fields[imageFormatField(model)] = fmt;
                    const backgroundField = backgroundValue({ model, format: fmt, background });
                    if (backgroundField) fields.background = backgroundField;
                    //if (acceptsResponseFormat(model)) fields.response_format = 'b64_json';
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
            const payloads = await payloadList(result, signal, 'images/edits');
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

    return Object.freeze({
        responses, chat, images, models, decisions, moderations, call, baseURL: root.href,
        /** Which route this host answers: `responses`, or `chat` after a missing /responses route. */
        get transport() { return chatOnly ? 'chat' : 'responses'; },
        close: () => transport.close(),
    });
}
