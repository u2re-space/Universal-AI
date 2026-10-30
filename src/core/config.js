/**
 * @file src/core/config.js
 * @module core/config
 * @purpose Load, validate, and redact configuration, and resolve per-role settings.
 * @depends node:os, node:path, node:fs/promises, util/text, core/config-defaults, core/placeholders, generate/platform, mcp/servers, channels/questions
 * @usedBy cli, commands/shared, commands/flags, commands/ask, commands/run, commands/chat, commands/misc, agent/loop, agent/roles
 * @exports APPROVAL_LEVELS, IMAGE_DETAILS, REASONING_EFFORTS, REASONING_SUMMARIES, ROLE_NAMES, BUILTIN_ROLE_NAMES, roleNames, defaults, resolveRole, defaultHome, loadConfig, isReasoningModel, supportsVerbosity, redactConfig
 * @ai.tags config
 * @ai.hint io
 * @changed 2026-10-26 Model ceilings, word context levels, user-defined roles, and the stage pipeline.
 */
import os from 'node:os';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { deepMerge, isRecord } from '../util/text.js';
import { PLATFORMS } from '../generate/platform.js';
import { normalizeMcpServer } from '../mcp/servers.js';
import { PRESET_NAMES } from '../channels/questions.js';
import {
    APPROVAL_LEVELS,
    IMAGE_DETAILS,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    ROLE_NAMES,
    BUILTIN_ROLE_NAMES,
    CUSTOM_ROLE_NAME,
    roleNames,
    defaults,
} from './config-defaults.js';
import { COMPLETION_MODEL_CHOICES, resolveCompletionModel } from '../complete/models.js';
import { assertPaceBudget, FINE_QUALITY_KEYS } from '../agent/pace.js';
import { FORBIDDEN_MODELS as REVIEWER_FORBIDDEN, safeReviewerModel } from '../roles/reviewer.js';
import { profileFor, snapEffort, lowerEffort, contextBytes, DEFAULT_PROFILE } from '../openai/model-profiles.js';
import { tierChoice } from './role-tiers.js';
import { PIPELINE_STAGE_IDS } from '../agent/pipeline.js';
import { expandConfigStrings } from './placeholders.js';

const KiB = 1024;

/** Route switches a backend may turn off. `decisionAPI` is the older spelling of `decisions`. */
const BACKEND_ROUTES = Object.freeze(['decisions', 'responses', 'images', 'moderations']);
const SUPPORT_ALIASES = Object.freeze({
    decisionapi: 'decisions', decisions: 'decisions',
    responseapi: 'responses', responses: 'responses',
    imageapi: 'images', images: 'images',
    moderationapi: 'moderations', moderations: 'moderations',
});
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export {
    APPROVAL_LEVELS,
    IMAGE_DETAILS,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    ROLE_NAMES,
    BUILTIN_ROLE_NAMES,
    CUSTOM_ROLE_NAME,
    roleNames,
    defaults,
};


/**
 * Effective settings for a role: role → role tier → roles.default → top-level configuration.
 * `complexity` picks `roles.<name>.tiers.<trivial|normal|complex>` in either accepted shape (a
 * model ladder with its effort levels, or one entry per tier); an explicit role model or effort
 * still wins over the tier. Returns a config-like object usable by runTurn (same shape as the main
 * config). Effort is snapped to the model ladder and capped by the stricter of the model ceiling
 * and the role ceiling (roles.<name>.maxEffort).
 * @param {object} config
 * @param {string} [name]
 * @param {'trivial'|'normal'|'complex'|null} [complexity]
 * @returns {object}
 */
export function resolveRole(config, name = 'default', complexity = null) {
    const base = config.roles?.default ?? {};
    const role = config.roles?.[name] ?? {};
    const tier = tierChoice(role.tiers, complexity);
    const pick = (key, fallback) => role[key] ?? tier?.[key] ?? (name !== 'default' ? base[key] : undefined) ?? fallback;
    const model = name === 'reviewer' ? safeReviewerModel(pick('model', config.model)) : pick('model', config.model);
    const profile = profileFor(model, config.models);
    const ceiling = lowerEffort(profile.ceiling, pick('maxEffort', null));
    const effort = snapEffort(pick('effort', config.reasoning.effort), { ...profile, ceiling });
    const summary = pick('summary', config.reasoning.summary);
    const verbosity = pick('verbosity', config.verbosity);
    const maxOutputTokens = pick('maxOutputTokens', config.maxOutputTokens);
    /** The profile's answer limit: an explicit role cap is never raised above what the model accepts. */
    const outputLimit = maxOutputTokens != null ? Math.min(maxOutputTokens, profile.maxOutput) : null;
    const temperature = pick('temperature', config.temperature);
    /** Resolve the per-role context level to bytes; null means the shared agent budget. */
    const rawContext = pick('context', null);
    const context = rawContext != null ? contextBytes(rawContext, profile) : null;
    return {
        name, model, effort, summary, verbosity, maxOutputTokens: outputLimit, temperature,
        /** The ceiling that bounded this role: the stricter of model ceiling and roles.<name>.maxEffort. */
        ceiling,
        /** The model's own answer limit from its profile. */
        maxOutput: profile.maxOutput,
        /** Context budget in bytes for this role; null means the shared agent budget. */
        context,
        instructions: role.instructions ?? null,
        /** Tools the role may use; null means the tools of the run. */
        tools: role.tools ?? null,
        /** A config object with this role's settings applied (for runTurn / buildRequestBody). */
        config: {
            ...config, model,
            reasoning: { effort, summary },
            verbosity, maxOutputTokens: outputLimit, temperature,
        },
    };
}

/**
 * Agent home directory: AI_AGENT_HOME, or ~/.ai-agent.
 * @param {object} [env]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function defaultHome(env = process.env) {
    return env.AI_AGENT_HOME ? path.resolve(env.AI_AGENT_HOME) : path.join(os.homedir(), '.ai-agent');
}

/**
 * Read one config JSON object. Unknown keys are rejected. A missing file is `{}` when optional.
 * @param {string} file
 * @param {{ optional?: boolean }} [options]
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function readJsonFile(file, { optional = false } = {}) {
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
        if (optional && error.code === 'ENOENT') return {};
        throw new Error(`Не удалось прочитать конфигурацию ${file}: ${error.message}`);
    }
    if (Buffer.byteLength(raw) > 256 * KiB) throw new Error(`Конфигурация ${file} больше 256 KiB.`);
    let parsed;
    try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch (error) { throw new Error(`Конфигурация ${file}: некорректный JSON (${error.message}).`); }
    if (!isRecord(parsed)) throw new Error(`Конфигурация ${file} должна быть JSON-объектом.`);
    for (const key of Object.keys(parsed)) {
        if (!(key in defaults)) throw new Error(`Конфигурация ${file}: неизвестный раздел "${key}".`);
    }
    return parsed;
}

/**
 * Configuration fields taken from process environment variables.
 * @param {object} env
 * @returns {object}
 * @ai.hint pure
 */
