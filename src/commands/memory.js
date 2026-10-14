import { MEMORY_KINDS } from '../core/memory.js';
import { sanitizeTerminal } from '../ui/sanitize.js';
import { formatNumber, truncate } from '../util/text.js';
import { UsageError, openMemoryFor } from './shared.js';

const SCOPE_RU = { global: 'глобально', project: 'проект' };

function formatRow(row) {
  return `#${String(row.id).padEnd(4)} ${SCOPE_RU[row.scope] ?? row.scope}/${row.kind}${row.project_name && row.scope === 'project' ? ` (${row.project_name})` : ''}  ${sanitizeTerminal(row.content)}${row.tags ? `  [${row.tags}]` : ''}`;
}

/**
 * `ai memory <list|search|add|forget|clear|tasks|stats|path> …` — long-term memory management.
 * Memory is scoped to the working directory (project) plus global entries; use --global for global.
 */
export async function memoryCommand(ctx) {
  const { config, renderer, positionals, values } = ctx;
  const [sub = 'list', ...rest] = positionals;
  if (sub === 'path') { renderer.write(`${config.memory.dbFile}\n`); renderer.json({ type: 'memory.path', file: config.memory.dbFile }); return 0; }
  const store = openMemoryFor({ ...config, memory: { ...config.memory, enabled: true } }, ctx.cwd, renderer);
  if (!store) throw new UsageError('Не удалось открыть хранилище памяти.');
  const { memory, projectKey, projectName } = store;
  const out = (data, text) => (renderer.mode === 'json' ? renderer.json(data) : renderer.write(`${text}\n`));
  try {
    switch (sub) {
      case 'list': case 'ls': {
        const rows = memory.list({ project: projectKey, scope: values.global ? 'global' : null, kind: values.kind ?? null, includeGlobal: true });
        if (renderer.mode === 'json') { renderer.json({ type: 'memories', project: projectKey, projectName, items: rows }); return 0; }
        if (!rows.length) { renderer.write(`Память пуста (проект ${projectName}). Добавить: ai memory add "текст"\n`); return 0; }
        renderer.write(`${rows.map(formatRow).join('\n')}\n`);
        renderer.line('info', `${rows.length} записей · проект ${projectName} (${projectKey}) · ${memory.fts ? 'FTS5' : 'LIKE'}-поиск`, { dim: true });
        return 0;
      }
      case 'search': case 'find': {
        const query = rest.join(' ').trim();
        if (!query) throw new UsageError('Укажите запрос: ai memory search "ключевые слова"');
        const rows = memory.recall(query, { project: projectKey, limit: Number(values.count ?? 20) || 20 });
        if (renderer.mode === 'json') { renderer.json({ type: 'memories', query, items: rows }); return 0; }
        renderer.write(rows.length ? `${rows.map(formatRow).join('\n')}\n` : 'Ничего не найдено.\n');
        return 0;
      }
      case 'add': case 'remember': {
        const content = rest.join(' ').trim();
        if (!content) throw new UsageError('Укажите текст: ai memory add "факт" [--kind fact|convention|decision|preference|pitfall|note] [--tags a,b] [--global]');
        const kind = values.kind ?? 'note';
        if (!MEMORY_KINDS.includes(kind)) throw new UsageError(`--kind: ${MEMORY_KINDS.join(' | ')}`);
        const row = memory.remember({ scope: values.global ? 'global' : 'project', project: projectKey, projectName, kind, content, tags: values.tags ?? '', source: 'user' });
        out({ type: 'memory.saved', item: row }, `Сохранено: ${formatRow(row)}`);
        return 0;
      }
      case 'forget': case 'rm': case 'delete': {
        const id = Number(rest[0]);
        if (!Number.isSafeInteger(id)) throw new UsageError('Укажите id записи: ai memory forget 12');
        const removed = memory.forget(id);
        out({ type: 'memory.forgotten', id, removed }, removed ? `Запись #${id} удалена.` : `Запись #${id} не найдена.`);
        return removed ? 0 : 1;
      }
      case 'clear': {
        if (!values.yes && renderer.interactive) {
          const answer = await renderer.ask(`Удалить ${values.global ? 'ВСЕ глобальные записи' : `все записи проекта ${projectName}`}? [y/N]`);
          if (!/^(y|yes|д|да)$/i.test(answer ?? '')) { renderer.write('Отменено.\n'); return 1; }
        }
        const count = memory.clear({ project: projectKey, scope: values.global ? 'global' : 'project' });
        out({ type: 'memory.cleared', count }, `Удалено записей: ${count}`);
        return 0;
      }
      case 'tasks': case 'history': {
        const rows = memory.listTasks({ project: values.global ? null : projectKey, limit: Number(values.count ?? 20) || 20 });
        if (renderer.mode === 'json') { renderer.json({ type: 'tasks', items: rows }); return 0; }
        if (!rows.length) { renderer.write('История задач пуста.\n'); return 0; }
        for (const row of rows) {
          renderer.write(`${row.created_at.slice(0, 16).replace('T', ' ')}  ${row.status.padEnd(10)} ${truncate(sanitizeTerminal(row.task), 90)}\n`);
          if (row.summary) renderer.write(`    ${truncate(sanitizeTerminal(row.summary), 200)}\n`);
          const changes = JSON.parse(row.changes ?? '[]');
          if (changes.length) renderer.write(`    файлы: ${changes.slice(0, 8).join(', ')}${changes.length > 8 ? ` … (+${changes.length - 8})` : ''}\n`);
        }
        return 0;
      }
      case 'stats': {
        const stats = memory.stats();
        out({ type: 'memory.stats', ...stats, project: projectKey, projectName },
          `записей: ${formatNumber(stats.memories)} (глобальных ${stats.global}, проектов ${stats.projects}) · сводок файлов: ${stats.fileSummaries} · задач: ${stats.tasks} · поиск: ${stats.fts ? 'FTS5' : 'LIKE'}\nфайл: ${stats.file}\nтекущий проект: ${projectName} (${projectKey})`);
        return 0;
      }
      default:
        throw new UsageError(`Неизвестная подкоманда memory ${sub}. Доступно: list, search, add, forget, clear, tasks, stats, path.`);
    }
  } finally {
    memory.close();
  }
}
