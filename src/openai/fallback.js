/**
 * @file src/openai/fallback.js
 * @module openai/fallback
 * @purpose Try another model channel, then another OpenAI-compatible host, when the first choice is unavailable.
 * @depends openai/client, openai/errors, openai/model-map, core/config
 * @usedBy commands/shared
 * @exports MODEL_FALLBACKS, fallbackModel, modelMissing, providerDown, routeMissing, supportsRoute, servesRoute, chatOptionsFor, attemptChain, providerList, primaryBackend, createFallbackClient
 * @ai.tags openai, fallback, chat
 * @ai.hint io
 * @changed 2026-11-04 A host that only answers /v1/chat/completions stays in the chain for the responses route.
 * @changed 2026-11-04 Route pools: providerList/primaryBackend accept `kind` to read from named backends.
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

//
function unprefixModel(name) {
    const parts = name.split('/');
    if (parts?.[1]) return parts?.[1];
    return name?.replace?.(/^openai\//, '') || name;
}

//
function makePrefixed(bare) {
    if (bare?.startsWith?.("gpt-")) return `openai/${bare}`;
    if (bare?.startsWith?.("claude-")) return `anthropic/${bare}`;
    return bare;
}

/**
 * Substitute model id, or null when this id has no stand-in.
 * @param {string} model
 * @param {Record<string, string>} [map]
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function fallbackModel(model, map = MODEL_FALLBACKS, host = "default") {
    const name = String(model ?? '').trim();
    if (!name || !map) return null;
    if (typeof map[name] === 'string' && map[name].trim() && map[name] !== name) return map[name].trim();
    const bare = unprefixModel(name);
    const prefixed = bare === name ? makePrefixed(name) : bare;
    const alt = ((!triedMap.get(host || "default")?.has?.(name)) ? prefixed : null) || map[name];
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
 * `images-edit` and `images-vector` share the `images` switch. Both the plain route name and the
 * `decisionAPI` / `imageAPI` spellings a backend entry may use are honored, because a switch that
 * silently matched nothing left an unsupported host in the chain.
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
    if (key === 'images' && Object.hasOwn(supports, 'imageAPI')) return supports.imageAPI !== false;
    return supports[key] !== false;
}

/**
 * Whether a host can carry a route, counting the chat transport: an entry with
 * `responses: false, chat: true` has no /v1/responses but still answers the same request on
 * /v1/chat/completions, so it stays in the chain.
 * @param {object|null|undefined} supports
 * @param {string} kind
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function servesRoute(supports, kind) {
    if (supportsRoute(supports, kind)) return true;
    return kind === 'responses' && supportsRoute(supports, 'chat');
}

/**
 * Chat switches for one host. A backend that declares `responses: false` while keeping `chat`
 * starts on /v1/chat/completions at once, instead of paying for a refused /responses call first.
 * @param {object} config
 * @param {object|null|undefined} supports
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function chatOptionsFor(config, supports = null) {
    const options = { ...(config?.chat ?? {}) };
    const chatWanted = options.enabled !== false && options.force !== true;
    if (chatWanted && !supportsRoute(supports, 'responses') && supportsRoute(supports, 'chat')) options.force = true;
    return options;
}

/**
 * The backend pool for a route plus whether it is a named branch.
 * A named branch (`imagesBackends`, `decisionsBackends`, `completionsBackends`, `moderationsBackends`)
 * replaces the whole pool, so its own first entry is the primary host of that route.
 * `backends` and the legacy `fallback.providers` are the default pool: the top-level URL stays
 * the primary there, exactly as before the branches existed.
 * @param {object} config
 * @param {string} kind
 * @returns {{ list: object[], named: boolean }}
 * @ai.hint pure
 */
function poolOf(config, kind) {
    const key = kind === 'images-edit' || kind === 'images-vector' ? 'images' : kind;
    const branchName = { images: 'imagesBackends', decisions: 'decisionsBackends', completions: 'completionsBackends', moderations: 'moderationsBackends' }[key];
    if (branchName) {
        const branch = config?.[branchName];
        if (Array.isArray(branch) && branch.length) return { list: branch, named: true };
    }
    const backends = config?.backends;
    if (Array.isArray(backends) && backends.length) return { list: backends, named: false };
    // Deprecated pool: still read so a config that never migrated keeps working.
    return { list: Array.isArray(config?.fallback?.providers) ? config.fallback.providers : [], named: false };
}

/**
 * The backend pool that carries a route kind. A named pool overrides `backends` when set and
 * non-empty; an empty or absent pool falls back to `backends`. When both are empty, the legacy
 * `fallback.providers` is read as a soft fallback (deprecated; new configs should use `backends`).
 * @param {object} config
 * @param {string} kind
 * @returns {object[]}
 * @ai.hint pure
 */
function poolFor(config, kind) {
    return poolOf(config, kind).list;
}

/**
 * One backend entry with a key, or null when it cannot be used.
 * The key of an `env` entry is read from the live environment, so a value that exists only in
 * `.env` is found — `process.env` never sees it.
 * @param {object} item
 * @param {object} env
 * @returns {{ baseURL: string, apiKey: string, headers?: object, body?: object, supports?: object } | null}
 * @ai.hint pure
 */
function usableBackend(item, env) {
    const baseURL = String(item?.baseURL ?? '').trim();
    const apiKey = item?.apiKey || (item?.env ? env[item.env] : '') || '';
    if (!baseURL || !apiKey) return null;
    const entry = { baseURL, apiKey };
    if (item.headers && typeof item.headers === 'object') entry.headers = item.headers;
    if (item.body && typeof item.body === 'object') entry.body = item.body;
    if (item.supports && typeof item.supports === 'object') entry.supports = item.supports;
    return entry;
}

