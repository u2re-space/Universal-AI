import path from 'node:path';
import { writeFile, stat } from 'node:fs/promises';
import { attachBackground, TERMINAL_STATUSES } from '../core/background.js';
import { normalizeUsage } from '../openai/stream.js';
import { defaults, redactConfig } from '../core/config.js';
import { formatDuration, formatNumber } from '../util/text.js';
import { UsageError, createClientFor, createLedgerFor, usageRow } from './shared.js';

/** `ai resume <response_id>` — re-attach to a background response and print its output. */
export async function resume(ctx) {
  const { config, renderer, positionals, signal, emit } = ctx;
  const id = positionals[0];
  if (!id || !/^resp_[A-Za-z0-9]+$/.test(id)) throw new UsageError('Укажите идентификатор ответа вида resp_… (ai resume resp_123).');
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

/** `ai cancel <response_id>` — cancel a background response on the server. */
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

/** `ai models [filter]` — list models visible to the API key. */
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

/** `ai config [show|init|path]` — inspect or bootstrap the configuration file. */
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
        collector: { model: null, effort: 'low' },
        worker: { model: null, effort: 'medium' },
        reviewer: { model: null, effort: 'medium' },
        vision: { model: null, effort: 'low' },
        summarizer: { model: null, effort: 'low' },
      },
      agent: { mode: 'team', maxSteps: 12, maxReviewRounds: 2 },
      memory: { enabled: true, autoSave: true, maxRecall: 8, notesFile: 'AGENTS.md' },
      image: { ...defaults.image }, prices: {},
      instructions: null,
    };
    await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
    renderer.write(`Создан ${file}\n` +
      `Роли: укажите модели в roles.* (null = общая model). Например: "planner": { "model": "${defaults.model}", "effort": "high" }, "worker": { "model": "gpt-5.4-mini" }.\n` +
      `Чтобы видеть стоимость, добавьте актуальные цены (USD за 1M токенов), например:\n` +
      `  "prices": { "${defaults.model}": { "input": 1.25, "cachedInput": 0.125, "output": 10 }, "gpt-5.4-mini*": { "input": 0.25, "output": 2 } }\n`);
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