function fromEnv(env) {
    const result = {};
    if (env.AI_MODEL) result.model = env.AI_MODEL;
    else if (env.OPENAI_MODEL) result.model = env.OPENAI_MODEL;
    if (env.AI_IMAGE_MODEL) result.imageModel = env.AI_IMAGE_MODEL;
    if (env.OPENAI_BASE_URL) result.baseURL = env.OPENAI_BASE_URL;
    if (env.OPENAI_API_KEY) result.apiKey = env.OPENAI_API_KEY;
    if (env.OPENAI_ORG_ID) result.organization = env.OPENAI_ORG_ID;
    if (env.OPENAI_PROJECT_ID) result.project = env.OPENAI_PROJECT_ID;
    if (env.AI_POLL_MS && Number.isSafeInteger(Number(env.AI_POLL_MS))) result.limits = { pollIntervalMs: Number(env.AI_POLL_MS) };
    if (env.AI_DECISION_MODEL) result.decisions = { model: env.AI_DECISION_MODEL };
    if (env.AI_MODERATION_MODE) result.moderation = { mode: env.AI_MODERATION_MODE };
    if (env.TELEGRAM_BOT_TOKEN) result.telegram = { token: env.TELEGRAM_BOT_TOKEN };
    if (env.AI_CHANNELS_TOKEN) result.channels = { token: env.AI_CHANNELS_TOKEN };
    return result;
}

/**
 * Pins come from files and CLI overrides. Built-in defaults are not a source.
 * @param {object[]} sources
 * @returns {{ rolePins: object, stepCapPinned: boolean }}
 * @ai.hint pure
 */
function pinsFrom(sources) {
    const rolePins = {};
    let stepCapPinned = false;
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        if (source.roles && typeof source.roles === 'object') {
            for (const [name, role] of Object.entries(source.roles)) {
                if (!role || typeof role !== 'object') continue;
                const pin = rolePins[name] ?? { model: false, effort: false };
                if (typeof role.model === 'string' && role.model.trim()) pin.model = true;
                if (Object.hasOwn(role, 'effort')) pin.effort = true;
                rolePins[name] = pin;
            }
        }
        if (source.agent && Object.hasOwn(source.agent, 'maxSteps')) stepCapPinned = true;
    }
    return { rolePins, stepCapPinned };
}

/**
 * Fold the retired `collector` and `coordinator` roles into the unified `orchestrator` role.
 * Older configs keep working: their settings migrate to `orchestrator`, and the legacy keys are dropped.
 * An explicit `orchestrator` setting always wins over a legacy one.
 * @param {object} c Merged config (mutated in place).
 * @returns {void}
 * @ai.hint pure
 */
function migrateLegacyRoles(c) {
    if (isRecord(c.roles)) {
        for (const legacy of ['collector', 'coordinator']) {
            if (!isRecord(c.roles[legacy])) continue;
            const merged = { ...c.roles[legacy], ...(c.roles.orchestrator ?? {}) };
            c.roles.orchestrator = merged;
            delete c.roles[legacy];
        }
    }
    if (isRecord(c.agent)) {
        if (c.agent.collectorMaxTurns != null && c.agent.orchestratorMaxTurns == null) {
            c.agent.orchestratorMaxTurns = c.agent.collectorMaxTurns;
        }
        delete c.agent.collectorMaxTurns;
        if (isRecord(c.agent.coordinator)) {
            c.agent.orchestrator = { ...c.agent.coordinator, ...(c.agent.orchestrator ?? {}) };
            delete c.agent.coordinator;
        }
    }
}

/**
 * Resolve word-level context values to byte counts.
 * Called in `loadConfig` after the deep-merge and before validation, so a user can write
 * `"agent.maxContextBytes": "large"` and the rest of the system sees a number.
 * `auto` takes the window of the configured model.
 * @param {object} c — the merged configuration (mutated in place)
 * @returns {void}
 * @ai.hint pure
 */
function normalizeContext(c) {
    const model = typeof c.model === 'string' && c.model.trim() ? c.model : 'gpt-6.1-terra';
    const profile = profileFor(model, c.models);
    const fields = [
        ['agent', 'maxContextBytes'],
        ['agent', 'measurerMaxContextBytes'],
        ['agent', 'orchestrator', 'maxContextBytes'],
        ['completion', 'maxContextBytes'],
        ['limits', 'maxRequestBytes'],
    ];
    for (const path of fields) {
        const last = path.at(-1);
        let owner = c;
        for (const step of path.slice(0, -1)) {
            owner = owner?.[step];
        }
        if (isRecord(owner) && Object.hasOwn(owner, last)) {
            owner[last] = contextBytes(owner[last], profile);
        }
    }
}

/**
 * Normalize a `supports` map: route names are case-insensitive and `decisionAPI` becomes `decisions`.
 * Unknown keys are kept so validation can reject them.
 * @param {unknown} value
 * @returns {unknown}
 * @ai.hint pure
 */
function normalizeSupports(value) {
    if (!isRecord(value)) return value;
    const out = {};
    for (const [key, flag] of Object.entries(value)) {
        out[SUPPORT_ALIASES[key.toLowerCase()] ?? key] = flag;
    }
    return out;
}

/**
 * Stringify header values (`useWalletBalance: true` becomes `"true"`). Other types stay for validation.
 * @param {unknown} value
 * @returns {unknown}
 * @ai.hint pure
 */
function normalizeHeaderValues(value) {
    if (!isRecord(value)) return value;
    const out = {};
    for (const [name, item] of Object.entries(value)) {
        out[name] = typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? String(item) : item;
    }
    return out;
}

/**
 * Read `baseUrl`/`baseURL`, `headers`, and `supports` of a backend list without changing its order.
 * @param {unknown} list
 * @returns {unknown}
 * @ai.hint pure
 */
