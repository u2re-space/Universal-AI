/**
 * @file src/core/config.js
 * @module core/config
 * @purpose Load, validate, and redact configuration, and resolve per-role settings.
 * @depends node:os, node:path, node:fs/promises, util/text, core/config-defaults
 * @usedBy cli, commands/shared, commands/flags, commands/ask, commands/run, commands/chat, commands/misc, agent/loop, agent/roles
 * @exports APPROVAL_LEVELS, IMAGE_DETAILS, REASONING_EFFORTS, REASONING_SUMMARIES, ROLE_NAMES, defaults, resolveRole, defaultHome, loadConfig, isReasoningModel, supportsVerbosity, redactConfig
 * @ai.tags config
 * @ai.hint io
 * @changed 2026-10-15 Validate completion settings.
 */
import os from 'node:os';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { deepMerge, isRecord } from '../util/text.js';
import {
    APPROVAL_LEVELS,
    IMAGE_DETAILS,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    ROLE_NAMES,
    defaults,
} from './config-defaults.js';

export {
    APPROVAL_LEVELS,
    IMAGE_DETAILS,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    ROLE_NAMES,
    defaults,
};


/**
 * Effective settings for a role: role → roles.default → top-level configuration.
 * Returns a config-like object usable by runTurn (same shape as the main config).
 */
