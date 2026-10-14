import { createJobManager } from '../jobs/manager.js';
import { sanitizeTerminal } from '../ui/sanitize.js';
import { formatDuration, formatNumber, formatUsd, truncate } from '../util/text.js';
import { UsageError } from './shared.js';

const STATUS_RU = { created: 'создана', running: 'выполняется', completed: 'завершена', failed: 'ошибка', cancelled: 'отменена', unknown: '?' };

function describeJob(job) {
  const { meta, status, result } = job;
  const started = meta.startedAt ? new Date(meta.startedAt) : null;
  const finished = meta.finishedAt ? new Date(meta.finishedAt) : null;
  const elapsed = started ? formatDuration((finished ?? new Date()) - started) : '—';
  const ledger = status?.ledger ?? result?.usage ?? null;
  const tokens = ledger ? `↑ ${formatNumber(ledger.input)} ↓ ${formatNumber(ledger.output)}${ledger.costKnown && ledger.requests ? ` · ${formatUsd(ledger.costUsd)}` : ''}` : '—';
  return { elapsed, tokens, phase: status?.phase ? `${status.phase}${status.detail ? ` · ${truncate(status.detail, 40)}` : ''}` : '' };
}

/**
 * `ai jobs <list|status|log|result|wait|cancel|rm> [id]` — manage detached background jobs
 * started with --detach. Ids may be abbreviated to a unique prefix.
 */
export async function jobs(ctx) {
  const { config, renderer, positionals, values, signal } = ctx;
  const manager = createJobManager({ home: config.home });
  const [sub = 'list', id] = positionals;
  const print = (text) => renderer.write(`${text}\n`);
  const out = (data, text) => (renderer.mode === 'json' ? renderer.json(data) : print(text));

  switch (sub) {
    case 'list': case 'ls': {
      const list = await manager.list();
      if (renderer.mode === 'json') { renderer.json({ type: 'jobs', jobs: list.map((j) => ({ ...j.meta, live: j.status, result: j.result ? { status: j.result.status } : null })) }); return 0; }
      if (!list.length) { print('Фоновых задач нет. Запустите: ai run --detach "задача"'); return 0; }
      for (const job of list) {
        const d = describeJob(job);
        print(`${job.id}  ${(STATUS_RU[job.meta.status] ?? job.meta.status).padEnd(11)} ${d.elapsed.padStart(8)}  ${d.tokens.padEnd(28)}  ${truncate(sanitizeTerminal(job.meta.title ?? ''), 60)}${d.phase && job.meta.status === 'running' ? `\n${' '.repeat(22)}↳ ${d.phase}` : ''}`);
      }
      return 0;
    }
    case 'status': case 'show': {
      const job = await manager.get(id);
      const d = describeJob(job);
      out({ type: 'job', ...job.meta, live: job.status, result: job.result },
        [`id: ${job.id}`, `статус: ${STATUS_RU[job.meta.status] ?? job.meta.status}`, `задача: ${sanitizeTerminal(job.meta.title ?? '')}`,
          `каталог: ${job.meta.cwd}`, `pid: ${job.meta.pid ?? '—'}`, `запущена: ${job.meta.startedAt ?? '—'}`, `завершена: ${job.meta.finishedAt ?? '—'}`,
          `время: ${d.elapsed}`, `токены: ${d.tokens}`, ...(job.status ? [`фаза: ${d.phase || '—'}`, `ход: ${job.status.turn ?? '—'}`, `последнее действие: ${job.status.lastAction ?? '—'}`] : []),
          ...(job.result ? [`результат: ${job.result.status}`, `файлы: ${job.result.tools?.changes?.map((c) => c.path).join(', ') || '—'}`, `изображения: ${job.result.images?.join(', ') || '—'}`] : []),
          `папка: ${job.dir}`].join('\n'));
      return 0;
    }
    case 'log': case 'tail': {
      const follow = Boolean(values.follow);
      const job = await manager.get(id);
      if (renderer.mode !== 'json') print(`# ${job.id} · ${STATUS_RU[job.meta.status] ?? job.meta.status}${follow ? ' · слежение (Ctrl-C — выход)' : ''}`);
      for await (const line of manager.tail(job.id, { follow, signal })) {
        if (renderer.mode === 'json') { print(line); continue; }
        let event;
        try { event = JSON.parse(line); } catch { print(line); continue; }
        const time = event.time ? new Date(event.time).toLocaleTimeString() : '';
        if (event.type === 'text.delta') continue;
        if (event.type === 'log') print(`${time} ${sanitizeTerminal(event.message)}`);
        else if (event.type === 'tool.exec.start') print(`${time} ▸ ${event.name} ${sanitizeTerminal(JSON.stringify(event.args ?? {}))}`);
        else if (event.type === 'tool.exec.done') print(`${time} ${event.ok ? '✓' : '✗'} ${event.name} · ${sanitizeTerminal(event.summary ?? '')}`);
        else if (event.type === 'response.done') print(`${time} ≡ ↑ ${formatNumber(event.usage?.input ?? 0)} ↓ ${formatNumber(event.usage?.output ?? 0)} · ${formatDuration(event.elapsedMs)}`);
        else if (event.type === 'image.saved') print(`${time} ▣ ${event.path}`);
        else if (['warning', 'error', 'budget.exceeded'].includes(event.type)) print(`${time} ⚠ ${sanitizeTerminal(event.message)}`);
        else if (event.type === 'result') print(`${time} ■ результат: ${event.status}\n${sanitizeTerminal(event.text ?? '')}`);
        else if (values.verbose) print(`${time} · ${event.type}`);
      }
      return 0;
    }
    case 'result': case 'text': {
      const job = await manager.get(id);
      if (!job.result) throw new UsageError(`Результата пока нет (статус: ${STATUS_RU[job.meta.status] ?? job.meta.status}).`);
      out(job.result, job.result.text ?? '');
      return job.result.status === 'completed' ? 0 : 1;
    }
    case 'wait': {
      const job = await manager.wait(id, { signal });
      out({ type: 'job', ...job.meta, result: job.result }, `${job.id}: ${STATUS_RU[job.meta.status] ?? job.meta.status}`);
      return job.meta.status === 'completed' ? 0 : 1;
    }
    case 'cancel': case 'stop': case 'kill': {
      const job = await manager.cancel(id);
      out({ type: 'job', ...job.meta }, job.alreadyFinished ? `${job.id}: уже завершена (${STATUS_RU[job.meta.status]})` : `${job.id}: остановлена`);
      return 0;
    }
    case 'rm': case 'remove': case 'delete': {
      const removed = await manager.remove(id);
      out({ type: 'job.removed', id: removed }, `${removed}: удалена`);
      return 0;
    }
    default:
      throw new UsageError(`Неизвестная подкоманда jobs ${sub}. Доступно: list, status, log [--follow], result, wait, cancel, rm.`);
  }
}
