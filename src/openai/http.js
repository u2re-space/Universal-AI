import http from 'node:http';
import https from 'node:https';
import { ApiError } from './errors.js';

/**
 * Minimal HTTP transport on node:http(s).
 *
 * Why not global fetch: Node's bundled undici applies a hidden ~5 minute body timeout and
 * exposes no public way to tune it without the undici package. Long reasoning runs can be
 * silent for longer than that, so we drive sockets directly and apply an explicit idle timeout.
 *
 * request() resolves as soon as response headers arrive. `body` is an async iterable of Buffers;
 * our own timeout / abort errors are rethrown from the iterator (not generic ECONNRESET).
 */
export function createHttp({
    connectTimeoutMs = 30_000, idleTimeoutMs = 600_000, keepAlive = true,
    userAgent = 'ai-agent-cli/1.0 (node)',
} = {}) {
    const agents = {
        'https:': new https.Agent({ keepAlive, maxSockets: 8 }),
        'http:': new http.Agent({ keepAlive, maxSockets: 8 }),
    };

    function moduleFor(url) {
        if (url.protocol === 'https:') return https;
        if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return http;
        throw new TypeError('Разрешены только HTTPS-адреса (HTTP — только для localhost).');
    }

    function request({ url, method = 'GET', headers = {}, body, signal, idleTimeout = idleTimeoutMs }) {
        const target = url instanceof URL ? url : new URL(url);
        const transport = moduleFor(target);
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            let settled = false;
            let failure = null;
            const req = transport.request(target, {
                method,
                agent: agents[target.protocol],
                headers: { 'User-Agent': userAgent, Accept: 'application/json', ...headers,
                    ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
            });
            const fail = (error) => {
                failure ??= error;
                req.destroy(error);
                if (!settled) { settled = true; cleanup(); reject(error); }
            };
            const onAbort = () => fail(signal.reason instanceof Error ? signal.reason
                : new ApiError('Запрос отменён.', { code: 'ABORTED' }));
            const connectTimer = setTimeout(() => fail(new ApiError(
                `Не удалось подключиться к ${target.host} за ${connectTimeoutMs} ms.`,
                { code: 'CONNECT_TIMEOUT', retryable: true })), connectTimeoutMs);
            function cleanup() {
                clearTimeout(connectTimer);
                signal?.removeEventListener('abort', onAbort);
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            req.setTimeout(idleTimeout, () => fail(new ApiError(
                `Нет данных от сервера дольше ${Math.round(idleTimeout / 1000)} с.`, { code: 'TIMEOUT' })));
            req.once('socket', (socket) => {
                if (socket.connecting) socket.once('connect', () => clearTimeout(connectTimer));
                else clearTimeout(connectTimer);
            });
            req.once('error', (error) => {
                if (failure) return; // Our own timeout / abort was already reported.
                const retryable = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']
                    .includes(error.code);
                fail(new ApiError(`Сетевая ошибка: ${error.message}`, { code: 'NETWORK_ERROR', retryable, cause: error }));
            });
            req.once('response', (res) => {
                clearTimeout(connectTimer);
                settled = true;
                res.once('error', () => { /* surfaced via the async iterator below */ });
                res.once('close', () => { if (res.complete) { signal?.removeEventListener('abort', onAbort); } });
                async function* iterate() {
                    try {
                        for await (const chunk of res) yield chunk;
                        if (!res.complete) throw failure ?? new ApiError('Соединение закрыто до конца ответа.',
                            { code: 'NETWORK_ERROR', retryable: false });
                    } catch (error) {
                        throw failure ?? (error instanceof ApiError ? error
                            : new ApiError(`Ошибка чтения ответа: ${error.message}`, { code: 'NETWORK_ERROR', cause: error }));
                    } finally {
                        signal?.removeEventListener('abort', onAbort);
                    }
                }
                resolve({
                    status: res.statusCode, headers: res.headers, body: iterate(),
                    destroy: () => { req.destroy(); res.destroy(); signal?.removeEventListener('abort', onAbort); },
                });
            });
            if (body !== undefined) req.write(body);
            req.end();
        });
    }

    function close() {
        for (const agent of Object.values(agents)) agent.destroy();
    }

    return { request, close };
}

/** Read a whole body with a byte cap. */
export async function readBody(body, maxBytes, { truncate = false } = {}) {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        if (total + chunk.length > maxBytes) {
            if (!truncate) throw new ApiError('Ответ сервера превышает допустимый размер.', { code: 'RESPONSE_LIMIT' });
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
            total = maxBytes;
            break;
        }
        chunks.push(chunk);
        total += chunk.length;
    }
    return Buffer.concat(chunks, total);
}
