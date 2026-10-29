/**
 * @file src/openai/fallback.js
 * @module openai/fallback
 * @purpose Try another model channel, then another OpenAI-compatible host, when the first choice is unavailable.
 * @depends openai/client, openai/errors, openai/model-map, core/config
 * @usedBy commands/shared
 * @exports MODEL_FALLBACKS, fallbackModel, modelMissing, providerDown, routeMissing, supportsRoute, attemptChain, providerList, primaryBackend, createFallbackClient
 * @ai.tags openai, fallback
 * @ai.hint io
 * @changed 2026-10-27 Ordered backends with custom headers and route switches; decisions skip unsupported hosts.
 */

import { createClient } from './client.js';
import { ApiError } from './errors.js';
import { isReasoningModel, supportsVerbosity } from '../core/config.js';
import { envValue, liveEnv } from '../core/runtime-env.js';
import { MODEL_FALLBACKS } from './model-map.js';

/** Default stand-ins. Keys may be bare or prefixed with openai/. */
export { MODEL_FALLBACKS };

//
const triedMap = new Map();

/**
 * Substitute model id, or null when this id has no stand-in.
 * @param {string} model
 * @param {Record<string, string>} [map]
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function fallbackModel(model, map = MODEL_FALLBACKS, host = null) {
    const name = String(model ?? '').trim();
    if (!name || !map) return null;
    if (typeof map[name] === 'string' && map[name].trim() && map[name] !== name) return map[name].trim();
    const bare = name.replace(/^openai\//, '');
    const prefixed = bare === name ? `openai/${name}` : bare;
    const alt = (((bare?.startsWith?.("gpt-") || prefixed?.startsWith?.("openai/")) && !triedMap.get(host)?.has?.(model)) ? (bare === name ? `openai/${name}` : bare) : null) || map[name];
    if (typeof alt === 'string' && alt.trim() && alt !== name) return alt.trim();
    return null;
}

/**
 * The gateway does not serve this model id.
 * @param {Error & { status?: number, apiCode?: string, param?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function modelMissing(error) {
    const code = String(error?.apiCode ?? '');
    if (/model_not_found|model_not_available|invalid_model|unknown_model/i.test(code)) return true;
    if (error?.param === 'model') return true;
    return /model.{0,40}(not found|does not exist|unavailable|unknown|недоступ|не найден)/i.test(String(error?.message ?? ''));
}

/**
 * The host, the key, or the network failed. Another base URL may still answer.
 * @param {Error & { status?: number, code?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function providerDown(error) {
    if (['NETWORK_ERROR', 'TIMEOUT', 'CONNECT_TIMEOUT'].includes(error?.code)) return true;
    return [401, 402, 403, 404, 408, 425, 429, 500, 502, 503, 504].includes(error?.status);
}

/**
 * This gateway has no /decisions route.
 * @param {Error & { status?: number, code?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function routeMissing(error) {
    if (error?.code === 'DECISIONS_UNAVAILABLE') return true;
    if ([404, 405, 501].includes(error?.status)) return true;
    return /not found|unknown endpoint|no such/i.test(String(error?.message ?? '')) && /decision|endpoint|route/i.test(String(error?.message ?? ''));
}

/**
 * Whether a backend serves a route. A missing `supports` map means every route is on.
 * `images-edit` and `images-vector` share the `images` switch.
 * @param {object|null|undefined} supports
 * @param {string} kind
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function supportsRoute(supports, kind) {
    if (!supports || typeof supports !== 'object') return true;
    const key = kind === 'images-edit' || kind === 'images-vector' ? 'images' : kind;
    if (key === 'decisions' && Object.hasOwn(supports, 'decisionAPI')) return supports.decisionAPI !== false;
    return supports[key] !== false;
}

/**
 * One backend entry with a key, or null when it cannot be used.
 * The key of an `env` entry is read from the live environment, so a value that exists only in
 * `.env` is found — `process.env` never sees it.
 * @param {object} item
 * @param {object} env
 * @returns {{ baseURL: string, apiKey: string, headers?: object, supports?: object } | null}
 * @ai.hint pure
 */
function usableBackend(item, env) {
    const baseURL = String(item?.baseURL ?? '').trim();
    const apiKey = item?.apiKey || (item?.env ? env[item.env] : '') || '';
    if (!baseURL || !apiKey) return null;
    const entry = { baseURL, apiKey };
    if (item.headers && typeof item.headers === 'object') entry.headers = item.headers;
    if (item.supports && typeof item.supports === 'object') entry.supports = item.supports;
    return entry;
}

/**
 * Hosts to try after the primary one. Entries without a key are skipped.
 * `backends` is the ordered list when configured; otherwise the legacy `fallback.providers` is read.
 * @param {object} config
 * @param {object} [env]
 * @returns {{ baseURL: string, apiKey: string, headers?: object, supports?: object }[]}
 * @exports
 * @ai.hint pure
 */
