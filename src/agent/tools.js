import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { CancelledError } from '../openai/errors.js';
import { detectImageMime } from '../core/attachments.js';
import { errorMessage, formatBytes, truncate, clipMiddle } from '../util/text.js';
import { resolveInside } from './paths.js';
import { listFiles, readTextFile, searchFiles, writeTextFile, replaceInFile, deleteFile, makeDirectory } from './fs-tools.js';
import { loadProjectMap, searchMapped, updateProjectMapPath } from './map.js';
import { runCommand } from './shell.js';

const str = (description) => ({ type: 'string', description });
const nullableInt = (description) => ({ type: ['integer', 'null'], description });
const nullableStr = (description) => ({ type: ['string', 'null'], description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/**
 * Local tools exposed to the model as strict function tools.
 * Categories drive the approval policy: read | write | exec | network | user.
 */
export const TOOL_SPECS = {
  list_files: {
    category: 'read', group: 'fs',
    description: 'List files and directories under a path of the working directory (noisy folders like node_modules/.git are skipped).',
    parameters: schema({
      path: str('Directory path relative to the working directory; "." for the root.'),
      depth: nullableInt('How many levels deep to list (1-6). Default 2.'),
      include_hidden: bool('Include dot-files and dot-directories.'),
    }),
  },
  read_file: {
    category: 'read', group: 'fs',
    description: 'Read a UTF-8 text file. Returns numbered lines ("N| text"). Use start_line/end_line for big files.',
    parameters: schema({
      path: str('File path relative to the working directory.'),
      start_line: nullableInt('First line to return (1-based). Null = from the beginning.'),
      end_line: nullableInt('Last line to return (inclusive). Null = to the end (bounded by a size limit).'),
    }),
  },
  search_files: {
    category: 'read', group: 'fs',
    description: 'Search text files for a literal string (or a regular expression) using the project map when .ai/map.json is present. Returns "path:line: text" matches.',
    parameters: schema({
      query: str('Literal text (case-insensitive) or a JavaScript regular expression when regex=true.'),
      path: nullableStr('Directory to search in, relative to the working directory. Null = whole working directory.'),
      regex: bool('Interpret query as a regular expression.'),
      scope: { type: 'string', enum: ['path', 'symbol', 'content', 'all'], description: 'path and symbol read the map only. content reads file text. all (use this unless a narrower scope is enough) returns path, then symbol, then content.' },
    }),
  },
  write_file: {
    category: 'write', group: 'fs',
    description: 'Create or overwrite a UTF-8 text file with the full content. Parent directories are created. Overwritten files are backed up.',
    parameters: schema({
      path: str('File path relative to the working directory.'),
      content: str('Complete new content of the file.'),
      overwrite: bool('Allow replacing an existing file. Use false when creating a file that must not exist yet.'),
    }),
  },
  replace_text: {
    category: 'write', group: 'fs',
    description: 'Edit a text file by replacing an exact fragment. The fragment must match exactly once unless all=true. Prefer this over write_file for small edits.',
    parameters: schema({
      path: str('File path relative to the working directory.'),
      search: str('Exact text to find (include enough surrounding lines to be unique). Must be copied verbatim from read_file output without the line-number prefix.'),
      replacement: str('Replacement text.'),
      all: bool('Replace every occurrence instead of requiring a unique match.'),
    }),
  },
  delete_file: {
    category: 'write', group: 'fs',
    description: 'Delete a single file (a backup copy is kept). Directories cannot be deleted.',
    parameters: schema({ path: str('File path relative to the working directory.') }),
  },
  make_dir: {
    category: 'write', group: 'fs',
    description: 'Create a directory (recursively).',
    parameters: schema({ path: str('Directory path relative to the working directory.') }),
  },
  run_command: {
    category: 'exec', group: 'shell',
    description: 'Run a shell command in the working directory (cmd.exe on Windows, /bin/sh elsewhere) and return exit code with captured stdout/stderr. Non-interactive only; output is truncated to a size limit.',
    parameters: schema({
      command: str('The command line to execute.'),
      cwd: nullableStr('Subdirectory (relative to the working directory) to run in. Null = working directory.'),
      timeout_seconds: nullableInt('Time limit in seconds (max 900). Null = default.'),
      reason: str('One sentence: why this command is needed (shown to the user for approval).'),
    }),
  },
  fetch_url: {
    category: 'network', group: 'fetch',
    description: 'Download a public http(s) URL and return its text (HTML is reduced to readable text). Use for documentation or APIs; size-limited.',
    parameters: schema({
      url: str('Absolute http(s) URL.'),
      max_bytes: nullableInt('Maximum number of bytes to return (default and cap: configured limit).'),
    }),
  },
  view_image: {
    category: 'read', group: 'fs',
    description: 'Look at a local image file (PNG/JPEG/GIF/WebP). Either the image is attached to the conversation, or a dedicated vision model describes it and answers your question.',
    parameters: schema({
      path: str('Image file path relative to the working directory.'),
      detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Image detail level to use.' },
      question: nullableStr('What exactly you need to learn from the image (used when a vision model describes it). Null = general detailed description.'),
    }),
  },
  summarize_file: {
    category: 'read', group: 'summarize',
    description: 'Have a cheap model read a (possibly large) text file and return a focused summary: purpose, structure, key symbols, and anything relevant to the focus. Cached per file content.',
    parameters: schema({
      path: str('File path relative to the working directory.'),
      focus: nullableStr('What the summary should concentrate on. Null = general overview.'),
    }),
  },
  recall: {
    category: 'memory', group: 'memory',
    description: 'Search long-term memory (facts, conventions, decisions, pitfalls remembered from earlier sessions in this project and globally).',
    parameters: schema({ query: str('Keywords or a question to search for.') }),
  },
  remember: {
    category: 'memory', group: 'memory',
    description: 'Save a durable fact to long-term memory for future sessions (project conventions, decisions, environment quirks, user preferences). Keep it short and specific.',
    parameters: schema({
      content: str('One or two sentences to remember.'),
      kind: { type: 'string', enum: ['fact', 'convention', 'decision', 'preference', 'pitfall', 'note'], description: 'Type of the memory.' },
      scope: { type: 'string', enum: ['project', 'global'], description: 'project = only this working directory; global = everywhere.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short tags for retrieval.' },
    }),
  },
  ask_user: {
    category: 'user', group: 'user',
    description: 'Ask the human operator a short clarifying question and wait for the answer. Only available in interactive sessions; otherwise returns a note to proceed autonomously.',
    parameters: schema({ question: str('The question to ask.') }),
  },
};

export const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall'];

export function toolDefinitions(names) {
  return names.filter((name) => TOOL_SPECS[name]).map((name) => ({
    type: 'function', name, description: TOOL_SPECS[name].description, parameters: TOOL_SPECS[name].parameters, strict: true,
  }));
}

/** Which tools are enabled for a config.tools selection. */
export function enabledToolNames(tools, { interactive = false, memory = false, summarize = false } = {}) {
  const names = [];
  if (tools.fs) names.push('list_files', 'read_file', 'search_files', 'write_file', 'replace_text', 'delete_file', 'make_dir', 'view_image');
  if (tools.fs && summarize) names.push('summarize_file');
  if (tools.shell) names.push('run_command');
  if (tools.fetch) names.push('fetch_url');
  if (memory) names.push('recall', 'remember');
  if (tools.askUser && interactive) names.push('ask_user');
  return names;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/**
 * Create the executable toolset for one agent run.
 *
 * approvalLevel: 'ask' | 'read' | 'write' | 'all'.
 * approve({ name, category, args, preview }) → 'yes' | 'no' | 'always' | 'abort' (used for 'ask').
 * askUser(question) → string | null (optional; enables the ask_user tool).
 * memory / projectKey / projectName — long-term memory store (enables recall / remember).
 * describeImage({ part, question }) → string — vision role delegation for view_image (optional).
 * summarizeFile({ rel, text, focus }) → string — summarizer role for summarize_file (optional).
 */
export function createToolset({
  root = process.cwd(), config, names, approvalLevel = 'read', approve = async () => 'no', askUser = null,
  backupDir = null, signal, emit = () => {}, memory = null, projectKey = null, projectName = null,
  describeImage = null, summarizeFile = null, editPaths = () => null,
}) {
  const limits = config.limits;
  const allowed = new Set(names);
  if (!memory) { allowed.delete('recall'); allowed.delete('remember'); }
  if (!summarizeFile) allowed.delete('summarize_file');
  const alwaysAllowed = new Set();
  const stats = { calls: 0, byTool: {}, changes: [], commands: [], denied: 0, errors: 0, memories: [] };
  const notify = (event) => { try { emit(event); } catch { /* observer */ } };

  async function decide(name, category, args, preview) {
    if (category === 'read' || category === 'user' || category === 'memory') return true;
    if (approvalLevel === 'all') return true;
    if (approvalLevel === 'write' && category === 'write') return true;
    if (approvalLevel !== 'ask') return false;
    if (alwaysAllowed.has(name)) return true;
    notify({ type: 'approval.request', name, category, preview });
    const answer = await approve({ name, category, args, preview });
    notify({ type: 'approval.result', name, answer });
    if (answer === 'abort') throw new CancelledError('Остановлено пользователем при запросе подтверждения.');
    if (answer === 'always') { alwaysAllowed.add(name); return true; }
    return answer === 'yes';
  }

  function preview(name, args) {
    switch (name) {
      case 'write_file': {
        const bytes = Buffer.byteLength(args.content ?? '');
        const head = String(args.content ?? '').split('\n').slice(0, 12).join('\n');
        return `${args.overwrite ? 'Записать' : 'Создать'} ${args.path} (${formatBytes(bytes)})\n${head}${bytes > Buffer.byteLength(head) ? '\n…' : ''}`;
      }
      case 'replace_text':
        return `Изменить ${args.path}${args.all ? ' (все вхождения)' : ''}\n--- было ---\n${truncate(args.search, 400, { singleLine: false })}\n--- станет ---\n${truncate(args.replacement, 400, { singleLine: false })}`;
      case 'delete_file': return `Удалить файл ${args.path} (копия сохранится в резервном каталоге)`;
      case 'make_dir': return `Создать каталог ${args.path}`;
      case 'run_command': return `Команда: ${args.command}\nКаталог: ${args.cwd ?? '.'}\nПричина: ${args.reason ?? '—'}`;
      case 'fetch_url': return `Загрузить ${args.url}`;
      default: return `${name} ${JSON.stringify(args)}`;
    }
  }

  function labelOutsideEdit(rel, output) {
    const allowed = typeof editPaths === 'function' ? editPaths() : editPaths;
    if (allowed && !allowed.has(rel)) return `Не в карте правок (${rel}): ${output}`;
    return output;
  }

  const handlers = {
    async list_files(args) {
      const result = await listFiles({ root, dir: args.path || '.', depth: Math.min(6, Math.max(1, args.depth ?? 2)),
        includeHidden: Boolean(args.include_hidden), maxEntries: limits.maxListEntries });
      return { output: result.text, summary: `${result.count} записей` };
    },
    async read_file(args) {
      const result = await readTextFile({ root, file: args.path, startLine: args.start_line, endLine: args.end_line, maxBytes: limits.maxFileReadBytes });
      return { output: result.text, summary: `${args.path}: строки ${result.from}-${result.to}/${result.totalLines}` };
    },
    async search_files(args) {
      const scope = args.scope ?? 'all';
      if (!['path', 'symbol', 'content', 'all'].includes(scope)) throw new Error('scope: path, symbol, content или all.');
      const projectMap = await loadProjectMap(root);
      if (projectMap) {
        const result = await searchMapped(projectMap, { query: args.query, dir: args.path || '.', scope, regex: Boolean(args.regex), maxResults: limits.maxSearchResults });
        return { output: result.text, summary: `${result.count} совпадений` };
      }
      const result = await searchFiles({ root, query: args.query, dir: args.path || '.', regex: Boolean(args.regex), maxResults: limits.maxSearchResults });
      return { output: `Карта проекта недоступна; поиск по дереву.\n${result.text}`, summary: `${result.count} совпадений` };
    },
    async write_file(args) {
      const result = await writeTextFile({ root, file: args.path, content: args.content, overwrite: args.overwrite !== false,
        maxBytes: limits.maxFileWriteBytes, backupDir });
      stats.changes.push({ op: result.created ? 'create' : 'overwrite', path: result.rel, backupPath: result.backupPath });
      try { await updateProjectMapPath(root, result.rel); }
      catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
      const output = labelOutsideEdit(result.rel, `${result.created ? 'Создан' : 'Перезаписан'} ${result.rel} (${formatBytes(result.bytes)}).`);
      return { output, summary: `${result.created ? '+' : '~'} ${result.rel}` };
    },
    async replace_text(args) {
      const result = await replaceInFile({ root, file: args.path, search: args.search, replacement: args.replacement, all: Boolean(args.all),
        maxBytes: limits.maxFileWriteBytes, backupDir });
      stats.changes.push({ op: 'edit', path: result.rel, backupPath: result.backupPath });
      try { await updateProjectMapPath(root, result.rel); }
      catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
      const output = labelOutsideEdit(result.rel, `Изменён ${result.rel}: замен ${result.replacements}.`);
      return { output, summary: `~ ${result.rel}` };
    },
    async delete_file(args) {
      const result = await deleteFile({ root, file: args.path, backupDir });
      stats.changes.push({ op: 'delete', path: result.rel, backupPath: result.backupPath });
      try { await updateProjectMapPath(root, result.rel); }
      catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
      const output = labelOutsideEdit(result.rel, `Удалён ${result.rel}.`);
      return { output, summary: `- ${result.rel}` };
    },
    async make_dir(args) {
      const result = await makeDirectory({ root, dir: args.path });
      return { output: `Каталог ${result.rel} создан.`, summary: result.rel };
    },
    async run_command(args) {
      if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('Пустая команда.');
      const cwd = args.cwd ? (await resolveInside(root, args.cwd)).abs : root;
      const timeoutMs = Math.min(900, Math.max(1, args.timeout_seconds ?? Math.round(limits.commandTimeoutMs / 1000))) * 1000;
      const result = await runCommand({ command: args.command, cwd, timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, signal, shell: config.shell ?? null });
      stats.commands.push({ command: args.command, exitCode: result.exitCode, durationMs: result.durationMs });
      const status = result.cancelled ? 'отменена' : result.timedOut ? `таймаут ${timeoutMs / 1000} с` : result.error ? `ошибка запуска: ${result.error}` : `exit code ${result.exitCode}`;
      const body = [`status: ${status}`, `duration_ms: ${result.durationMs}`];
      if (result.stdout) body.push(`--- stdout ---\n${clipMiddle(result.stdout, limits.maxCommandOutputBytes)}`);
      if (result.stderr) body.push(`--- stderr ---\n${clipMiddle(result.stderr, limits.maxCommandOutputBytes)}`);
      if (result.truncated) body.push('(вывод усечён)');
      return { output: body.join('\n'), summary: status, ok: result.exitCode === 0 };
    },
    async fetch_url(args) {
      let url;
      try { url = new URL(args.url); } catch { throw new Error('Некорректный URL.'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Разрешены только http(s) URL.');
      const cap = Math.min(limits.maxFetchBytes, Math.max(1024, args.max_bytes ?? limits.maxFetchBytes));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Таймаут загрузки (45 с).')), 45_000);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'ai-agent-cli/1.0', Accept: 'text/html, text/plain, application/json, */*' } });
        const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const reader = res.body?.getReader();
        const chunks = []; let total = 0; let truncated = false;
        if (reader) {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (total + value.length > cap) { chunks.push(value.subarray(0, cap - total)); total = cap; truncated = true; await reader.cancel().catch(() => {}); break; }
            chunks.push(value); total += value.length;
          }
        }
        let text = Buffer.concat(chunks.map((c) => Buffer.from(c)), total).toString('utf8');
        if (mime.includes('html')) text = htmlToText(text);
        else if (!(mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime === '')) {
          throw new Error(`Неподдерживаемый тип содержимого: ${mime}`);
        }
        const header = `HTTP ${res.status} ${mime}${truncated ? ` (усечено до ${formatBytes(cap)})` : ''}\n`;
        return { output: header + text, summary: `HTTP ${res.status}, ${formatBytes(total)}`, ok: res.ok };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    },
    async view_image(args) {
      const { abs, rel } = await resolveInside(root, args.path, { allowRoot: false });
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
      if (info.size > limits.maxImageBytes) throw new Error(`Изображение больше лимита ${formatBytes(limits.maxImageBytes)}.`);
      const buffer = await readFile(abs);
      const mime = detectImageMime(buffer, abs);
      if (!mime) throw new Error('Не изображение (нужны PNG, JPEG, GIF или WebP).');
      const part = { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}`, detail: args.detail ?? 'auto' };
      if (describeImage) {
        const description = await describeImage({ part, question: args.question ?? null, rel });
        return { output: `Описание изображения ${rel} (модель vision):\n${description}`, summary: `${rel} → vision (${formatBytes(buffer.length)})` };
      }
      return {
        output: [{ type: 'input_text', text: `Изображение ${rel} (${mime}, ${formatBytes(buffer.length)}):` }, part],
        summary: `${rel} (${formatBytes(buffer.length)})`,
      };
    },
    async summarize_file(args) {
      const { abs, rel } = await resolveInside(root, args.path, { allowRoot: false });
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) throw new Error(`Файл не найден: ${args.path}`);
      if (info.size > 8 * 1024 * 1024) throw new Error(`Файл больше 8 MiB: ${rel}`);
      const buffer = await readFile(abs);
      if (buffer.subarray(0, 8192).includes(0)) throw new Error(`Бинарный файл: ${rel}`);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error(`Файл ${rel} не в UTF-8.`); }
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const focus = args.focus ?? null;
      const cacheKey = focus ? `${rel}#${createHash('sha1').update(focus).digest('hex').slice(0, 8)}` : rel;
      const cached = memory && projectKey ? memory.getFileSummary(projectKey, cacheKey, sha256) : null;
      if (cached) return { output: `Сводка ${rel} (из кеша):\n${cached.summary}`, summary: `${rel} (кеш)` };
      const { summary, model } = await summarizeFile({ rel, text, focus });
      if (memory && projectKey) memory.putFileSummary(projectKey, cacheKey, sha256, summary, model ?? null);
      return { output: `Сводка ${rel} (${formatBytes(buffer.length)}):\n${summary}`, summary: `${rel} (${formatBytes(buffer.length)})` };
    },
    async recall(args) {
      const rows = memory.recall(String(args.query ?? ''), { project: projectKey, limit: 10 });
      if (!rows.length) return { output: 'В памяти ничего подходящего не найдено.', summary: '0 записей' };
      return { output: rows.map((r) => `[${r.scope}/${r.kind}#${r.id}] ${r.content}${r.tags ? ` (теги: ${r.tags})` : ''}`).join('\n'), summary: `${rows.length} записей` };
    },
    async remember(args) {
      const row = memory.remember({ scope: args.scope ?? 'project', project: projectKey, projectName, kind: args.kind ?? 'fact',
        content: args.content, tags: args.tags ?? [], source: 'agent' });
      stats.memories.push({ id: row.id, scope: row.scope, kind: row.kind, content: row.content });
      notify({ type: 'memory.saved', count: 1, items: [row] });
      return { output: `Сохранено в память (#${row.id}, ${row.scope}/${row.kind}).`, summary: truncate(row.content, 60) };
    },
    async ask_user(args) {
      if (!askUser) return { output: 'Оператор недоступен (неинтерактивный режим). Примите разумное решение самостоятельно и перечислите допущения в итоговом ответе.', summary: 'нет оператора' };
      const answer = await askUser(String(args.question ?? ''));
      return { output: answer === null || answer === '' ? '(оператор не ответил)' : answer, summary: truncate(answer ?? '', 60) };
    },
  };

  /** Execute one function_call item. Never throws for tool errors; throws only on cancellation. */
  async function execute(call) {
    const name = call.name;
    const started = Date.now();
    stats.calls++;
    stats.byTool[name] = (stats.byTool[name] ?? 0) + 1;
    let args = {};
    const fail = (message) => ({ output: `Ошибка: ${message}`, summary: message, ok: false, durationMs: Date.now() - started, category: TOOL_SPECS[name]?.category ?? null });
    if (!allowed.has(name) || !handlers[name]) { stats.errors++; return fail(`инструмент ${name} недоступен.`); }
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
    catch { stats.errors++; return fail('аргументы не являются корректным JSON.'); }
    const { category } = TOOL_SPECS[name];
    let permitted;
    try { permitted = await decide(name, category, args, preview(name, args)); }
    catch (error) { if (error instanceof CancelledError) throw error; permitted = false; }
    if (!permitted) {
      stats.denied++;
      return fail(`операция ${name} отклонена пользователем или политикой доступа (${approvalLevel}). Не повторяйте её; предложите альтернативу или завершите с описанием.`);
    }
    signal?.throwIfAborted();
    try {
      const result = await handlers[name](args);
      return { ok: true, ...result, durationMs: Date.now() - started, category };
    } catch (error) {
      if (signal?.aborted || error instanceof CancelledError) throw error;
      stats.errors++;
      return fail(errorMessage(error));
    }
  }

  return Object.freeze({
    definitions: () => toolDefinitions([...allowed]),
    execute,
    names: () => [...allowed],
    stats: () => structuredClone(stats),
    get approvalLevel() { return approvalLevel; },
    set approvalLevel(value) { approvalLevel = value; },
    root,
  });
}

export const describeTool = (name) => TOOL_SPECS[name]?.description ?? '';
export const toolCategory = (name) => TOOL_SPECS[name]?.category ?? null;
export const relativeToRoot = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