function normalizeBackendEntries(list) {
    if (!Array.isArray(list)) return list;
    return list.map((item) => {
        if (!isRecord(item)) return item;
        const { baseUrl, baseURL, headers, supports, ...rest } = item;
        const out = { ...rest };
        if (baseUrl !== undefined || baseURL !== undefined) out.baseURL = baseUrl ?? baseURL;
        if (headers !== undefined) out.headers = normalizeHeaderValues(headers);
        if (supports !== undefined) out.supports = normalizeSupports(supports);
        return out;
    });
}

/**
 * Normalize `backends` and the legacy `fallback.providers`, then make the first usable backend the
 * primary host. A backend is usable when it has a URL and a key; the key may be written in `apiKey`
 * or named by `env`. A list with no key at all keeps the top-level key and URL from the first entry.
 * @param {object} c Merged config (mutated in place).
 * @param {object|null} [env] Environment for `env` entries.
 * @returns {void}
 * @ai.hint pure
 */
function normalizeBackends(c, env = null) {
    c.backends = normalizeBackendEntries(c.backends);
    if (isRecord(c.fallback)) c.fallback.providers = normalizeBackendEntries(c.fallback.providers);
    if (!Array.isArray(c.backends) || !c.backends.length) return;
    const keyOf = (item) => {
        if (typeof item?.apiKey === 'string' && item.apiKey.trim()) return item.apiKey;
        const value = item?.env && env ? env[item.env] : null;
        return value == null ? '' : String(value);
    };
    const withURL = c.backends.filter((item) => isRecord(item) && typeof item.baseURL === 'string' && item.baseURL.trim());
    const primary = withURL.find((item) => keyOf(item)) ?? withURL[0];
    if (!primary) return;
    c.baseURL = primary.baseURL;
    const key = keyOf(primary);
    if (key) c.apiKey = key;
}

/**
 * Resolve the effective configuration.
 * Precedence: defaults < ~/.ai-agent/config.json < --config file < environment < overrides (CLI).
 * The CLI passes environment after reading .env and repairing a split Windows credential pair.
 * @param {{ configPath?: string|null, overrides?: object, env?: object|null, ensureHome?: boolean, cwd?: string }} [options]
 * @returns {Promise<object>}
 */
export async function loadConfig({ configPath = null, overrides = {}, env = null, ensureHome = true, cwd = process.cwd() } = {}) {
    env ??= liveEnv() ?? process.env;
    const home = defaultHome(env);
    const homeConfig = await readJsonFile(path.join(home, 'config.json'), { optional: true });
    const fileConfig = configPath ? await readJsonFile(path.resolve(configPath)) : {};
    let config = [homeConfig, fileConfig, fromEnv(env), overrides].reduce((acc, extra) => deepMerge(acc, extra), structuredClone(defaults));
    config = await expandConfigStrings(config, {
        env, root: cwd,
        maxBytes: Number.isSafeInteger(config.limits?.maxFileReadBytes) ? config.limits.maxFileReadBytes : 256 * KiB,
    });
    config.home = home;
    migrateLegacyRoles(config);
    normalizeBackends(config, env);
    config.baseURL ||= 'https://api.openai.com/v1/';
    config.memory.dbFile ||= path.join(home, 'memory.db');
    config.configFiles = [path.join(home, 'config.json'), ...(configPath ? [path.resolve(configPath)] : [])];
    normalizeContext(config);
    validateConfig(config);
    const pins = pinsFrom([homeConfig, fileConfig, overrides]);
    config.rolePins = pins.rolePins;
    config.stepCapPinned = pins.stepCapPinned;
    if (ensureHome) await mkdir(home, { recursive: true });
    return config;
}

/**
 * Validate an optional header map: token names and single-line string values.
 * @param {unknown} headers
 * @param {string} where
 * @param {(message: string) => never} fail
 * @returns {void}
 * @ai.hint pure
 */
function validateHeaders(headers, where, fail) {
    if (headers == null) return;
    if (!isRecord(headers)) fail(`${where} должен быть объектом`);
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name)) fail(`${where}.${name}: некорректное имя заголовка`);
        if (typeof value !== 'string' || /[\r\n]/.test(value)) fail(`${where}.${name}: строка без перевода строки`);
    }
}

/**
 * Validate an optional `supports` map: known routes and boolean flags.
 * @param {unknown} supports
 * @param {string} where
 * @param {(message: string) => never} fail
 * @returns {void}
 * @ai.hint pure
 */
function validateSupports(supports, where, fail) {
    if (supports == null) return;
    if (!isRecord(supports)) fail(`${where} должен быть объектом`);
    for (const [key, value] of Object.entries(supports)) {
        if (!BACKEND_ROUTES.includes(key)) fail(`${where}.${key}: ${BACKEND_ROUTES.join(' | ')}`);
        if (typeof value !== 'boolean') fail(`${where}.${key}: true | false`);
    }
}

/**
 * Validate a backend or provider list.
 * @param {unknown} list
 * @param {string} where
 * @param {(message: string) => never} fail
 * @returns {void}
 * @ai.hint pure
 */
function validateBackends(list, where, fail) {
    if (!Array.isArray(list)) fail(`${where} должен быть массивом`);
    for (const [index, item] of list.entries()) {
        if (!isRecord(item)) fail(`${where}[${index}] должен быть объектом`);
        for (const key of Object.keys(item)) {
            if (!['baseURL', 'apiKey', 'env', 'headers', 'supports'].includes(key)) fail(`${where}[${index}].${key}: неизвестное поле`);
        }
        try { new URL(item.baseURL); } catch { fail(`${where}[${index}].baseURL должен быть URL`); }
        if (item.apiKey != null && (typeof item.apiKey !== 'string' || /[\r\n]/.test(item.apiKey))) fail(`${where}[${index}].apiKey: строка или null`);
        if (item.env != null && (typeof item.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.env))) fail(`${where}[${index}].env: имя переменной или null`);
        validateHeaders(item.headers, `${where}[${index}].headers`, fail);
        validateSupports(item.supports, `${where}[${index}].supports`, fail);
    }
}

/**
 * Throw when a merged config value is outside the accepted enums and ranges.
 * @param {object} c
 * @returns {void}
 * @ai.hint pure
 */
