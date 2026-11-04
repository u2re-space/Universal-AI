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
import { acceptsResponseFormat, backgroundValue, encodeMultipart, generationBody, imageFormatField, imageModelProfile, imageRequestSize, imageSizeAttempts, imageSizeFields, imageSources, isImageSizeError, isVectorModel, needsDiv16Padding, normalizeVectorRatio, resolveImageFormat } from './images.js';

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
 * Copy the extra body fields of one backend. Values keep their JSON type — a gateway flag such as
 * `useWalletBalance` has to arrive as `true`, not as the string `"true"`. What the request already
 * sets is decided by `withBackendBody`, which never overwrites a field the call itself produced.
 * @param {object|null|undefined} body
 * @returns {Record<string, unknown>}
 * @ai.hint pure
 */
const RESERVED_BODY = new Set(['model', 'input', 'messages', 'instructions', 'stream', 'tools', 'tool_choice',
    'parallel_tool_calls', 'previous_response_id', 'store', 'background', 'include']);

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
 * Copy the extra body fields of one backend. Values keep their JSON type — a gateway flag such as
 * `useWalletBalance` has to arrive as `true`, not as the string `"true"`. A field the client owns is
 * kept out here so it cannot reach the wire twice under another meaning.
 * @param {object|null|undefined} body
 * @returns {Record<string, unknown>}
 * @ai.hint pure
 */
