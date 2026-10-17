/**
 * @file src/commands/flags.js
 * @module commands/flags
 * @purpose Turn CLI flags into configuration overrides. Bad flags throw UsageError (exit code 2).
 * @depends core/config, generate/platform
 * @usedBy commands/shared, cli
 * @exports UsageError, overridesFrom
 * @ai.tags cli, config
 * @ai.hint pure
 * @changed 2026-10-15 Fidelity, creativity, platform, and mcp in --tools.
 */
import { APPROVAL_LEVELS, IMAGE_DETAILS, REASONING_EFFORTS, REASONING_SUMMARIES, ROLE_NAMES } from '../core/config.js';
import { PLATFORMS } from '../generate/platform.js';

/**
 * Error for invalid arguments or configuration. Command handlers map it to exit code 2.
 * @exports
 * @ai.hint pure
 */
export class UsageError extends Error {
    /**
     * @param {string} message Text shown to the user.
     * @returns {UsageError}
     * @ai.hint pure
     */
    constructor(message) { super(message); this.name = 'UsageError'; this.exitCode = 2; }
}

/**
 * Parse a numeric CLI flag or throw UsageError.
 * @param {string} value Raw flag text.
 * @param {string} name Flag name without dashes, used in the error.
 * @param {{ integer?: boolean, min?: number }} [options] integer requires a safe integer; min is the inclusive lower bound.
 * @returns {number}
 * @ai.hint pure
 */
function number(value, name, { integer = false, min = 0 } = {}) {
    const parsed = Number(value);
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(parsed) || parsed < min || (integer && !Number.isSafeInteger(parsed))) {
        throw new UsageError(`Некорректное значение --${name}: ${value}`);
    }
    return parsed;
}

/**
 * Translate CLI flags into configuration overrides.
 * @param {object} values Flags from node:util parseArgs.
 * @returns {object} Partial config: model, limits, reasoning, image, tools, roles, agent, memory.
 * @exports
 * @ai.hint pure
 */
