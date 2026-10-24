/**
 * @file src/commands/misc.js
 * @module commands/misc
 * @purpose Resume or cancel a background response, list models, and show or create config.
 * @depends node:path, node:fs/promises, core/background, openai/stream, core/config, util/text, commands/shared
 * @usedBy cli
 * @exports resume, cancel, models, configCommand, helpers
 * @ai.tags cli, config
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import path from 'node:path';
import { writeFile, stat } from 'node:fs/promises';
import { attachBackground, TERMINAL_STATUSES } from '../core/background.js';
import { normalizeUsage } from '../openai/stream.js';
import { defaults, redactConfig } from '../core/config.js';
import { formatDuration, formatNumber } from '../util/text.js';
import { UsageError, createClientFor, createLedgerFor, usageRow } from './shared.js';
import { parseResumeRequest } from './resume-args.js';
import { resumeLocal } from './run.js';

/**
 * `ai resume` continues the newest unfinished step, applies a revision, or reattaches to resp_….
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} 0 when the resumed work completed, otherwise 1.
 * @exports
 * @ai.hint io
 */
export async function resume(ctx) {
    let request;
    try { request = parseResumeRequest(ctx.positionals); }
    catch (error) { throw new UsageError(error.message); }
    if (request.kind === 'response') return resumeResponse(ctx, request.id);
    return resumeLocal(ctx, { revision: request.revision, stepToken: request.step });
}

/**
 * `ai resume <response_id>` — re-attach to a background response and print its output.
 * @param {object} ctx Command context from cli.main.
 * @param {string} id Response id, resp_….
 * @returns {Promise<number>} 0 when the response completed, otherwise 1.
 * @ai.hint io
 */
async function resumeResponse(ctx, id) {
    const { config, renderer, signal, emit } = ctx;
    const client = createClientFor(config);
    const ledger = createLedgerFor(config);
    try {
        renderer.begin();
        renderer.setStatus('получает состояние ответа…');
        let response = await client.responses.retrieve(id, { signal });
        emit({ type: 'response.created', responseId: response.id, status: response.status, model: response.model });
        if (!TERMINAL_STATUSES.has(response.status)) {
            renderer.line('info', `Ответ ${id}: ${response.status}; подключение к потоку…`, { dim: true });
            const startedAt = Date.now();
            response = await attachBackground({ client, id, signal, onEvent: emit });
            ledger.record({ model: response.model, usage: response.usage, elapsedMs: Date.now() - startedAt, responseId: response.id });
            renderer.idle();
            renderer.ensureNewline();
        } else {
            renderer.idle();
            renderer.text(`${response.output_text ?? ''}\n`);
            ledger.record({ model: response.model, usage: response.usage, elapsedMs: 0, responseId: response.id });
        }
        renderer.summary({ rows: [['статус', response.status], ['модель', response.model ?? '—'], ['токены', usageRow(ledger)],
            ...(response.incomplete_details?.reason ? [['причина', response.incomplete_details.reason]] : []),
            ...(response.error ? [['ошибка', response.error.message ?? response.error.code]] : [])] });
        renderer.json({ type: 'result', status: response.status, text: response.output_text ?? '', responseId: response.id, usage: normalizeUsage(response.usage) });
        return response.status === 'completed' ? 0 : 1;
    } finally { client.close(); }
}

/**
 * `ai cancel <response_id>` — cancel a background response on the server.
 * @param {object} ctx Command context from cli.main. positionals[0] is resp_….
 * @returns {Promise<number>} 0 after the cancel request returns.
 * @exports
 * @ai.hint io
 */
export async function cancel(ctx) {
    const { config, renderer, positionals, signal } = ctx;
    const id = positionals[0];
    if (!id || !/^resp_[A-Za-z0-9]+$/.test(id)) throw new UsageError('Укажите идентификатор ответа вида resp_… (для локальных задач: ai jobs cancel <id>).');
    const client = createClientFor(config);
    try {
        const response = await client.responses.cancel(id, { signal });
        renderer.write(`${id}: ${response.status}\n`);
        renderer.json({ type: 'cancelled', responseId: id, status: response.status });
        return 0;
    } finally { client.close(); }
}

