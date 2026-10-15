import path from 'node:path';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createClient } from '../openai/client.js';
import { createLedger } from '../core/usage.js';
import { createSession, loadSession, sessionFile } from '../core/session.js';
import { loadImageAttachment, loadFileAttachment } from '../core/attachments.js';
import { APPROVAL_LEVELS, IMAGE_DETAILS, REASONING_EFFORTS, REASONING_SUMMARIES, ROLE_NAMES, resolveRole } from '../core/config.js';
import { openMemory, projectKey as computeProjectKey } from '../core/memory.js';
import { formatBytes, formatDuration, formatNumber, formatUsd, timestampSlug } from '../util/text.js';

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.exitCode = 2; }
}

function number(value, name, { integer = false, min = 0 } = {}) {
  const parsed = Number(value);
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(parsed) || parsed < min || (integer && !Number.isSafeInteger(parsed))) {
    throw new UsageError(`Некорректное значение --${name}: ${value}`);
  }
  return parsed;
}

/** Translate CLI flags into configuration overrides. */
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
  if (values.single) o.agent = { mode: 'single' };
  if (values.team) o.agent = { mode: 'team' };
  if (values.memory === false) o.memory = { enabled: false };
  if (values.web) o.tools.web = true;
  if (values.images) o.tools.images = true;
  if (values.desktop) o.tools.desktop = true;
  if (values.tools !== undefined) {
    const list = values.tools.split(',').map((s) => s.trim()).filter(Boolean);
    const all = { fs: false, shell: false, fetch: false, web: false, images: false, askUser: false, desktop: false };
    if (!(list.length === 1 && list[0] === 'none')) {
      for (const name of list) {
        if (!(name in all)) throw new UsageError(`--tools: неизвестный инструмент "${name}" (fs, shell, fetch, web, images, askUser, desktop, none)`);
        all[name] = true;
      }
      if (list.length) all.askUser = true;
    }
    Object.assign(o.tools, all);
  }
  if (values['no-tools']) Object.assign(o.tools, { fs: false, shell: false, fetch: false, web: false, images: false, askUser: false, desktop: false });
  if (values.detail && !IMAGE_DETAILS.includes(values.detail)) throw new UsageError(`--detail: ${IMAGE_DETAILS.join(' | ')}`);
  return o;
}

/** Read piped stdin (returns null when stdin is a TTY or empty). */
export async function readStdin({ maxBytes = 4 * 1024 * 1024, stdin = process.stdin } = {}) {
  if (stdin.isTTY) return null;
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stdin) {
      total += chunk.length;
      if (total > maxBytes) throw new UsageError(`stdin больше лимита ${formatBytes(maxBytes)}.`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    return null;
  }
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  return text.trim() ? text : null;
}

/** "@file" → file contents, otherwise the literal string. */
export async function resolveTextArg(value, { cwd = process.cwd(), what = 'текст' } = {}) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('@')) return value;
  const file = path.resolve(cwd, value.slice(1));
  try { return (await readFile(file, 'utf8')).replace(/^\uFEFF/, ''); }
  catch (error) { throw new UsageError(`Не удалось прочитать ${what} из ${file}: ${error.message}`); }
}

export async function loadAttachments({ images = [], files = [], detail = 'auto', cwd, config, renderer }) {
  const parts = [];
  for (const ref of images) {
    const { part, meta } = await loadImageAttachment(ref, { detail, cwd, maxBytes: config.limits.maxImageBytes });
    parts.push(part);
    renderer?.line('info', `Изображение: ${meta.source}${meta.bytes ? ` (${formatBytes(meta.bytes)}, ${meta.mime})` : ''}`, { dim: true });
  }
  for (const ref of files) {
    const { part, meta } = await loadFileAttachment(ref, { cwd, maxBytes: config.limits.maxAttachmentBytes });
    parts.push(part);
    renderer?.line('info', `Файл: ${meta.source}${meta.bytes ? ` (${formatBytes(meta.bytes)}, ${meta.kind})` : ''}`, { dim: true });
  }
  return parts;
}

export function composeInstructions(base, config, extra) {
  return [base, config.instructions, extra].filter((part) => typeof part === 'string' && part.trim()).join('\n\n');
}

export function createClientFor(config) {
  return createClient({
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY, baseURL: config.baseURL, organization: config.organization,
    project: config.project, retries: config.retries, idleTimeoutMs: config.limits.idleTimeoutMs, connectTimeoutMs: config.limits.connectTimeoutMs,
  });
}

export function createLedgerFor(config) {
  return createLedger({ prices: config.prices, budgetUsd: config.limits.budgetUsd, budgetTokens: config.limits.budgetTokens });
}

