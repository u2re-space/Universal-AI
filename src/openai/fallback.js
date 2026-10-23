/**
 * @file src/openai/fallback.js
 * @module openai/fallback
 * @purpose Try another model channel, then another OpenAI-compatible host, when the first choice is unavailable.
 * @depends openai/client, openai/errors, openai/model-map, core/config
 * @usedBy commands/shared
 * @exports MODEL_FALLBACKS, fallbackModel, modelMissing, providerDown, routeMissing, attemptChain, providerList, createFallbackClient
 * @ai.tags openai, fallback
 * @ai.hint io
 * @changed 2026-10-17 A missing model can move to anthropic. A dead host can move to another base URL.
 */

import { createClient } from './client.js';
import { ApiError } from './errors.js';
import { isReasoningModel, supportsVerbosity } from '../core/config.js';
import { MODEL_FALLBACKS } from './model-map.js';

/** Default stand-ins. Keys may be bare or prefixed with openai/. */
export { MODEL_FALLBACKS };

/**
 * Substitute model id, or null when this id has no stand-in.
 * @param {string} model
 * @param {Record<string, string>} [map]
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function fallbackModel(model, map = MODEL_FALLBACKS) {
    const name = String(model ?? '').trim();
    if (!name || !map) return null;
    if (typeof map[name] === 'string' && map[name].trim() && map[name] !== name) return map[name].trim();
    const bare = name.replace(/^openai\//, '');
    const prefixed = bare === name ? `openai/${name}` : bare;
    const alt = map[prefixed];
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
    return [401, 402, 403, 408, 425, 429, 500, 502, 503, 504].includes(error?.status);
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
 * Hosts to try after the primary one. Entries without a key are skipped.
 * @param {object} config
 * @param {object} [env]
 * @returns {{ baseURL: string, apiKey: string }[]}
 * @exports
 * @ai.hint pure
 */
export function providerList(config, env = process.env) {
    if (config?.fallback?.enabled === false) return [];
    const listed = Array.isArray(config?.fallback?.providers) ? config.fallback.providers : [];
    const extra = env.AI_FALLBACK_BASE_URL && env.AI_FALLBACK_API_KEY
        ? [{ baseURL: env.AI_FALLBACK_BASE_URL, apiKey: env.AI_FALLBACK_API_KEY }]
        : [];
    const seen = new Set([String(config?.baseURL ?? '').replace(/\/+$/, '')]);
    const out = [];
    for (const item of [...listed, ...extra]) {
        const baseURL = String(item?.baseURL ?? '').trim();
        const apiKey = item?.apiKey || (item?.env ? env[item.env] : '') || '';
        const normalized = baseURL.replace(/\/+$/, '');
        if (!baseURL || !apiKey || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push({ baseURL, apiKey });
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
    const alts = [...new Set([model, fallbackModel(model, map)].filter(Boolean))];
    let last = null;
    for (let host = 0; host < endpoints.length; host++) {
        for (let index = 0; index < alts.length; index++) {
            const candidate = alts[index];
            try {
                const result = await send(endpoints[host], candidate, host > 0);
                if (candidate !== model) onWarn(`Модель ${model} недоступна. Запрос ушёл в ${candidate}.`);
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
    const primary = create({
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY, baseURL: config.baseURL, ...timeouts,
    });
    const opened = [];
    const map = config.fallback?.models ?? MODEL_FALLBACKS;
    const endpoints = () => [
        { label: config.baseURL, client: primary },
        ...providerList(config).map((item) => {
            let found = opened.find((entry) => entry.baseURL === item.baseURL && entry.apiKey === item.apiKey);
            if (!found) {
                found = { ...item, client: create({ apiKey: item.apiKey, baseURL: item.baseURL, retries: config.retries, idleTimeoutMs: timeouts.idleTimeoutMs, connectTimeoutMs: timeouts.connectTimeoutMs }) };
                opened.push(found);
            }
            return { label: item.baseURL, client: found.client };
        }),
    ];
    let active = primary;

    /**
     * @param {object[]} chain
     * @param {object} body
     * @param {object} options
     * @param {'responses'|'images'} kind
     */
    const sendBody = (chain, body, options, kind) => attemptChain({
        endpoints: chain,
        model: body?.model ?? config.model,
        map,
        onWarn: (message) => { try { options?.onEvent?.({ type: 'warning', message }); } catch { /* observer */ } },
        send: (endpoint, model, switchedHost) => {
            active = endpoint.client;
            const next = adaptBody(body ?? {}, model, switchedHost);
            if (kind === 'images') return endpoint.client.images.generate({ ...next, signal: options?.signal });
            return endpoint.client.responses.create(next, options);
        },
    });

    return {
        ...primary,
        responses: {
            ...primary.responses,
            create: (body, options = {}) => sendBody(endpoints(), body, options, 'responses'),
            retrieve: (...args) => active.responses.retrieve(...args),
            cancel: (...args) => active.responses.cancel(...args),
            compact: (...args) => active.responses.compact(...args),
            inputTokens: (...args) => active.responses.inputTokens(...args),
        },
        images: {
            ...primary.images,
            generate: (args = {}) => sendBody(endpoints(), args, { signal: args.signal, onEvent: args.onEvent }, 'images'),
        },
        decisions: {
            create: async (body, options = {}) => {
                const models = [...new Set([body?.model, fallbackModel(body?.model, map)].filter(Boolean))];
                let last = null;
                for (const candidate of models) {
                    try {
                        const raw = await primary.decisions.create({ ...body, model: candidate }, options);
                        if (candidate !== body?.model) {
                            try { options?.onEvent?.({ type: 'warning', message: `Модель решений заменена на ${candidate}.` }); } catch { /* observer */ }
                        }
                        return raw;
                    } catch (error) {
                        last = error;
                        if (routeMissing(error)) break;
                        if (modelMissing(error)) continue;
                        throw error;
                    }
                }
                if (last && (routeMissing(last) || modelMissing(last))) {
                    throw new ApiError('Сервис решений недоступен. Шаг пропущен.', { code: 'DECISIONS_UNAVAILABLE', status: last.status ?? 404, cause: last });
                }
                throw last;
            },
        },
        close: () => {
            primary.close();
            for (const entry of opened) entry.client.close();
        },
    };
}
