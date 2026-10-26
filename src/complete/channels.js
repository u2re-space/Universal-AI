/**
 * @file src/complete/channels.js
 * @module complete/channels
 * @purpose Pick the fastest OpenAI-compatible channel for a completion model and keep the others as fallbacks.
 * @depends node:perf_hooks, openai/client, openai/errors, openai/fallback, core/config, complete/models
 * @usedBy complete/complete, commands/complete, commands/serve, index.js
 * @exports completionChannelList, buildProbeBody, createCompletionChannels
 * @ai.tags complete, openai
 * @ai.hint io
 * @changed 2026-10-21 The fastest channel is probed per model and cached; a failed channel moves to the next one.
 */

import { performance } from 'node:perf_hooks';
import { createClient } from '../openai/client.js';
import { ApiError, isAbortError } from '../openai/errors.js';
import { modelMissing, primaryBackend, providerDown, providerList, supportsRoute } from '../openai/fallback.js';
import { isReasoningModel, supportsVerbosity } from '../core/config.js';
import { liveEnv } from '../core/runtime-env.js';
import { resolveCompletionModel } from './models.js';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 1_500;
const FAILURE_TTL_MS = 10_000;
const PROBE_INPUT = 'ping';
const PROBE_MAX_OUTPUT_TOKENS = 32;

/**
 * The primary host and every fallback provider that has its own key.
 * The primary entry comes first; duplicates are dropped by base URL and key.
 * @param {object} config Resolved config: baseURL, apiKey, backends, fallback.
 * @param {object} [env] Environment for apiKey and provider env names.
 * @returns {{ baseURL: string, apiKey: string, label: string, primary: boolean, headers?: object, supports?: object }[]}
 * @exports
 * @ai.hint pure
 */
export function completionChannelList(config, env = null) {
    const out = [];
    const seen = new Set();
    /**
     * @param {string} baseURL
     * @param {string} apiKey
     * @param {boolean} primary
     * @param {object|null} [headers]
     * @param {object|null} [supports]
     * @returns {void}
     * @ai.hint pure
     */
    const add = (baseURL, apiKey, primary, headers = null, supports = null) => {
        const url = String(baseURL ?? '').trim();
        const key = String(apiKey ?? '').trim();
        if (!url || !key || /[\r\n]/.test(key) || !supportsRoute(supports, 'responses')) return;
        const normalized = url.replace(/\/+$/, '');
        const id = `${normalized}\u0000${key}`;
        if (seen.has(id)) return;
        seen.add(id);
        const entry = { baseURL: url, apiKey: key, label: normalized, primary };
        if (headers && typeof headers === 'object') entry.headers = headers;
        if (supports && typeof supports === 'object') entry.supports = supports;
        out.push(entry);
    };
    env ??= liveEnv() ?? process.env;
    const first = primaryBackend({ ...config, apiKey: config?.apiKey || env.OPENAI_API_KEY });
    add(first.baseURL || 'https://api.openai.com/v1/', first.apiKey || env.OPENAI_API_KEY, true, first.headers, first.supports);
    for (const item of providerList(config, env)) add(item.baseURL, item.apiKey, false, item.headers, item.supports);
    return out;
}

/**
 * A short completion that proves the channel serves this model and measures its latency.
 * It uses the same reasoning level and verbosity as the completion catalog.
 * @param {string} model Wire model id.
 * @returns {object} Responses API body.
 * @exports
 * @ai.hint pure
 */
export function buildProbeBody(model) {
    const row = resolveCompletionModel(model);
    const body = {
        model,
        input: PROBE_INPUT,
        max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
        stream: false,
        store: false,
        truncation: 'auto',
    };
    const effort = row ? row.reasoning : (isReasoningModel(model) ? 'none' : null);
    if (effort) body.reasoning = { effort };
    if (supportsVerbosity(model)) body.text = { verbosity: 'low' };
    return body;
}

/**
 * A channel failed for a reason that another host may not share.
 * @param {Error & { status?: number }} error
 * @returns {boolean}
 * @ai.hint pure
 */
function channelFailed(error) {
    return Boolean(error) && (modelMissing(error) || providerDown(error) || error.status === 404);
}

/**
 * Create a completion transport that probes the configured channels for one model,
 * caches the fastest one, and falls back to the next channel when a request fails.
 *
 * The primary baseURL/API key is a channel too. Alternative channels are
 * `backends` entries (or legacy `fallback.providers`), each with its own apiKey or env variable.
 * Probing is skipped when there is only one channel or completion.channelProbe is false.
 *
 * @param {object} config Resolved config.
 * @param {{ create?: typeof createClient, env?: object, ttlMs?: number, timeoutMs?: number }} [options]
 * @returns {{ create: (body: object, options?: object) => Promise<object>, close: () => void }}
 * @exports
 * @ai.hint io
 */