export function providerList(config, env = liveEnv()) {
    if (config?.fallback?.enabled === false) return [];
    const declared = Array.isArray(config?.backends) && config.backends.length
        ? config.backends
        : (Array.isArray(config?.fallback?.providers) ? config.fallback.providers : []);
    const extra = env.AI_FALLBACK_BASE_URL && env.AI_FALLBACK_API_KEY
        ? [{ baseURL: env.AI_FALLBACK_BASE_URL, apiKey: env.AI_FALLBACK_API_KEY }]
        : [];
    const primaryURL = String(config?.baseURL ?? '').replace(/\/+$/, '');
    const primaryKey = String(config?.apiKey ?? '');
    const seen = new Set();
    const out = [];
    for (const item of [...declared, ...extra]) {
        const entry = usableBackend(item, env);
        if (!entry) continue;
        const id = `${entry.baseURL.replace(/\/+$/, '')}\u0000${entry.apiKey}`;
        if (id === `${primaryURL}\u0000${primaryKey}` || seen.has(id)) continue;
        seen.add(id);
        out.push(entry);
    }
    return out;
}

/**
 * Try each model on each host. A missing model advances the model. A dead host advances the host.
 * @param {{ endpoints: object[], model: string, map: object, send: Function, onWarn?: Function }} options
 * @returns {Promise<any>}
 * @exports
 * @ai.hint io
 */
export async function attemptChain({ endpoints, model, map, send, onWarn = () => {} }) {
    let last = null;
    for (let host = 0; host < endpoints.length; host++) {
        const url = endpoints[host]?.baseURL || endpoints[host]?.baseUrl || endpoints[host]?.label;
        const alts = [...new Set([model, fallbackModel(model, map, url)].filter(Boolean))];
        for (let index = 0; index < alts.length; index++) {
            const candidate = alts[index];
            try {
                const result = await send(endpoints[host], candidate, host > 0);
                if (candidate !== model) {
                    if (!triedMap?.has?.(url)) { triedMap.set(url, new Set([])); };
                    triedMap.get(url)?.add?.(model);
                    onWarn(`Модель ${model} недоступна. Запрос ушёл в ${candidate}.`);
                }
                else if (host > 0) onWarn(`Основной провайдер недоступен. Запрос ушёл на ${endpoints[host].label}.`);
                return result;
            } catch (error) {
                last = error;
                const moreModels = index < alts.length - 1 && modelMissing(error);
                if (moreModels) continue;
                if (providerDown(error) || modelMissing(error)) break;
                throw error;
            }
        }
    }
    throw last ?? new ApiError('Нет доступного провайдера.', { code: 'NO_PROVIDER' });
}

/**
 * Drop parameters a stand-in model does not accept, and drop a foreign previous response id.
 * @param {object} body
 * @param {string} model
 * @param {boolean} switchedHost
 * @returns {object}
 * @ai.hint pure
 */
function adaptBody(body, model, switchedHost) {
    const next = { ...body, model };
    if (switchedHost) delete next.previous_response_id;
    if (!isReasoningModel(model)) delete next.reasoning;
    if (next.text && typeof next.text === 'object' && !supportsVerbosity(model)) {
        const text = { ...next.text };
        delete text.verbosity;
        if (Object.keys(text).length) next.text = text;
        else delete next.text;
    }
    return next;
}

/**
 * The primary backend entry, including its custom headers and route switches.
 * A `backends` list names it explicitly; otherwise only the top-level URL and key exist.
 * @param {object} config
 * @returns {{ baseURL: string, apiKey: string, headers?: object|null, supports?: object|null }}
 * @exports
 * @ai.hint pure
 */
export function primaryBackend(config) {
    const declared = Array.isArray(config?.backends) ? config.backends : [];
    const match = declared.find((item) => item?.baseURL === config.baseURL && String(item.apiKey ?? '') === String(config.apiKey ?? ''))
        ?? declared.find((item) => item?.baseURL === config.baseURL);
    return {
        baseURL: config.baseURL,
        apiKey: config.apiKey ?? envValue('OPENAI_API_KEY'),
        headers: match?.headers ?? null,
        supports: match?.supports ?? null,
    };
}