export function overridesFrom(values) {
    const o = { limits: {}, reasoning: {}, image: {}, tools: {} };
    if (values.model) o.model = values.model;
    if (values['image-model']) o.imageModel = values['image-model'];
    if (values['base-url']) o.baseURL = values['base-url'];
    if (values.effort) {
        if (!REASONING_EFFORTS.includes(values.effort)) throw new UsageError(`--effort: ${REASONING_EFFORTS.join(' | ')}`);
        o.reasoning.effort = values.effort;
    }
    if (values.summary) {
        if (!REASONING_SUMMARIES.includes(values.summary)) throw new UsageError(`--summary: ${REASONING_SUMMARIES.join(' | ')}`);
        o.reasoning.summary = values.summary;
    }
    if (values.verbosity) o.verbosity = values.verbosity;
    if (values.temperature !== undefined) o.temperature = number(values.temperature, 'temperature');
    if (values['max-output-tokens'] !== undefined) o.maxOutputTokens = number(values['max-output-tokens'], 'max-output-tokens', { integer: true, min: 16 });
    if (values.store) o.store = true;
    if (values.stream === false) o.stream = false;
    if (values.approve) {
        if (!APPROVAL_LEVELS.includes(values.approve)) throw new UsageError(`--approve: ${APPROVAL_LEVELS.join(' | ')}`);
        o.approve = values.approve;
    }
    if (values.yes) o.approve = 'all';
    if (values['max-turns'] !== undefined) o.limits.maxTurns = number(values['max-turns'], 'max-turns', { integer: true, min: 1 });
    if (values['budget-usd'] !== undefined) o.limits.budgetUsd = number(values['budget-usd'], 'budget-usd');
    if (values['budget-tokens'] !== undefined) o.limits.budgetTokens = number(values['budget-tokens'], 'budget-tokens', { integer: true, min: 1 });
    if (values.timeout !== undefined) o.limits.idleTimeoutMs = number(values.timeout, 'timeout', { integer: true, min: 1 }) * 1000;
    if (values.size) o.image.size = values.size;
    if (values.quality) o.image.quality = values.quality;
    if (values.format) o.image.format = values.format;
    if (values['image-background']) o.image.background = values['image-background'];
    if (values.partials !== undefined) o.image.partialImages = number(values.partials, 'partials', { integer: true, min: 0 });
    if (values.shell) o.shell = values.shell;
    if (values.role?.length) {
        o.roles = {};
        for (const spec of values.role) {
            const match = /^([\w*]+)=([^:]+?)(?::([a-z]+))?$/.exec(spec.trim());
            if (!match) throw new UsageError(`--role: ожидается имя=модель[:effort], получено "${spec}"`);
            const [, name, model, effort] = match;
            if (effort && !REASONING_EFFORTS.includes(effort)) throw new UsageError(`--role ${name}: effort должен быть одним из ${REASONING_EFFORTS.join(' | ')}`);
            const targets = name === 'all' || name === '*' ? ROLE_NAMES : [name];
            for (const target of targets) {
                if (!ROLE_NAMES.includes(target)) throw new UsageError(`--role: неизвестная роль "${target}" (${ROLE_NAMES.join(', ')})`);
                o.roles[target] = { ...(o.roles[target] ?? {}), model, ...(effort ? { effort } : {}) };
            }
        }
    }
    if (values.single) (o.agent ??= {}).mode = 'single';
    if (values.team) (o.agent ??= {}).mode = 'team';
    if (values['no-chain']) (o.agent ??= {}).chain = false;
    if (values['no-resume']) (o.agent ??= {}).resume = false;
    if (values.route) {
        if (!['encoder', 'planner', 'decisions'].includes(values.route)) throw new UsageError('--route: encoder | planner | decisions');
        (o.agent ??= {}).route = values.route;
    }
    if (values.memory === false) o.memory = { enabled: false };
    if (values.web) o.tools.web = true;
    if (values.images) o.tools.images = true;
    if (values.desktop) o.tools.desktop = true;
    if (values['unsafe-screenshot']) (o.desktop ??= {}).unsafeScreenshot = true;
    if (values.tools !== undefined) {
        const list = values.tools.split(',').map((s) => s.trim()).filter(Boolean);
        const all = { fs: false, shell: false, fetch: false, web: false, images: false, askUser: false, desktop: false, mcp: false, channels: false };
        if (!(list.length === 1 && list[0] === 'none')) {
            for (const name of list) {
                if (!(name in all)) throw new UsageError(`--tools: неизвестный инструмент "${name}" (fs, shell, fetch, web, images, askUser, desktop, mcp, channels, none)`);
                all[name] = true;
            }
            if (list.length) all.askUser = true;
        }
        Object.assign(o.tools, all);
    }
    if (values['no-tools']) Object.assign(o.tools, { fs: false, shell: false, fetch: false, web: false, images: false, askUser: false, desktop: false, mcp: false, channels: false });
    if (values.detail && !IMAGE_DETAILS.includes(values.detail)) throw new UsageError(`--detail: ${IMAGE_DETAILS.join(' | ')}`);
    if (values.fidelity !== undefined || values.creativity !== undefined || values.platform) o.generate = {};
    if (values.fidelity !== undefined) {
        const fidelity = number(values.fidelity, 'fidelity', { integer: true, min: 0 });
        if (fidelity > 100) throw new UsageError('--fidelity: 0..100');
        o.generate.fidelity = fidelity;
    }
    if (values.creativity !== undefined) {
        const creativity = number(values.creativity, 'creativity', { integer: true, min: 0 });
        if (creativity > 100) throw new UsageError('--creativity: 0..100');
        o.generate.creativity = creativity;
    }
    if (values.platform) {
        if (!Object.hasOwn(PLATFORMS, values.platform)) throw new UsageError(`--platform: ${Object.keys(PLATFORMS).join(' | ')}`);
        o.generate.platform = values.platform;
    }
    return o;
}