/**
 * `ai models [filter]` — list models visible to the API key.
 * @param {object} ctx Command context from cli.main. positionals[0] is an optional substring filter.
 * @returns {Promise<number>} 0.
 * @exports
 * @ai.hint io
 */
export async function models(ctx) {
    const { config, renderer, positionals, signal } = ctx;
    const client = createClientFor(config);
    try {
        renderer.setStatus('загружает список моделей…');
        const list = await client.models.list({ signal });
        renderer.idle();
        const filter = (positionals[0] ?? '').toLowerCase();
        const ids = (list.data ?? []).map((m) => m.id).filter((id) => !filter || id.toLowerCase().includes(filter)).sort();
        if (renderer.mode === 'json') { renderer.json({ type: 'models', models: ids }); return 0; }
        renderer.write(`${ids.join('\n')}\n`);
        renderer.line('info', `${ids.length} моделей · текущая: ${config.model}`, { dim: true });
        return 0;
    } finally { client.close(); }
}

/**
 * `ai config [show|init|path]` — inspect or bootstrap the configuration file.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} 0. init throws UsageError when the file already exists.
 * @exports
 * @ai.hint io
 */
export async function configCommand(ctx) {
    const { config, renderer, positionals } = ctx;
    const sub = positionals[0] ?? 'show';
    const file = path.join(config.home, 'config.json');
    if (sub === 'path') { renderer.write(`${file}\n`); return 0; }
    if (sub === 'init') {
        if (await stat(file).then(() => true).catch(() => false)) throw new UsageError(`Файл уже существует: ${file}`);
        const template = {
            model: defaults.model, imageModel: null, reasoning: { effort: 'medium', summary: 'auto' }, store: false,
            approve: 'ask', tools: { ...defaults.tools }, limits: { maxTurns: 60, budgetUsd: null, budgetTokens: null },
            roles: {
                planner: { model: null, effort: 'high' },
                architect: { model: null, effort: 'high' },
                orchestrator: { model: null, effort: 'high' },
                worker: { model: null, effort: 'medium' },
                reviewer: { model: null, effort: 'medium' },
                vision: { model: null, effort: 'low' },
                summarizer: { model: null, effort: 'low' },
                extractor: { model: null, effort: 'low' },
                measurer: { model: null, effort: null },
                'image-processor': { model: null, effort: 'high' },
            },
            agent: { mode: 'team', maxReviewRounds: 2, resume: true, extract: 'auto', architect: 'auto', orchestrator: { enabled: false } },
            memory: { enabled: true, autoSave: true, maxRecall: 8, notesFile: 'AGENTS.md' },
            generate: { fidelity: defaults.generate.fidelity, creativity: defaults.generate.creativity, platform: defaults.generate.platform },
            pace: { speed: 10, quality: 40, mode: 'auto', models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'] },
            mcp: { servers: [] },
            image: { ...defaults.image },
            completion: { model: defaults.completion.model, effort: defaults.completion.effort },
            prices: {},
            instructions: null,
        };
        await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
        renderer.write(`Создан ${file}\n` +
            `Роли: укажите модели в roles.* (null = общая model). Например: "planner": { "model": "${defaults.model}", "effort": "high" }, "worker": { "model": "gpt-6-luna" }.\n` +
            `Чтобы видеть стоимость, добавьте актуальные цены (USD за 1M токенов), например:\n` +
            `  "prices": { "${defaults.model}": { "input": 1.25, "cachedInput": 0.125, "output": 10 }, "gpt-6-luna*": { "input": 0.25, "output": 2 } }\n`);
        return 0;
    }
    if (sub !== 'show') throw new UsageError('Доступно: ai config show | init | path');
    const shown = redactConfig(config);
    delete shown.configFiles;
    if (renderer.mode === 'json') { renderer.json({ type: 'config', config: shown, files: config.configFiles }); return 0; }
    renderer.write(`${JSON.stringify(shown, null, 2)}\n`);
    renderer.line('info', `файлы конфигурации: ${config.configFiles.join(', ')} · ключ: ${config.apiKey ? 'задан' : 'НЕ задан (OPENAI_API_KEY)'}`, { dim: true });
    return 0;
}

export const helpers = { formatDuration, formatNumber };