export function resolveRole(config, name = 'default') {
    const base = config.roles?.default ?? {};
    const role = config.roles?.[name] ?? {};
    const pick = (key, fallback) => role[key] ?? (name !== 'default' ? base[key] : undefined) ?? fallback;
    const model = pick('model', config.model);
    return {
        name, model,
        effort: pick('effort', config.reasoning.effort),
        summary: pick('summary', config.reasoning.summary),
        verbosity: pick('verbosity', config.verbosity),
        maxOutputTokens: pick('maxOutputTokens', config.maxOutputTokens),
        temperature: pick('temperature', config.temperature),
        instructions: role.instructions ?? null,
        /** A config object with this role's settings applied (for runTurn / buildRequestBody). */
        config: {
            ...config, model,
            reasoning: { effort: pick('effort', config.reasoning.effort), summary: pick('summary', config.reasoning.summary) },
            verbosity: pick('verbosity', config.verbosity), maxOutputTokens: pick('maxOutputTokens', config.maxOutputTokens),
            temperature: pick('temperature', config.temperature),
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
    if (env.AI_IMAGE_MODEL) result.imageModel = env.AI_IMAGE_MODEL;
    if (env.OPENAI_BASE_URL) result.baseURL = env.OPENAI_BASE_URL;
    if (env.OPENAI_API_KEY) result.apiKey = env.OPENAI_API_KEY;
    if (env.OPENAI_ORG_ID) result.organization = env.OPENAI_ORG_ID;
    if (env.OPENAI_PROJECT_ID) result.project = env.OPENAI_PROJECT_ID;
    if (env.AI_POLL_MS && Number.isSafeInteger(Number(env.AI_POLL_MS))) result.limits = { pollIntervalMs: Number(env.AI_POLL_MS) };
    return result;
}

/**
 * Resolve the effective configuration.
 * Precedence: defaults < ~/.ai-agent/config.json < --config file < environment < overrides (CLI).
 */
export async function loadConfig({ configPath = null, overrides = {}, env = process.env, ensureHome = true } = {}) {
    const home = defaultHome(env);
    const homeConfig = await readJsonFile(path.join(home, 'config.json'), { optional: true });
    const fileConfig = configPath ? await readJsonFile(path.resolve(configPath)) : {};
    const config = [homeConfig, fileConfig, fromEnv(env), overrides].reduce((acc, extra) => deepMerge(acc, extra), structuredClone(defaults));
    config.home = home;
    config.baseURL ||= 'https://api.openai.com/v1/';
    config.memory.dbFile ||= path.join(home, 'memory.db');
    config.configFiles = [path.join(home, 'config.json'), ...(configPath ? [path.resolve(configPath)] : [])];
    validateConfig(config);
    if (ensureHome) await mkdir(home, { recursive: true });
    return config;
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
    if (c.reasoning.effort !== null && !REASONING_EFFORTS.includes(c.reasoning.effort)) fail(`reasoning.effort: ${REASONING_EFFORTS.join(' | ')}`);
    if (c.reasoning.summary !== null && !REASONING_SUMMARIES.includes(c.reasoning.summary)) fail(`reasoning.summary: ${REASONING_SUMMARIES.join(' | ')}`);
    if (c.verbosity !== null && !['low', 'medium', 'high'].includes(c.verbosity)) fail('verbosity: low | medium | high');
    if (c.temperature !== null && !(Number.isFinite(c.temperature) && c.temperature >= 0 && c.temperature <= 2)) fail('temperature: 0..2');
    if (c.maxOutputTokens !== null && !(Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16)) fail('maxOutputTokens ≥ 16');
    if (typeof c.store !== 'boolean') fail('store: true | false');
    if (!['auto', 'disabled'].includes(c.truncation)) fail('truncation: auto | disabled');
    if (c.approve !== null && !APPROVAL_LEVELS.includes(c.approve)) fail(`approve: ${APPROVAL_LEVELS.join(' | ')}`);
    if (c.shell !== null && !['powershell', 'pwsh', 'bash', 'sh', 'zsh', 'cmd'].includes(c.shell)) fail('shell: powershell | pwsh | bash | sh | zsh | cmd');
    if (!Number.isSafeInteger(c.retries) || c.retries < 0 || c.retries > 10) fail('retries: 0..10');
    for (const [key, value] of Object.entries(c.limits)) {
        if (!(key in defaults.limits)) fail(`неизвестный лимит limits.${key}`);
        if (key === 'budgetUsd') { if (value !== null && !(Number.isFinite(value) && value > 0)) fail('limits.budgetUsd > 0'); continue; }
        if (key === 'budgetTokens') { if (value !== null && !(Number.isSafeInteger(value) && value > 0)) fail('limits.budgetTokens > 0'); continue; }
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
    if (!['png', 'webp', 'jpeg'].includes(c.image.format)) fail('image.format: png | webp | jpeg');
    if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.image.quality)) fail('image.quality: auto | low | medium | high | xhigh | max');
    if (!['auto', 'transparent', 'opaque'].includes(c.image.background)) fail('image.background: auto | transparent | opaque');
    if (!(c.image.size === 'auto' || /^\d{2,4}x\d{2,4}$/.test(c.image.size))) fail('image.size: auto | WIDTHxHEIGHT');
    if (!Number.isSafeInteger(c.image.partialImages) || c.image.partialImages < 0 || c.image.partialImages > 3) fail('image.partialImages: 0..3');
    if (!['low', 'medium', 'high'].includes(c.webSearch.contextSize)) fail('webSearch.contextSize: low | medium | high');
    if (typeof c.compaction.auto !== 'boolean' || !Number.isSafeInteger(c.compaction.afterInputTokens) || c.compaction.afterInputTokens < 1000) {
        fail('compaction: { auto: boolean, afterInputTokens ≥ 1000 }');
    }
    if (!isRecord(c.roles)) fail('roles должен быть объектом');
    for (const [name, role] of Object.entries(c.roles)) {
        if (!ROLE_NAMES.includes(name)) fail(`roles.${name}: неизвестная роль (${ROLE_NAMES.join(', ')})`);
        if (!isRecord(role)) fail(`roles.${name} должен быть объектом`);
        for (const key of Object.keys(role)) if (!(key in defaults.roles.default)) fail(`roles.${name}.${key}: неизвестное поле`);
        if (role.model !== null && role.model !== undefined && (typeof role.model !== 'string' || !role.model.trim())) fail(`roles.${name}.model должен быть строкой`);
        if (role.effort != null && !REASONING_EFFORTS.includes(role.effort)) fail(`roles.${name}.effort: ${REASONING_EFFORTS.join(' | ')}`);
        if (role.summary != null && !REASONING_SUMMARIES.includes(role.summary)) fail(`roles.${name}.summary: ${REASONING_SUMMARIES.join(' | ')}`);
        if (role.verbosity != null && !['low', 'medium', 'high'].includes(role.verbosity)) fail(`roles.${name}.verbosity: low | medium | high`);
        if (role.temperature != null && !(Number.isFinite(role.temperature) && role.temperature >= 0 && role.temperature <= 2)) fail(`roles.${name}.temperature: 0..2`);
        if (role.maxOutputTokens != null && !(Number.isSafeInteger(role.maxOutputTokens) && role.maxOutputTokens >= 16)) fail(`roles.${name}.maxOutputTokens ≥ 16`);
        if (role.instructions != null && typeof role.instructions !== 'string') fail(`roles.${name}.instructions должен быть строкой`);
    }
    if (!['team', 'single'].includes(c.agent.mode)) fail('agent.mode: team | single');
    for (const key of ['maxSteps', 'maxReviewRounds', 'collectorMaxTurns', 'workerMaxTurnsPerStep', 'reviewerMaxTurns', 'maxContextBytes']) {
        if (!Number.isSafeInteger(c.agent[key]) || c.agent[key] < (key === 'maxReviewRounds' ? 0 : 1)) fail(`agent.${key} должен быть целым числом`);
    }
    if (!['auto', 'always', 'never'].includes(c.agent.visionDelegate)) fail('agent.visionDelegate: auto | always | never');
    for (const key of ['enabled', 'autoSave']) if (typeof c.memory[key] !== 'boolean') fail(`memory.${key}: true | false`);
    if (!Number.isSafeInteger(c.memory.maxRecall) || c.memory.maxRecall < 0 || c.memory.maxRecall > 50) fail('memory.maxRecall: 0..50');
    if (c.memory.notesFile !== null && (typeof c.memory.notesFile !== 'string' || !c.memory.notesFile.trim())) fail('memory.notesFile: имя файла или null');
    if (c.memory.dbFile !== null && (typeof c.memory.dbFile !== 'string' || !c.memory.dbFile.trim())) fail('memory.dbFile: путь или null');
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
    if (typeof c.completion.model !== 'string' || !c.completion.model.trim()) fail('completion.model должен быть строкой');
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
}

/** Heuristic: does this model accept the `reasoning` parameter? */
export function isReasoningModel(model) {
    return /^(o\d|gpt-5|gpt-6|codex|gpt-oss)/i.test(model) && !/chat-latest/i.test(model);
}

/** Heuristic: does this model accept `text.verbosity`? */
export function supportsVerbosity(model) {
    return /^(gpt-5|gpt-6)/i.test(model);
}

/** A redacted copy of the config for display. */
export function redactConfig(config) {
    const copy = structuredClone(config);
    if (copy.apiKey) copy.apiKey = `${copy.apiKey.slice(0, 7)}…${copy.apiKey.slice(-4)}`;
    return copy;
}