export function createCompletionChannels(config, { create = createClient, env = liveEnv(), ttlMs, timeoutMs } = {}) {
    const endpoints = completionChannelList(config, env);
    const probeEnabled = config?.completion?.channelProbe !== false;
    const ttl = Number.isFinite(ttlMs) ? ttlMs : (config?.completion?.probeTtlMs ?? DEFAULT_TTL_MS);
    const timeout = Number.isFinite(timeoutMs) ? timeoutMs : (config?.completion?.probeTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const clients = new Map();
    /** @type {Map<string, object>} */
    const cache = new Map();
    /** @type {Map<string, Promise<object>>} */
    const inflight = new Map();
    let closed = false;

    /**
     * One client per channel. Retries are off: completion is latency-critical,
     * and the router moves to another channel instead of waiting on the same host.
     * @param {{ baseURL: string, apiKey: string }} endpoint
     * @returns {object}
     * @ai.hint io
     */
    function clientFor(endpoint) {
        if (closed) throw new ApiError('Каналы дополнения закрыты.', { code: 'CLOSED' });
        let client = clients.get(endpoint);
        if (client) return client;
        client = create({
            apiKey: endpoint.apiKey,
            baseURL: endpoint.baseURL,
            headers: endpoint.headers ?? null,
            organization: config.organization,
            project: config.project,
            retries: 0,
            idleTimeoutMs: config.limits?.idleTimeoutMs,
            connectTimeoutMs: config.limits?.connectTimeoutMs,
        });
        clients.set(endpoint, client);
        return client;
    }

    /**
     * The last-resort entry when every probe failed or no channel is configured.
     * @param {Error|null} [error]
     * @returns {object}
     * @ai.hint pure
     */
    function fallbackEntry(error = null) {
        const first = endpoints[0] ?? null;
        return {
            winner: first,
            order: first ? [first] : [],
            down: new Set(),
            all: Promise.resolve(first ? [first] : []),
            allDone: true,
            failed: true,
            refresh: null,
            error,
        };
    }

    /**
     * Start probes in parallel. The first success is the winner; the remaining
     * probes keep running and fill the ordered fallback list.
     * @param {string} model
     * @returns {{ entry: object, firstDone: Promise<object> }}
     * @ai.hint io
     */
    function startProbe(model) {
        if (!probeEnabled || endpoints.length < 2) {
            const entry = {
                winner: endpoints[0] ?? null,
                order: endpoints.slice(),
                down: new Set(),
                all: Promise.resolve(endpoints.slice()),
                allDone: true,
                failed: endpoints.length === 0,
                refresh: null,
            };
            return { entry, firstDone: Promise.resolve(entry) };
        }
        const entry = {
            winner: null,
            order: [],
            down: new Set(),
            all: null,
            allDone: false,
            failed: false,
            refresh: null,
        };
        const startedAt = performance.now();
        const latencies = new Map();
        let firstResolved = false;
        let resolveFirst;
        const first = new Promise((resolve) => { resolveFirst = resolve; });
        const probes = endpoints.map((endpoint) => (async () => {
            try {
                const client = clientFor(endpoint);
                const response = await client.responses.create(buildProbeBody(model), {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, timeout))]),
                });
                if (response?.status === 'failed' || response?.status === 'cancelled' || response?.error) {
                    throw new ApiError(response?.error?.message ?? 'Пробный запрос канала завершился ошибкой.', {
                        code: 'PROBE_FAILED', apiCode: response?.error?.code ?? null,
                    });
                }
                const latencyMs = performance.now() - startedAt;
                latencies.set(endpoint, latencyMs);
                entry.order.push(endpoint);
                if (!firstResolved) {
                    firstResolved = true;
                    entry.winner = endpoint;
                    resolveFirst(entry);
                }
                return { endpoint, latencyMs };
            } catch (error) {
                return { endpoint, error };
            }
        })());
        entry.all = Promise.allSettled(probes).then(() => {
            entry.order.sort((left, right) => (latencies.get(left) ?? Infinity) - (latencies.get(right) ?? Infinity));
            if (!entry.winner) {
                entry.failed = true;
                entry.order = endpoints.slice(0, 1);
                entry.winner = entry.order[0] ?? null;
            }
            entry.allDone = true;
            return entry.order;
        });
        const firstDone = Promise.race([first, entry.all]).then(() => entry);
        return { entry, firstDone };
    }

    /**
     * Probe this model unless a probe is already running.
     * @param {string} model
     * @returns {Promise<object>}
     * @ai.hint io
     */
    function refresh(model) {
        if (inflight.has(model)) return inflight.get(model);
        const promise = (async () => {
            const { entry, firstDone } = startProbe(model);
            await firstDone;
            entry.at = Date.now();
            if (!closed) cache.set(model, entry);
            return entry;
        })().catch((error) => {
            const entry = fallbackEntry(error);
            entry.at = Date.now();
            if (!closed) cache.set(model, entry);
            return entry;
        }).finally(() => inflight.delete(model));
        inflight.set(model, promise);
        return promise;
    }

    /**
     * A fresh cached entry, or the stale one while a background refresh runs.
     * @param {string} model
     * @returns {object|Promise<object>}
     * @ai.hint io
     */
    function select(model) {
        if (ttl <= 0) return refresh(model);
        const entry = cache.get(model);
        if (!entry) return refresh(model);
        const age = Date.now() - entry.at;
        const limit = entry.failed ? Math.min(ttl, FAILURE_TTL_MS) : ttl;
        const allDown = entry.allDone && !entry.failed && entry.order.length > 0
            && entry.order.every((endpoint) => entry.down.has(endpoint));
        if (age < limit && !allDown) return entry;
        if (age < limit && allDown) {
            cache.delete(model);
            return refresh(model);
        }
        // Stale-while-revalidate: the editor gets an answer now; the next request sees the new winner.
        entry.refresh ??= refresh(model).catch(() => null);
        return entry;
    }

    /**
     * Try one endpoint and keep setup failures separate from API errors.
     * @param {object} endpoint
     * @param {object} body
     * @param {object} options
     * @returns {Promise<{ response?: object, error?: Error, setup?: boolean }>}
     * @ai.hint io
     */
    async function tryEndpoint(endpoint, body, options) {
        let client;
        try { client = clientFor(endpoint); }
        catch (error) { return { error, setup: true }; }
        try { return { response: await client.responses.create(body, options) }; }
        catch (error) { return { error }; }
    }

    /**
     * The next untried channel that is not marked down.
     * @param {object} entry
     * @param {Set<object>} tried
     * @returns {object|null}
     * @ai.hint pure
     */
    function nextEndpoint(entry, tried) {
        for (const endpoint of entry.order) {
            if (!tried.has(endpoint) && !entry.down.has(endpoint)) return endpoint;
        }
        // A failed probe entry keeps the primary as the last resort until the short failure TTL expires.
        if (entry.failed) {
            for (const endpoint of entry.order) if (!tried.has(endpoint)) return endpoint;
        }
        return null;
    }

    /**
     * Try the winner, then every other probed channel in latency order.
     * @param {object} entry
     * @param {object} body
     * @param {object} options
     * @returns {Promise<{ response?: object, error?: Error|null }>}
     * @ai.hint io
     */
    async function attempt(entry, body, options) {
        let lastError = null;
        const tried = new Set();
        const winner = entry.winner && (!entry.down.has(entry.winner) || entry.failed) ? entry.winner : null;
        if (winner) {
            tried.add(winner);
            const result = await tryEndpoint(winner, body, options);
            if (result.response) return result;
            lastError = result.error;
            if (options.signal?.aborted || isAbortError(result.error)) throw result.error;
            if (!result.setup && !channelFailed(result.error)) throw result.error;
            entry.down.add(winner);
        }
        for (;;) {
            if (!entry.allDone) await entry.all;
            const endpoint = nextEndpoint(entry, tried);
            if (!endpoint) return { error: lastError };
            tried.add(endpoint);
            const result = await tryEndpoint(endpoint, body, options);
            if (result.response) return result;
            lastError = result.error;
            if (options.signal?.aborted || isAbortError(result.error)) throw result.error;
            if (!result.setup && !channelFailed(result.error)) throw result.error;
            entry.down.add(endpoint);
        }
    }

    /**
     * Send a completion through the fastest available channel.
     * @param {object} body Responses API body with a model.
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function send(body, options = {}) {
        if (closed) throw new ApiError('Каналы дополнения закрыты.', { code: 'CLOSED' });
        const model = String(body?.model ?? config.completion?.model ?? config.model ?? '').trim();
        if (!model) throw new ApiError('Не задана модель дополнения.', { code: 'NO_MODEL' });
        let entry = await select(model);
        for (;;) {
            if (closed) throw new ApiError('Каналы дополнения закрыты.', { code: 'CLOSED' });
            options.signal?.throwIfAborted?.();
            const result = await attempt(entry, body, options);
            if (result.response) return result.response;
            const pending = entry.refresh;
            if (pending) {
                entry.refresh = null;
                const fresh = await pending.catch(() => null);
                if (fresh && fresh !== entry) {
                    entry = fresh;
                    continue;
                }
            }
            if (cache.get(model) === entry) cache.delete(model);
            throw result.error ?? new ApiError('Нет доступного канала дополнения.', { code: 'NO_CHANNEL' });
        }
    }

    /**
     * Stop probes and close every channel client.
     * @returns {void}
     * @ai.hint io
     */
    function close() {
        if (closed) return;
        closed = true;
        controller.abort();
        for (const client of clients.values()) {
            try { client.close(); } catch { /* already closed */ }
        }
        clients.clear();
        cache.clear();
        inflight.clear();
    }

    return { create: send, close };
}