/** Open a named persistent session or create a throwaway one. */
export async function openSession({ config, name = null, instructions = null }) {
  if (!name) return { session: createSession({ store: config.store, model: config.model, instructions }), file: null, resumed: false };
  const file = sessionFile(config.home, name);
  const exists = await stat(file).then((s) => s.isFile()).catch(() => false);
  if (exists) {
    const session = await loadSession(file, { store: config.store, model: config.model, instructions });
    return { session, file, resumed: true };
  }
  return { session: createSession({ store: config.store, model: config.model, name, instructions }), file, resumed: false };
}

export function approvalLevel(config, interactive) {
  return config.approve ?? (interactive ? 'ask' : 'read');
}

export function backupDirFor(config, tag = timestampSlug()) {
  return path.join(config.home, 'backups', tag);
}

export async function writeOutput(file, text, { cwd = process.cwd() } = {}) {
  const target = path.resolve(cwd, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return target;
}

export const STATUS_LABELS = {
  completed: 'завершено', incomplete: 'ответ неполный', refused: 'отказ модели', max_turns: 'лимит ходов',
  budget: 'лимит бюджета', cancelled: 'отменено', failed: 'ошибка', revise: 'требуются правки',
};

export function exitCodeFor(status) {
  if (status === 'completed') return 0;
  if (status === 'cancelled') return 130;
  return 1;
}

export { resolveRole };

/** Open the long-term memory store for a working directory (null when disabled or unavailable). */
export function openMemoryFor(config, root, renderer = null) {
  if (!config.memory.enabled) return null;
  try {
    const memory = openMemory({ file: config.memory.dbFile });
    return { memory, projectKey: computeProjectKey(root), projectName: path.basename(root) };
  } catch (error) {
    renderer?.line('warn', `Память недоступна (${error.message}); продолжаем без неё.`);
    return null;
  }
}

/** Human-readable list of models per role (for the run header). */
export function describeRoles(config, names) {
  return names.map((name) => {
    const role = resolveRole(config, name);
    return `${name}=${role.model}${role.effort ? `:${role.effort}` : ''}`;
  }).join(', ');
}

/** Usage breakdown by role (team runs) or by model. */
export function usageBreakdownRows(ledger) {
  const t = ledger.snapshot();
  const rows = [];
  const render = (items, label) => items.map((r) => `${r[label]}: ↑ ${formatNumber(r.input)} ↓ ${formatNumber(r.output)}${r.unknownCost ? '' : ` ${formatUsd(r.costUsd)}`} (${r.requests})`).join(' · ');
  const roles = (t.byRole ?? []).filter((r) => r.role);
  if (roles.length > 1) rows.push(['по ролям', render(roles, 'role')]);
  if ((t.byModel ?? []).length > 1) rows.push(['по моделям', render(t.byModel, 'model')]);
  return rows;
}

export function usageRow(ledger) {
  const t = ledger.snapshot();
  if (!t.requests) return '—';
  return `↑ ${formatNumber(t.input)}${t.cached ? ` (кеш ${formatNumber(t.cached)})` : ''} · ↓ ${formatNumber(t.output)}${t.reasoning ? ` (reasoning ${formatNumber(t.reasoning)})` : ''} · всего ${formatNumber(t.total)}` +
    `${t.costKnown ? ` · ${formatUsd(t.costUsd)}` : t.costUsd ? ` · ≥ ${formatUsd(t.costUsd)} (цены известны не для всех моделей)` : ' · стоимость неизвестна (задайте prices в конфигурации)'}` +
    `${t.budgetUsd ? ` · бюджет ${formatUsd(t.budgetUsd)}` : ''}${t.budgetTokens ? ` · лимит ${formatNumber(t.budgetTokens)} ток.` : ''}` +
    ` · ${t.requests} запрос(ов), ${formatDuration(t.elapsedMs)} в API`;
}

export function describeChanges(stats) {
  if (!stats?.changes?.length) return '';
  const marks = { create: '+', overwrite: '~', edit: '~', delete: '-' };
  const seen = new Map();
  for (const change of stats.changes) seen.set(change.path, marks[change.op] ?? '~');
  return [...seen.entries()].map(([file, mark]) => `${mark} ${file}`).join('  ');
}

/** Build a compact machine-readable result object for --json / jobs. */
export function resultObject({ result, ledger, toolset = null, outFile = null, session = null }) {
  return {
    type: 'result', status: result.status, text: result.text, refusal: result.refusal || undefined,
    turns: result.turns, toolCalls: result.toolCalls, images: result.images, outFile,
    responseId: result.response?.id ?? null, sessionId: session?.id ?? null,
    usage: ledger.snapshot(), tools: toolset?.stats() ?? null,
    error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
  };
}