/**
 * Hosts to try after the primary one. Entries without a key are skipped.
 * `kind` selects the pool: an empty named pool falls back to `backends`.
 * @param {object} config
 * @param {object} [env]
 * @param {string} [kind='responses']
 * @returns {{ baseURL: string, apiKey: string, headers?: object, body?: object, supports?: object }[]}
 * @exports
 * @ai.hint pure
 */
export function providerList(config, env = liveEnv(), kind = 'responses') {
    if (config?.fallback?.enabled === false) return [];
    const declared = poolFor(config, kind);
    // The primary of this very pool is skipped: it heads the chain, it is not a fallback of it.
    const primary = primaryBackend(config, kind);
    const primaryURL = String(primary?.baseURL ?? '').replace(/\/+$/, '');
    const primaryKey = String(primary?.apiKey ?? '');
    const seen = new Set();
    const out = [];
    for (const item of declared) {
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
 * The primary backend entry, including its custom headers, extra body fields and route switches.
 * `kind` selects the pool. A named branch (`imagesBackends`, `decisionsBackends`, …) owns its route
 * outright, so when it does not name the top-level host its first usable entry becomes the primary
 * of that route. The default pool (`backends`, legacy `fallback.providers`) never displaces the
 * top-level URL: that host is the primary and the list only adds the fallbacks after it.
 * @param {object} config
 * @param {string} [kind='responses']
 * @returns {{ baseURL: string, apiKey: string, headers?: object|null, body?: object|null, supports?: object|null }}
 * @exports
 * @ai.hint pure
 */
export function primaryBackend(config, kind = 'responses') {
    const { list: pool, named } = poolOf(config, kind);
    const topLevel = {
        baseURL: config.baseURL,
        apiKey: config.apiKey ?? envValue('OPENAI_API_KEY'),
        headers: null,
        body: null,
        supports: null,
    };
    const match = pool.find((item) => item?.baseURL === config.baseURL && String(item.apiKey ?? '') === String(config.apiKey ?? ''))
        ?? pool.find((item) => item?.baseURL === config.baseURL);
    if (match) {
        return {
            baseURL: match.baseURL,
            apiKey: match.apiKey ?? envValue('OPENAI_API_KEY'),
            headers: match.headers ?? null,
            body: match.body ?? null,
            supports: match.supports ?? null,
        };
    }
    if (!named) return topLevel;
    return usableBackend(pool[0], liveEnv()) ?? topLevel;
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
    /** Chat transport switches, shared by every host this router opens. */
    const primarySpec = primaryBackend(config, 'responses');
    const rasterOptions = { magickPath: config.magickPath ?? null, rasterEngine: config.image?.rasterEngine ?? 'auto', imageDiv16: config.image?.div16 ?? null, imageSizeHint: config.image?.sizeHint ?? 'auto' };
    const primary = create({
        apiKey: primarySpec.apiKey, baseURL: primarySpec.baseURL, headers: primarySpec.headers, body: primarySpec.body,
        chat: chatOptionsFor(config, primarySpec.supports), ...timeouts, ...rasterOptions,
    });
    const fallbackClients = new Map();
    /**
     * Client by spec key (baseURL + apiKey). Caches clients so the same host isn't opened twice.
     * @param {object} spec
     * @returns {object}
     * @ai.hint io
     */
    const clientForSpec = (spec) => {
        const key = `${spec.baseURL.replace(/\/+$/, '')}\u0000${spec.apiKey}`;
        let c = fallbackClients.get(key);
        if (!c) {
            c = create({
                apiKey: spec.apiKey, baseURL: spec.baseURL, headers: spec.headers, body: spec.body,
                chat: chatOptionsFor(config, spec.supports), ...timeouts, ...rasterOptions,
            });
            fallbackClients.set(key, c);
        }
        return c;
    };
    const opened = new Map();
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
    const endpoints = (kind) => {
        const primaryForPool = primaryBackend(config, kind);
        const primaryClient = (primaryForPool.baseURL === primarySpec.baseURL && primaryForPool.apiKey === primarySpec.apiKey)
            ? primary
            : clientForSpec(primaryForPool);
        const chain = [
            endpointOf(primaryForPool, primaryClient),
            ...providerList(config, liveEnv(), kind).map((item) => {
                const poolKey = `${kind}\u0000${item.baseURL.replace(/\/+$/, '')}\u0000${item.apiKey}`;
                let found = opened.get(poolKey);
                if (!found) {
                    found = {
                        ...item,
                        client: create({
                            apiKey: item.apiKey, baseURL: item.baseURL, headers: item.headers, body: item.body,
                            chat: chatOptionsFor(config, item.supports), retries: config.retries,
                            idleTimeoutMs: timeouts.idleTimeoutMs, connectTimeoutMs: timeouts.connectTimeoutMs, ...rasterOptions,
                        }),
                    };
                    opened.set(poolKey, found);
                }
                return endpointOf(item, found.client);
            }),
        ];
        return chain.filter((endpoint) => servesRoute(endpoint.supports, kind));
    };
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
        chat: {
            /** Force the chat transport on the host that answered last. */
            create: (body, options = {}) => active.chat.create(body, options),
            get isFallback() { return active.transport === 'chat'; },
        },
        /** Route of the host that answered last: `responses` or `chat`. */
        get transport() { return active.transport ?? 'responses'; },
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
            for (const entry of opened.values()) entry.client.close();
            for (const client of fallbackClients.values()) try { client.close(); } catch { /* */ }
        },
    };
}