function normalizeBodyFields(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    const out = {};
    for (const [name, value] of Object.entries(body)) {
        if (value === undefined) continue;
        out[name] = value;
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
    headers = null, body: bodySetting = null,
    http, retries = defaults.retries, idleTimeoutMs, connectTimeoutMs, maxErrorBytes = defaults.maxErrorBytes,
    maxResponseBytes = defaults.maxResponseBytes, maxEventBytes = defaults.maxEventBytes,
    magickPath = null, rasterEngine = 'auto', imageDiv16 = null,
    chat: chatSetting = null,
    onEvent: globalOnEvent,
} = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
        throw new ApiError('Не задан OPENAI_API_KEY (или ключ содержит недопустимые символы).', { code: 'NO_API_KEY' });
    }
    const root = normalizeBaseURL(baseURL);
    const customHeaders = normalizeHeaders(headers);
    /** Gateway fields this host expects in the JSON body; dropped when the host refuses them by name. */
    let backendBody = normalizeBodyFields(bodySetting);
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
     * Body fields this host expects beyond the OpenAI schema, the names it refused, and the names
     * already announced. A refused name is dropped for the rest of the client's life, so an unknown
     * gateway flag costs one rejected call instead of failing every request.
     */
    const refusedBodyNames = new Set();
    const warnedBodyNames = new Set();

    /**
     * `stream_options` for one chat call: what the request already asked for, plus what the backend
     * configuration adds. The whole field disappears once the host has refused it by name.
     * @param {object} request
     * @returns {void}
     * @ai.hint io
     */
    function applyStreamOptions(request) {
        if (refusedBodyNames.has('stream_options')) { delete request.stream_options; return; }
        const extra = backendBody.stream_options;
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return;
        request.stream_options = { ...(request.stream_options ?? {}), ...extra };
    }

    /**
     * Merge the configured body fields into a request the client built. A field the request already
     * carries keeps its value: `model`, `input`, and `stream` say what the call is, and a config
     * entry may not rewrite them.
     * @param {object} request
     * @param {Function} emit
     * @returns {object}
     * @ai.hint io
     */
    function withBackendBody(request, emit) {
        // `stream` and `stream_options` are the transport's own decision: a configured copy of them
        // would ask for SSE on a call that reads JSON.
        const skip = new Set(['stream', 'stream_options']);
        const extra = Object.entries(backendBody).filter(([name]) => !skip.has(name) && request[name] === undefined);
        if (!extra.length) return request;
        for (const [name] of extra) {
            if (warnedBodyNames.has(name)) continue;
            warnedBodyNames.add(name);
            announce({ type: 'warning', message: `В запрос добавлено поле ${name} из конфигурации бэкенда.` }, emit);
        }
        return Object.assign({}, request, Object.fromEntries(extra));
    }

    /**
     * Forget the configured body fields this host rejected by name, so the next call omits them.
     * @param {Error & { status?: number, param?: string, message?: string }} error
     * @returns {string[]} the configured names it refused
     * @ai.hint io
     */
    function refuseBackendBody(error) {
        if (error?.status !== 400) return [];
        const words = `${error?.param ?? ''} ${error?.message ?? ''}`.toLowerCase().split(/[^a-z0-9_-]+/);
        const refused = Object.keys(backendBody).filter((name) => words.includes(name.toLowerCase()));
        for (const name of refused) {
            delete backendBody[name];
            refusedBodyNames.add(name);
        }
        return refused;
    }

    /**
     * Repeat a refused request once without the fields the host does not know — the client's own
     * optional fields and the configured ones alike. Returns the request to send again, or null when
     * the error names nothing the request can lose.
     * @param {{ body?: object, rawBody?: string }} sent the request as it was sent
     * @param {Error & { status?: number }} error
     * @param {Function} emit
     * @returns {{ body?: object, rawBody?: string }|null}
     * @ai.hint io
     */
    function retryWithoutRejected(sent, error, emit) {
        // The names have to be read before `refuseBackendBody` forgets them: the retry strips them
        // out of the body this very call is repeating.
        const configured = Object.keys(backendBody);
        const refused = refuseBackendBody(error);
        if (sent.rawBody !== undefined) {
            if (!refused.length) return null;
            try {
                const parsed = JSON.parse(sent.rawBody);
                if (!parsed || typeof parsed !== 'object') return null;
                for (const name of refused) delete parsed[name];
                return { rawBody: JSON.stringify(parsed) };
            } catch { return null; }
        }
        const stripped = stripRejectedFields(sent.body ?? {}, error, configured);
        if (!stripped.removed.length) return null;
        announce({ type: 'warning', message: `Хост отклонил ${stripped.removed.join(', ')} — запрос повторён без этих полей.` }, emit);
        return { body: stripped.body };
    }

    /**
     * Core call. `stream` = expect text/event-stream and reduce it; otherwise parse JSON.
     * `streamReducer` swaps the Responses reducer for another one over the same byte stream
     * (`eventTypesRequired: false` for transports whose events carry no type field).
     * A request body is completed with this host's configured `body` fields, and a field the host
     * refuses by name costs one repeated call without it.
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
        const sendsBody = rawBody !== undefined || body !== undefined;
        const sent = rawBody !== undefined
            ? { rawBody }
            : (sendsBody ? { body: withBackendBody(body, emit) } : {});
        let payload = rawBody !== undefined ? rawBody : (sendsBody ? JSON.stringify(sent.body) : undefined);
        let background = (sendsBody ? sent.body?.background : undefined) === true;
        let rejectedRetry = false;
        let attempt = 0;
        let streamRestarts = 0;
        /**
         * Retry a refused field or a dropped connection. A persistent status ends the call at once.
         * @param {Error & { status?: number }} error
         * @returns {Promise<boolean>}
         */
        const retryOrStop = async (error) => {
            /**
             * A host that refuses a field by name gets the same request once without it. This is not
             * a network retry: `attempt` stays as it is, and the client's own optional fields
             * (`stream_options`, `reasoning_effort`, …) are dropped the same way as configured ones.
             */
            const retryWithoutField = async () => {
                if (rejectedRetry || !sendsBody || error?.status !== 400) return false;
                const next = retryWithoutRejected(sent, error, emit);
                if (!next) return false;
                rejectedRetry = true;
                if (next.rawBody !== undefined) { sent.rawBody = next.rawBody; payload = next.rawBody; }
                else { sent.body = next.body; payload = JSON.stringify(next.body); }
                background = sent.body?.background === true;
                return true;
            };
            if (await retryWithoutField()) return true;
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
            /** `stream_options` and the refused-field retry both rebuild what goes on the wire. */
            if (stream && sent.body) {
                applyStreamOptions(sent.body);
                payload = JSON.stringify(sent.body);
            }
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
                + 'Возьмите бэкенд с /v1/responses, выключите эти инструменты или режим (--no-web, --no-images, reasoning.mode: off) или напишите '
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
     * A field this host refuses by name — one the client adds itself or one configured in the
     * backend's `body` — is dropped and the request repeated once inside `call`.
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
        const chatBody = toChatBody(body, { includeUsage: chatSwitches.streamUsage, withReasoning: chatSwitches.reasoningEffort });
        const result = await call(CHAT_PATH, {
            body: chatBody,
            stream,
            eventTypesRequired: false,
            ...(stream ? { streamReducer: ({ emit }) => createChatStreamReducer({ emit, model: body?.model }) } : {}),
            ...options,
        });
        return withText(normalizeChatResult(result, { model: body?.model }));
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
                        + 'выключите эти инструменты или режим (--no-web, --no-images, reasoning.mode: off) или напишите chat.strict: false.',
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
                const requestedSize = index < attempts.length ? attempts[index] : size;
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
            if (!vector && needsDiv16Padding(model, imageDiv16) && files?.length) {
                const prepared = [];
                for (const file of files) {
                    let frame = null;
                    try { frame = await rasterPadImageBytes({ bytes: file.bytes, engine: rasterEngine }); }
                    catch { frame = null; }
                    if (!frame) {
                        const exe = await detectMagick({ magickPath });
                        if (!exe) throw new ApiError('Для добавления прозрачного padding к входному изображению требуется sharp, canvas или ImageMagick.', { code: 'IMAGE_PADDING_UNAVAILABLE' });
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
            // No explicit frame and no padding: derive the frame from the source image itself,
            // so edits preserve the input image's size and aspect ratio instead of the gateway
            // default square (1024×1024).  Uses sharp when available; silently falls through for
            // gateways without a raster engine.
            if (!vector && !requestedFrame && files?.length) {
                try {
                    const sharp = (await import('sharp')).default;
                    const meta = await sharp(files[0].bytes).metadata();
                    if (meta?.width && meta?.height) requestedFrame = `${meta.width}x${meta.height}`;
                } catch { /* no raster engine: gateway default stands */ }
            }
            const attempts = vector ? [] : imageSizeAttempts(requestedFrame, model);
            let result;
            for (let index = 0; ; index++) {
                const attemptSize = index < attempts.length ? attempts[index] : requestedFrame;
                const fields = { model, prompt };
                if (isVectorModel(model)) {
                    const aspect = normalizeVectorRatio(attemptSize);
                    if (aspect) fields.aspect_ratio = aspect;
                    //if (acceptsResponseFormat(model)) fields.response_format = 'b64_json';
                    fields[imageFormatField(model)] = 'svg';
                } else {
                    const sizeFields = imageSizeFields(attemptSize, model);
                    if (sizeFields.size) fields.size = sizeFields.size;
                    if (sizeFields.resolution) fields.resolution = sizeFields.resolution;
                    if (sizeFields.aspect_ratio) fields.aspect_ratio = sizeFields.aspect_ratio;
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