function validateConfig(c) {
    const fail = (message) => { throw new Error(`Конфигурация: ${message}`); };
    if (typeof c.model !== 'string' || !c.model.trim()) fail('укажите model (или AI_MODEL / --model).');
    if (c.imageModel !== null && (typeof c.imageModel !== 'string' || !c.imageModel.trim())) fail('imageModel должен быть строкой.');
    if (!isRecord(c.models)) fail('models должен быть объектом');
    for (const [modelId, profile] of Object.entries(c.models)) {
        if (!isRecord(profile)) fail(`models.${modelId} должен быть объектом`);
        for (const key of Object.keys(profile)) {
            if (!['window', 'maxOutput', 'ceiling', 'efforts'].includes(key)) fail(`models.${modelId}.${key}: неизвестное поле`);
        }
        if (typeof profile.window === 'number' && !(Number.isSafeInteger(profile.window) && profile.window > 0)) fail(`models.${modelId}.window: целое > 0`);
        if (typeof profile.maxOutput === 'number' && !(Number.isSafeInteger(profile.maxOutput) && profile.maxOutput > 0)) fail(`models.${modelId}.maxOutput: целое > 0`);
        if (profile.ceiling !== null && !REASONING_EFFORTS.includes(profile.ceiling)) fail(`models.${modelId}.ceiling: ${REASONING_EFFORTS.join(' | ')}`);
        if (profile.efforts !== null && (!Array.isArray(profile.efforts) || profile.efforts.some((e) => !REASONING_EFFORTS.includes(e)))) fail(`models.${modelId}.efforts: массив уровней`);
    }
    if (c.reasoning.effort !== null && !REASONING_EFFORTS.includes(c.reasoning.effort)) fail(`reasoning.effort: ${REASONING_EFFORTS.join(' | ')}`);
    if (c.reasoning.summary !== null && !REASONING_SUMMARIES.includes(c.reasoning.summary)) fail(`reasoning.summary: ${REASONING_SUMMARIES.join(' | ')}`);
    if (c.verbosity !== null && !['low', 'medium', 'high'].includes(c.verbosity)) fail('verbosity: low | medium | high');
    if (c.temperature !== null && !(Number.isFinite(c.temperature) && c.temperature >= 0 && c.temperature <= 2)) fail('temperature: 0..2');
    if (c.maxOutputTokens !== null && !(Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16)) fail('maxOutputTokens ≥ 16');
    if (typeof c.store !== 'boolean') fail('store: true | false');
    if (!['auto', 'disabled'].includes(c.truncation)) fail('truncation: auto | disabled');
    if (c.approve !== null && !APPROVAL_LEVELS.includes(c.approve)) fail(`approve: ${APPROVAL_LEVELS.join(' | ')}`);
    if (c.shell !== null && !['powershell', 'pwsh', 'bash', 'sh', 'zsh', 'cmd'].includes(c.shell)) fail('shell: powershell | pwsh | bash | sh | zsh | cmd');
    if (c.magickPath !== null && (typeof c.magickPath !== 'string' || c.magickPath.trim() === '')) fail('magickPath: непустая строка или null');
    if (!Number.isSafeInteger(c.retries) || c.retries < 0 || c.retries > 10) fail('retries: 0..10');
    if (!isRecord(c.fallback)) fail('fallback должен быть объектом');
    if (typeof c.fallback.enabled !== 'boolean') fail('fallback.enabled: true | false');
    if (!isRecord(c.fallback.models)) fail('fallback.models должен быть объектом');
    for (const [key, value] of Object.entries(c.fallback.models)) {
        if (typeof key !== 'string' || !key.trim() || typeof value !== 'string' || !value.trim()) fail(`fallback.models.${key} должен быть непустой строкой`);
    }
    if (!Array.isArray(c.backends)) fail('backends должен быть массивом');
    validateBackends(c.backends, 'backends', fail);
    validateBackends(c.fallback.providers, 'fallback.providers', fail);
    for (const [key, value] of Object.entries(c.limits)) {
        if (!(key in defaults.limits)) fail(`неизвестный лимит limits.${key}`);
        if (key === 'budgetUsd') { if (value !== null && !(Number.isFinite(value) && value > 0)) fail('limits.budgetUsd > 0'); continue; }
        if (key === 'budgetTokens') { if (value !== null && !(Number.isSafeInteger(value) && value > 0)) fail('limits.budgetTokens > 0'); continue; }
        if (key === 'extendTurns') { if (!Number.isSafeInteger(value) || value < 0) fail('limits.extendTurns: целое ≥ 0'); continue; }
        if (!Number.isSafeInteger(value) || value <= 0) fail(`limits.${key} должен быть положительным целым`);
    }
    if (c.limits.maxTurns > 1000) fail('limits.maxTurns ≤ 1000');
    for (const [key, value] of Object.entries(c.tools)) {
        if (!(key in defaults.tools) || typeof value !== 'boolean') fail(`tools.${key}: true | false`);
    }
    if (!isRecord(c.desktop)) fail('desktop должен быть объектом');
    for (const key of Object.keys(c.desktop)) {
        if (!(key in defaults.desktop)) fail(`неизвестный параметр desktop.${key}`);
    }
    if (c.desktop.ahkPath !== null && (typeof c.desktop.ahkPath !== 'string' || c.desktop.ahkPath.trim() === '')) {
        fail('desktop.ahkPath: непустая строка или null');
    }
    if (typeof c.desktop.shotAfterAction !== 'boolean') fail('desktop.shotAfterAction: true | false');
    if (typeof c.desktop.unsafeScreenshot !== 'boolean') fail('desktop.unsafeScreenshot: true | false');
    if (!['png', 'webp', 'jpeg'].includes(c.image.format)) fail('image.format: png | webp | jpeg');
    if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.image.quality)) fail('image.quality: auto | low | medium | high | xhigh | max');
    if (!['auto', 'transparent', 'opaque'].includes(c.image.background)) fail('image.background: auto | transparent | opaque');
    if (!(c.image.size === 'auto' || /^\d{2,4}x\d{2,4}$/.test(c.image.size))) fail('image.size: auto | WIDTHxHEIGHT');
    if (!Number.isSafeInteger(c.image.partialImages) || c.image.partialImages < 0 || c.image.partialImages > 3) fail('image.partialImages: 0..3');
    if (c.image.transport != null && c.image.transport !== 'images' && c.image.transport !== 'responses') fail('image.transport: images | responses');
    if (!['auto', 'sharp', 'canvas', 'magick'].includes(c.image.rasterEngine)) fail('image.rasterEngine: auto | sharp | canvas | magick');
    if (c.image.maskModel != null && (typeof c.image.maskModel !== 'string' || !c.image.maskModel.trim())) fail('image.maskModel: непустая строка или null');
    if (c.image.vectorModel != null && (typeof c.image.vectorModel !== 'string' || !c.image.vectorModel.trim())) fail('image.vectorModel: непустая строка или null');
    if (!Number.isSafeInteger(c.image.vectorMaxColors) || c.image.vectorMaxColors < 2 || c.image.vectorMaxColors > 65536) fail('image.vectorMaxColors: 2..65536');
    if (!['auto', 'mask', 'contour', 'flat', 'off'].includes(c.image.alphaMode)) fail('image.alphaMode: auto | mask | contour | flat | off');
    if (typeof c.image.paintBackground !== 'boolean') fail('image.paintBackground: true | false');
    if (typeof c.image.autoVectorize !== 'boolean') fail('image.autoVectorize: true | false');
    if (typeof c.image.alphaFeather !== 'number' || c.image.alphaFeather < 0 || c.image.alphaFeather > 8) fail('image.alphaFeather: 0..8');
    if (!Number.isSafeInteger(c.image.pngMaxBytes) || c.image.pngMaxBytes < 64 * KiB || c.image.pngMaxBytes > 64 * 1024 * KiB) fail('image.pngMaxBytes: 64 KiB..64 MiB');
    if (c.webSearch.contextSize != null && !['low', 'medium', 'high'].includes(c.webSearch.contextSize)) fail('webSearch.contextSize: null | low | medium | high');
    if (!isRecord(c.documentation)) fail('documentation должен быть объектом');
    for (const key of Object.keys(c.documentation)) if (!['sources', 'roles'].includes(key)) fail(`неизвестный параметр documentation.${key}`);
    if (!isRecord(c.documentation.sources)) fail('documentation.sources должен быть объектом');
    for (const [name, url] of Object.entries(c.documentation.sources)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) fail(`documentation.sources.${name}: некорректное имя`);
        if (typeof url !== 'string' || !url.trim()) fail(`documentation.sources.${name}: URL должен быть непустой строкой`);
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) fail(`documentation.sources.${name}: разрешены только HTTP(S) URL`);
        } catch { fail(`documentation.sources.${name}: некорректный HTTP(S) URL`); }
    }
    if (!isRecord(c.documentation.roles)) fail('documentation.roles должен быть объектом');
    for (const [name, sources] of Object.entries(c.documentation.roles)) {
        if (!['planner', 'architect', 'orchestrator', 'worker', 'coder', 'styler', 'iconifier', 'decomposer', 'measurer', 'image-processor'].includes(name)) fail(`documentation.roles.${name}: неизвестная встроенная роль`);
        if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string' || !Object.hasOwn(c.documentation.sources, source))) {
            fail(`documentation.roles.${name}: список имён из documentation.sources`);
        }
    }
    if (typeof c.compaction.auto !== 'boolean' || !Number.isSafeInteger(c.compaction.afterInputTokens) || c.compaction.afterInputTokens < 1000) {
        fail('compaction: { auto: boolean, afterInputTokens ≥ 1000 }');
    }
    if (!isRecord(c.roles)) fail('roles должен быть объектом');
    if (Object.hasOwn(c.roles, 'scanner')) delete c.roles.scanner;
    for (const [name, role] of Object.entries(c.roles)) {
        // A name the code does not know is a user-defined role, not an error, as long as the slug is sane.
        if (!BUILTIN_ROLE_NAMES.includes(name) && !CUSTOM_ROLE_NAME.test(name)) {
            fail(`roles.${name}: имя своей роли — ${CUSTOM_ROLE_NAME.source} (до 32 символов, строчные)`);
        }
        if (!isRecord(role)) fail(`roles.${name} должен быть объектом`);
        for (const key of Object.keys(role)) if (!(key in defaults.roles.default)) fail(`roles.${name}.${key}: неизвестное поле`);
        if (role.model !== null && role.model !== undefined && (typeof role.model !== 'string' || !role.model.trim())) fail(`roles.${name}.model должен быть строкой`);
        if (role.effort != null && !REASONING_EFFORTS.includes(role.effort)) fail(`roles.${name}.effort: ${REASONING_EFFORTS.join(' | ')}`);
        if (role.summary != null && !REASONING_SUMMARIES.includes(role.summary)) fail(`roles.${name}.summary: ${REASONING_SUMMARIES.join(' | ')}`);
        if (role.verbosity != null && !['low', 'medium', 'high'].includes(role.verbosity)) fail(`roles.${name}.verbosity: low | medium | high`);
        if (role.temperature != null && !(Number.isFinite(role.temperature) && role.temperature >= 0 && role.temperature <= 2)) fail(`roles.${name}.temperature: 0..2`);
        if (role.maxOutputTokens != null && !(Number.isSafeInteger(role.maxOutputTokens) && role.maxOutputTokens >= 16)) fail(`roles.${name}.maxOutputTokens ≥ 16`);
        if (role.instructions != null && typeof role.instructions !== 'string') fail(`roles.${name}.instructions должен быть строкой`);
        if (role.maxEffort != null && !REASONING_EFFORTS.includes(role.maxEffort)) fail(`roles.${name}.maxEffort: ${REASONING_EFFORTS.join(' | ')}`);
        if (role.context != null && typeof role.context !== 'string' && !(Number.isSafeInteger(role.context) && role.context > 0)) fail(`roles.${name}.context: уровень или целое > 0`);
        if (role.tools != null && !Array.isArray(role.tools)) fail(`roles.${name}.tools: массив имён`);
        if (role.turns != null && !(Number.isSafeInteger(role.turns) && role.turns > 0)) fail(`roles.${name}.turns: целое > 0`);
        if (role.tiers != null) {
            if (Array.isArray(role.tiers)) {
                if (!role.tiers.length) fail(`roles.${name}.tiers: непустой массив моделей`);
                for (const [index, rung] of role.tiers.entries()) {
                    if (!isRecord(rung)) fail(`roles.${name}.tiers[${index}] должен быть объектом`);
                    for (const key of Object.keys(rung)) {
                        if (!['model', 'effort'].includes(key)) fail(`roles.${name}.tiers[${index}].${key}: неизвестное поле`);
                    }
                    if (typeof rung.model !== 'string' || !rung.model.trim()) fail(`roles.${name}.tiers[${index}].model должен быть строкой`);
                    if (rung.effort != null) {
                        if (!Array.isArray(rung.effort)) fail(`roles.${name}.tiers[${index}].effort: массив уровней`);
                        for (const level of rung.effort) {
                            if (!REASONING_EFFORTS.includes(level)) fail(`roles.${name}.tiers[${index}].effort: ${REASONING_EFFORTS.join(' | ')}`);
                        }
                    }
                }
            } else if (isRecord(role.tiers)) {
                for (const [level, tier] of Object.entries(role.tiers)) {
                    if (!['trivial', 'normal', 'complex'].includes(level)) fail(`roles.${name}.tiers.${level}: trivial | normal | complex`);
                    if (!isRecord(tier)) fail(`roles.${name}.tiers.${level} должен быть объектом`);
                    for (const key of Object.keys(tier)) {
                        if (!['model', 'effort'].includes(key)) fail(`roles.${name}.tiers.${level}.${key}: неизвестное поле`);
                    }
                    if (tier.model != null && (typeof tier.model !== 'string' || !tier.model.trim())) fail(`roles.${name}.tiers.${level}.model должен быть строкой`);
                    if (tier.effort != null && !REASONING_EFFORTS.includes(tier.effort)) fail(`roles.${name}.tiers.${level}.effort: ${REASONING_EFFORTS.join(' | ')}`);
                }
            } else {
                fail(`roles.${name}.tiers: массив моделей или объект trivial | normal | complex`);
            }
        }
    }
    if (!['team', 'single'].includes(c.agent.mode)) fail('agent.mode: team | single');
    for (const key of ['maxSteps', 'maxReviewRounds', 'orchestratorMaxTurns', 'architectMaxTurns', 'decomposerMaxTurns', 'workerMaxTurnsPerStep', 'reviewerMaxTurns', 'measurerMaxTurns', 'measurerPasses', 'decoratorMaxTurns', 'maxContextBytes']) {
        if (!Number.isSafeInteger(c.agent[key]) || c.agent[key] < (key === 'maxReviewRounds' ? 0 : 1)) fail(`agent.${key} должен быть целым числом`);
    }
    if (c.agent.measurerPasses > 2) fail('agent.measurerPasses: 1..2');
    if (!Number.isSafeInteger(c.agent.measurerMaxContextBytes) || c.agent.measurerMaxContextBytes < 1024) {
        fail('agent.measurerMaxContextBytes ≥ 1024');
    }
    if (c.agent.measurerMaxContextBytes > c.limits.maxRequestBytes) fail('agent.measurerMaxContextBytes не больше limits.maxRequestBytes');
    if (!['auto', 'always', 'never'].includes(c.agent.visionDelegate)) fail('agent.visionDelegate: auto | always | never');
    if (typeof c.agent.chain !== 'boolean') fail('agent.chain: true | false');
    if (typeof c.agent.resume !== 'boolean') fail('agent.resume: true | false');
    if (!['off', 'auto', 'always'].includes(c.agent.extract)) fail('agent.extract: off | auto | always');
    if (!['off', 'auto', 'always'].includes(c.agent.measure)) fail('agent.measure: off | auto | always');
    if (!['off', 'auto', 'always'].includes(c.agent.decorations)) fail('agent.decorations: off | auto | always');
    if (!['off', 'auto', 'always'].includes(c.agent.architect)) fail('agent.architect: off | auto | always');
    if (c.agent.pipeline != null) {
        if (!Array.isArray(c.agent.pipeline)) fail('agent.pipeline: массив этапов');
        const unknown = c.agent.pipeline.filter((id) => !PIPELINE_STAGE_IDS.includes(id));
        if (unknown.length) fail(`agent.pipeline: неизвестные этапы ${unknown.join(', ')}; разрешены ${PIPELINE_STAGE_IDS.join(' | ')}`);
    }
    if (c.agent.route !== null && !['encoder', 'planner', 'decisions'].includes(c.agent.route)) fail('agent.route: encoder | planner | decisions');
    if (!['encoder', 'mcp'].includes(c.agent.encode)) fail('agent.encode: encoder | mcp');
    if (!isRecord(c.agent.orchestrator)) fail('agent.orchestrator должен быть объектом');
    for (const key of Object.keys(c.agent.orchestrator)) {
        if (!(key in defaults.agent.orchestrator)) fail(`неизвестный параметр agent.orchestrator.${key}`);
    }
    if (typeof c.agent.orchestrator.enabled !== 'boolean') fail('agent.orchestrator.enabled: true | false');
    const orchestratorStages = ['plan', 'collect', 'work', 'review', 'fix'];
    if (!Array.isArray(c.agent.orchestrator.after) || c.agent.orchestrator.after.some((stage) => !orchestratorStages.includes(stage))) {
        fail(`agent.orchestrator.after: ${orchestratorStages.join(' | ')}`);
    }
    if (!Number.isSafeInteger(c.agent.orchestrator.maxContextBytes) || c.agent.orchestrator.maxContextBytes < 1024) {
        fail('agent.orchestrator.maxContextBytes ≥ 1024');
    }
    if (c.agent.orchestrator.maxContextBytes > c.limits.maxRequestBytes) fail('agent.orchestrator.maxContextBytes не больше limits.maxRequestBytes');
    for (const key of ['diffMaxBytes', 'logMaxBytes']) {
        if (!Number.isSafeInteger(c.agent.orchestrator[key]) || c.agent.orchestrator[key] < 1024) fail(`agent.orchestrator.${key} ≥ 1024`);
        if (c.agent.orchestrator[key] > c.agent.orchestrator.maxContextBytes) fail(`agent.orchestrator.${key} не больше agent.orchestrator.maxContextBytes`);
    }
    if (!Number.isSafeInteger(c.agent.orchestrator.maxTurns) || c.agent.orchestrator.maxTurns < 1 || c.agent.orchestrator.maxTurns > 50) {
        fail('agent.orchestrator.maxTurns: 1..50');
    }
    if (typeof c.agent.orchestrator.applyPlan !== 'boolean') fail('agent.orchestrator.applyPlan: true | false');
    for (const key of ['enabled', 'autoSave']) if (typeof c.memory[key] !== 'boolean') fail(`memory.${key}: true | false`);
    if (!Number.isSafeInteger(c.memory.maxRecall) || c.memory.maxRecall < 0 || c.memory.maxRecall > 50) fail('memory.maxRecall: 0..50');
    if (c.memory.notesFile !== null && (typeof c.memory.notesFile !== 'string' || !c.memory.notesFile.trim())) fail('memory.notesFile: имя файла или null');
    if (c.memory.dbFile !== null && (typeof c.memory.dbFile !== 'string' || !c.memory.dbFile.trim())) fail('memory.dbFile: путь или null');
    if (!isRecord(c.agents)) fail('agents должен быть объектом');
    for (const key of Object.keys(c.agents)) {
        if (!(key in defaults.agents)) fail(`неизвестный параметр agents.${key}`);
    }
    if (typeof c.agents.enabled !== 'boolean') fail('agents.enabled: true | false');
    if (!Array.isArray(c.agents.filenames) || c.agents.filenames.length < 1) fail('agents.filenames: массив от 1 строки');
    c.agents.filenames = c.agents.filenames.map((f) => typeof f === 'string' ? f.trim() : '').filter(Boolean);
    if (!c.agents.filenames.length) fail('agents.filenames: хотя бы одно непустое имя файла');
    if (!Number.isSafeInteger(c.agents.maxBytes) || c.agents.maxBytes < 1 * KiB || c.agents.maxBytes > 64 * KiB) fail('agents.maxBytes: 1 KiB..64 KiB');
    if (!Number.isSafeInteger(c.agents.maxTotalBytes) || c.agents.maxTotalBytes < 4 * KiB || c.agents.maxTotalBytes > 256 * KiB) fail('agents.maxTotalBytes: 4 KiB..256 KiB');
    if (typeof c.agents.discoverUpward !== 'boolean') fail('agents.discoverUpward: true | false');
    if (typeof c.agents.nested !== 'boolean') fail('agents.nested: true | false');
    if (c.agents.globalFile !== null && (typeof c.agents.globalFile !== 'string' || !c.agents.globalFile.trim())) fail('agents.globalFile: путь или null');
    if (!isRecord(c.prices)) fail('prices должен быть объектом');
    for (const [model, price] of Object.entries(c.prices)) {
        if (!isRecord(price)) fail(`prices.${model} должен быть объектом`);
        for (const key of ['input', 'output']) {
            if (!(Number.isFinite(price[key]) && price[key] >= 0)) fail(`prices.${model}.${key} — число USD за 1M токенов`);
        }
        if (price.cachedInput !== undefined && !(Number.isFinite(price.cachedInput) && price.cachedInput >= 0)) fail(`prices.${model}.cachedInput`);
    }
    if (c.serviceTier !== null && !['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast'].includes(c.serviceTier)) {
        fail('serviceTier: auto | default | flex | priority | fast | ultrafast');
    }
    if (!isRecord(c.completion)) fail('completion должен быть объектом');
    for (const key of Object.keys(c.completion)) {
        if (!(key in defaults.completion)) fail(`неизвестный параметр completion.${key}`);
    }
    if (typeof c.completion.model !== 'string' || !resolveCompletionModel(c.completion.model)) {
        fail(`completion.model: ${COMPLETION_MODEL_CHOICES.join(' | ')}`);
    }
    if (!REASONING_EFFORTS.includes(c.completion.effort)) fail(`completion.effort: ${REASONING_EFFORTS.join(' | ')}`);
    if (!Number.isSafeInteger(c.completion.maxOutputTokens) || c.completion.maxOutputTokens < 16) fail('completion.maxOutputTokens ≥ 16');
    if (!Number.isSafeInteger(c.completion.maxLineBytes) || c.completion.maxLineBytes < 1024) fail('completion.maxLineBytes ≥ 1024');
    if (!Number.isSafeInteger(c.completion.maxContextBytes) || c.completion.maxContextBytes < 256) fail('completion.maxContextBytes ≥ 256');
    if (!Number.isSafeInteger(c.completion.neighborLines) || c.completion.neighborLines < 0 || c.completion.neighborLines > 20) {
        fail('completion.neighborLines: 0..20');
    }
    if (c.completion.token !== null && (typeof c.completion.token !== 'string' || c.completion.token.length < 8 || /[\r\n]/.test(c.completion.token))) {
        fail('completion.token: null или строка от 8 символов без перевода строки');
    }
    if (typeof c.completion.channelProbe !== 'boolean') fail('completion.channelProbe: true | false');
    if (!Number.isSafeInteger(c.completion.probeTtlMs) || c.completion.probeTtlMs < 0 || c.completion.probeTtlMs > 3_600_000) {
        fail('completion.probeTtlMs: 0..3600000');
    }
    if (!Number.isSafeInteger(c.completion.probeTimeoutMs) || c.completion.probeTimeoutMs < 100 || c.completion.probeTimeoutMs > 30_000) {
        fail('completion.probeTimeoutMs: 100..30000');
    }
    if (!isRecord(c.generate)) fail('generate должен быть объектом');
    for (const key of Object.keys(c.generate)) {
        if (!(key in defaults.generate)) fail(`неизвестный параметр generate.${key}`);
    }
    if (!Number.isInteger(c.generate.fidelity) || c.generate.fidelity < 0 || c.generate.fidelity > 100) fail('generate.fidelity: целое 0..100');
    if (!Number.isInteger(c.generate.creativity) || c.generate.creativity < 0 || c.generate.creativity > 100) fail('generate.creativity: целое 0..100');
    if (!Object.hasOwn(PLATFORMS, c.generate.platform)) fail(`generate.platform: ${Object.keys(PLATFORMS).join(' | ')}`);
    if (!isRecord(c.pace)) fail('pace должен быть объектом');
    for (const key of Object.keys(c.pace)) {
        if (!['speed', 'quality', 'mode', 'models', ...FINE_QUALITY_KEYS].includes(key)) fail(`неизвестный параметр pace.${key}`);
    }
    for (const key of FINE_QUALITY_KEYS) {
        if (c.pace[key] != null && (!Number.isInteger(c.pace[key]) || c.pace[key] < 0 || c.pace[key] > 200)) fail(`pace.${key}: целое 0..200`);
    }
    try { assertPaceBudget(c.pace.speed, c.pace.quality); }
    catch (error) { fail(error.message); }
    if (!['auto', 'a', 'b', 'c'].includes(c.pace.mode)) fail('pace.mode: auto | a | b | c');
    if (!Array.isArray(c.pace.models)) fail('pace.models: от 1 до 8 непустых уникальных строк');
    const paceModels = c.pace.models.map((item) => typeof item === 'string' ? item.trim() : '');
    if (paceModels.length < 1 || paceModels.length > 8 || paceModels.some((item) => !item) || new Set(paceModels).size !== paceModels.length) {
        fail('pace.models: от 1 до 8 непустых уникальных строк');
    }
    c.pace.models = paceModels;
    if (!isRecord(c.mcp)) fail('mcp должен быть объектом');
    for (const key of Object.keys(c.mcp)) {
        if (!(key in defaults.mcp)) fail(`неизвестный параметр mcp.${key}`);
    }
    if (!Array.isArray(c.mcp.servers)) fail('mcp.servers должен быть массивом');
    c.mcp.servers = c.mcp.servers.map((entry) => normalizeMcpServer(entry));
    // Reviewer model restriction: gpt-6-astra is forbidden. An explicit pin is an error;
    // an inherited default is replaced by the safe fallback in resolveRole.
    if (c.roles?.reviewer?.model && REVIEWER_FORBIDDEN.includes(c.roles.reviewer.model)) {
        fail(`roles.reviewer.model не может быть "${c.roles.reviewer.model}" (запрещён для ревьюера).`);
    }
    if (!isRecord(c.decisions)) fail('decisions должен быть объектом');
    for (const key of Object.keys(c.decisions)) if (!(key in defaults.decisions)) fail(`неизвестный параметр decisions.${key}`);
    if (typeof c.decisions.model !== 'string' || !c.decisions.model.trim()) fail('decisions.model должен быть строкой');
    for (const key of ['reviewAt', 'blockAt']) {
        if (!(typeof c.decisions[key] === 'number' && c.decisions[key] >= 0 && c.decisions[key] <= 1)) fail(`decisions.${key}: число 0..1`);
    }
    if (c.decisions.blockAt < c.decisions.reviewAt) fail('decisions.blockAt не меньше decisions.reviewAt');
    for (const key of ['assess', 'vision']) {
        if (typeof c.decisions[key] !== 'boolean') fail(`decisions.${key}: true | false`);
    }
    if (!isRecord(c.moderation)) fail('moderation должен быть объектом');
    for (const key of Object.keys(c.moderation)) if (!(key in defaults.moderation)) fail(`неизвестный параметр moderation.${key}`);
    if (!['auto', 'decisions', 'moderations'].includes(c.moderation.mode)) fail('moderation.mode: auto | decisions | moderations');
    if (typeof c.moderation.model !== 'string' || !c.moderation.model.trim()) fail('moderation.model должен быть строкой');
    if (!PRESET_NAMES.includes(c.moderation.preset)) fail(`moderation.preset: ${PRESET_NAMES.join(' | ')}`);
    if (typeof c.moderation.guardReplies !== 'boolean') fail('moderation.guardReplies: true | false');
    if (!isRecord(c.telegram)) fail('telegram должен быть объектом');
    for (const key of Object.keys(c.telegram)) if (!(key in defaults.telegram)) fail(`неизвестный параметр telegram.${key}`);
    if (c.telegram.token !== null && (typeof c.telegram.token !== 'string' || !c.telegram.token.trim() || /[\r\n\s]/.test(c.telegram.token))) {
        fail('telegram.token: null или токен без пробелов');
    }
    try { new URL(c.telegram.baseURL); } catch { fail('telegram.baseURL должен быть URL'); }
    if (typeof c.telegram.reply !== 'boolean') fail('telegram.reply: true | false');
    if (typeof c.telegram.moderate !== 'boolean') fail('telegram.moderate: true | false');
    if (!['none', 'delete'].includes(c.telegram.enforce)) fail('telegram.enforce: none | delete');
    if (!isRecord(c.channels)) fail('channels должен быть объектом');
    for (const key of Object.keys(c.channels)) if (!(key in defaults.channels)) fail(`неизвестный параметр channels.${key}`);
    if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(c.channels.host)) fail('channels.host: 127.0.0.1 | localhost | ::1 | 0.0.0.0');
    if (!Number.isSafeInteger(c.channels.port) || c.channels.port < 0 || c.channels.port > 65535) fail('channels.port: 0..65535');
    if (c.channels.token !== null && (typeof c.channels.token !== 'string' || c.channels.token.length < 8 || /[\r\n]/.test(c.channels.token))) {
        fail('channels.token: null или строка от 8 символов без перевода строки');
    }
    if (c.channels.host === '0.0.0.0' && !c.channels.token) fail('channels.host 0.0.0.0 требует channels.token');
}