/**
 * Primary client plus model and host fallback.
 * @param {object} config
 * @param {{ create?: typeof createClient }} [options]
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createFallbackClient(config, { create = createClient } = {}) {
    const timeouts = {
        retries: config.retries, idleTimeoutMs: config.limits?.idleTimeoutMs, connectTimeoutMs: config.limits?.connectTimeoutMs,
        organization: config.organization, project: config.project,
    };
    const primarySpec = primaryBackend(config);
    const rasterOptions = { magickPath: config.magickPath ?? null, rasterEngine: config.image?.rasterEngine ?? 'auto' };
    const primary = create({
        apiKey: primarySpec.apiKey, baseURL: primarySpec.baseURL, headers: primarySpec.headers, ...timeouts, ...rasterOptions,
    });
    const opened = [];
    const map = config.fallback?.models ?? MODEL_FALLBACKS;
    /**
     * One endpoint object for a backend. `supports` decides which routes may reach it.
     * @param {object} spec
     * @param {object} client
     * @returns {{ label: string, client: object, supports: object|null }}
     * @ai.hint pure
     */
    const endpointOf = (spec, client) => ({ label: spec.baseURL, client, supports: spec.supports ?? null });
    /**
     * Endpoints that serve `kind`, primary first and fallbacks in their configured order.
     * @param {string} kind
     * @returns {{ label: string, client: object, supports: object|null }[]}
     * @ai.hint pure
     */
    const endpoints = (kind) => [
        endpointOf(primarySpec, primary),
        ...providerList(config).map((item) => {
            const signature = JSON.stringify(item.headers ?? null);
            let found = opened.find((entry) => entry.baseURL === item.baseURL && entry.apiKey === item.apiKey
                && JSON.stringify(entry.headers ?? null) === signature);
            if (!found) {
                found = {
                    ...item,
                    client: create({
                        apiKey: item.apiKey, baseURL: item.baseURL, headers: item.headers, retries: config.retries,
                        idleTimeoutMs: timeouts.idleTimeoutMs, connectTimeoutMs: timeouts.connectTimeoutMs, ...rasterOptions,
                    }),
                };
                opened.push(found);
            }
            return endpointOf(item, found.client);
        }),
    ].filter((endpoint) => supportsRoute(endpoint.supports, kind));
    let active = primary;

    /**
     * @param {object} body
     * @param {object} options
     * @param {'responses'|'images'|'images-edit'|'images-vector'} kind
     */
    const sendBody = (body, options, kind) => {
        const chain = endpoints(kind);
        if (!chain.length) throw new ApiError(`Нет доступного провайдера для маршрута ${kind}.`, { code: 'NO_PROVIDER' });
        return attemptChain({
            endpoints: chain,
            model: body?.model ?? config.model,
            map,
            onWarn: (message) => { try { options?.onEvent?.({ type: 'warning', message }); } catch { /* observer */ } },
            send: (endpoint, model, switchedHost) => {
                active = endpoint.client;
                const next = adaptBody(body ?? {}, model, switchedHost);
                if (kind === 'images') return endpoint.client.images.generate({ ...next, signal: options?.signal });
                if (kind === 'images-edit') return endpoint.client.images.edit({ ...next, signal: options?.signal });
                if (kind === 'images-vector') return endpoint.client.images.vectorize({ ...next, signal: options?.signal });
                return endpoint.client.responses.create(next, options);
            },
        });
    };

    return {
        ...primary,
        responses: {
            ...primary.responses,
            create: (body, options = {}) => sendBody(body, options, 'responses'),
            retrieve: (...args) => active.responses.retrieve(...args),
            cancel: (...args) => active.responses.cancel(...args),
            compact: (...args) => active.responses.compact(...args),
            inputTokens: (...args) => active.responses.inputTokens(...args),
        },
        images: {
            ...primary.images,
            generate: (args = {}) => sendBody(args, { signal: args.signal, onEvent: args.onEvent }, 'images'),
            edit: (args = {}) => sendBody(args, { signal: args.signal, onEvent: args.onEvent }, 'images-edit'),
            vectorize: (args = {}) => sendBody(args, { signal: args.signal, onEvent: args.onEvent }, 'images-vector'),
        },
        decisions: {
            create: async (body, options = {}) => {
                const chain = endpoints('decisions');
                if (!chain.length) {
                    throw new ApiError('Сервис решений недоступен. Шаг пропущен.', { code: 'DECISIONS_UNAVAILABLE', status: 404 });
                }
                const models = [...new Set([body?.model, fallbackModel(body?.model, map)].filter(Boolean))];
                let last = null;
                for (const endpoint of chain) {
                    for (const candidate of models) {
                        try {
                            const raw = await endpoint.client.decisions.create({ ...body, model: candidate }, options);
                            if (candidate !== body?.model) {
                                try { options?.onEvent?.({ type: 'warning', message: `Модель решений заменена на ${candidate}.` }); } catch { /* observer */ }
                            }
                            return raw;
                        } catch (error) {
                            last = error;
                            if (routeMissing(error)) break;
                            if (modelMissing(error)) continue;
                            if (providerDown(error)) break;
                            throw error;
                        }
                    }
                }
                if (last && (routeMissing(last) || modelMissing(last) || providerDown(last))) {
                    throw new ApiError('Сервис решений недоступен. Шаг пропущен.', { code: 'DECISIONS_UNAVAILABLE', status: last.status ?? 404, cause: last });
                }
                throw last ?? new ApiError('Сервис решений недоступен. Шаг пропущен.', { code: 'DECISIONS_UNAVAILABLE', status: 404 });
            },
        },
        moderations: {
            create: async (body, options = {}) => {
                const chain = endpoints('moderations');
                let last = null;
                for (const endpoint of chain) {
                    try {
                        return await endpoint.client.moderations.create(body, options);
                    } catch (error) {
                        last = error;
                        if (routeMissing(error) || providerDown(error)) continue;
                        throw error;
                    }
                }
                throw last ?? new ApiError('Сервис модерации недоступен.', { code: 'MODERATION_UNAVAILABLE', status: 404 });
            },
        },
        close: () => {
            primary.close();
            for (const entry of opened) entry.client.close();
        },
    };
}