/** Heuristic: does this model accept the `reasoning` parameter? DeepSeek V4 thinks unless effort is set. */
export function isReasoningModel(model) {
    return /^(o\d|gpt-5|gpt-6|codex|gpt-oss|deepseek)/i.test(model) && !/chat-latest/i.test(model);
}

/** Heuristic: does this model accept `text.verbosity`? */
export function supportsVerbosity(model) {
    return /^(gpt-5|gpt-6)/i.test(model);
}

/** A redacted copy of the config for display. */
export function redactConfig(config) {
    const copy = structuredClone(config);
    if (copy.apiKey) copy.apiKey = `${copy.apiKey.slice(0, 7)}…${copy.apiKey.slice(-4)}`;
    /** Hide the key and any credential-shaped header of one backend entry. */
    const redactBackend = (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.apiKey) item.apiKey = '…';
        if (item.headers && typeof item.headers === 'object') {
            item.headers = Object.fromEntries(Object.entries(item.headers)
                .map(([key, value]) => [key, /auth|key|token|secret/i.test(key) ? '…' : value]));
        }
    };
    if (Array.isArray(copy.backends)) for (const item of copy.backends) redactBackend(item);
    if (Array.isArray(copy.fallback?.providers)) {
        for (const item of copy.fallback.providers) redactBackend(item);
    }
    if (copy.telegram?.token) copy.telegram.token = '…';
    if (copy.channels?.token) copy.channels.token = '…';
    if (Array.isArray(copy.mcp?.servers)) {
        for (const server of copy.mcp.servers) {
            if (server.env && typeof server.env === 'object') {
                server.env = Object.fromEntries(Object.keys(server.env).map((key) => [key, '…']));
            }
            if (server.authorization) server.authorization = '…';
            if (server.headers && typeof server.headers === 'object') {
                server.headers = Object.fromEntries(Object.keys(server.headers).map((key) => [key, '…']));
            }
        }
    }
    return copy;
}
