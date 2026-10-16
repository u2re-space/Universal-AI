#!/usr/bin/env node
import { parseArgs, styleText, stripVTControlCharacters } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createWorkspace } from './workspace.js';
import { runAgent } from './agent.js';

const HELP = `
Local coding agent — Node.js 26 / ESM

Usage:
  node src/cli.js --root ./project --config ../trusted-agent.json --task "Fix the bug"
  node src/cli.js --root ./project --config ../trusted-agent.json "Add a regression test"

Options:
  --root <directory>       Project root (default: current directory)
  --config <file>          Trusted JSON configuration OUTSIDE the project
  --task <text>            Task; otherwise positional arguments are joined
  --budget <USD>           Session budget according to configured model prices
  --attempts <number>      Total attempts, including the first (default: 3)
  --mode <docker|local|none>
  --allow-local-exec       Acknowledge UNSAFE local execution (POSIX only)
  --json                  JSON Lines; no interactive approvals or publication
  --keep-workspace        Preserve the temporary working copy after completion
  --apply                 Require an interactive publication prompt on success
  --help, -h              Show help

Required: OPENAI_API_KEY and model IDs + current prices in trusted configuration.
Default mode: Docker, no network, pre-existing image only. No dependency installation.
Without a terminal, approvals are denied and the original project is never changed.
There is no --yes / blanket permission flag.
`;

// Remove terminal controls, C0/C1 controls, bidi overrides and Unicode line separators.
// Model text is always plain text: never passed to a shell or interpreted as markup.
export function sanitizeTerminal(value) {
  return stripVTControlCharacters(String(value))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, '');
}

function safeValue(value) {
  if (typeof value === 'string') return sanitizeTerminal(value);
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, data]) => [sanitizeTerminal(key), safeValue(data)]));
  }
  return value;
}

function numberOption(value, name, integer = false) {
  const parsed = Number(value);
  if (!value?.trim() || !Number.isFinite(parsed) || parsed <= 0 || integer && !Number.isSafeInteger(parsed)) {
    throw new Error(`Некорректный --${name}.`);
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: {
        root: { type: 'string', default: '.' }, config: { type: 'string' },
        task: { type: 'string' }, budget: { type: 'string' }, attempts: { type: 'string' },
        mode: { type: 'string' }, 'allow-local-exec': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'keep-workspace': { type: 'boolean', default: false }, apply: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${sanitizeTerminal(error.message)}\n`);
    return 2;
  }
  if (values.help) { process.stdout.write(HELP); return 0; }
  const json = values.json;
  const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const controller = new AbortController();
  let readline, workspace, config, summary, keep = values['keep-workspace'];
  let errorExit = 2;
  const onInterrupt = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Операция отменена пользователем.'));
      if (!json) process.stderr.write('\n[cancel] Отмена запросов и проверок…\n');
    }
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  function writeJson(data) { process.stdout.write(`${JSON.stringify(safeValue(data))}\n`); }
  function line(tag, text) {
    const label = interactive ? styleText('cyan', `[${tag}]`) : `[${tag}]`;
    process.stdout.write(`${label} ${sanitizeTerminal(text)}\n`);
  }
  function emit(event) {
    // Check logs stay in result objects, never streamed unsanitized to the terminal.
    if (json) { writeJson({ time: new Date().toISOString(), ...event }); return; }
    switch (event.type) {
      case 'workspace.created':
        line('scan', `${event.files} файлов; исключено ${event.excluded}; недоступно ${event.unavailable}`);
        break;
      case 'stage.started':
        line(event.stage, `Начало${event.attempt ? ` — попытка ${event.attempt}/${event.maxAttempts ?? config.limits.maxAttempts}` : ''}${event.contextRound ? `, контекст ${event.contextRound}` : ''}…`);
        break;
      case 'model.started':
        line(event.role, `${event.model}; вызов ${event.call}; резерв $${event.reservedUsd.toFixed(6)}`);
        break;
      case 'model.progress':
        line(event.role, `Получено ${event.outputBytes} байт структурированного ответа…`);
        break;
      case 'model.completed':
        line('usage', `Учтено $${event.usage.accountedUsd.toFixed(6)}; неизвестных расходов: ${event.usage.unknownCalls}`);
        break;
      case 'plan.ready':
        line('plan', event.summary);
        for (const step of event.steps) line('step', step);
        break;
      case 'file.read':
        line('context', `${event.path}:${event.startLine}-${event.endLine}, ${event.bytes} байт`);
        break;
      case 'file.search':
        line('search', `${event.query}: ${event.matches} совпадений${event.truncated ? ' (усечено)' : ''}`);
        break;
      case 'context.denied':
        line('policy', `${event.path ?? ''}: ${event.reason}`);
        break;
      case 'patch.proposed':
        line('patch', `${event.files} изменений: ${event.summary}`);
        break;
      case 'patch.applied':
        line('patch', `Применено в рабочей копии: ${event.files}`);
        break;
      case 'patch.rejected':
        line('policy', `Правки отклонены: ${event.reason}`);
        break;
      case 'check.started':
        line('runner', `${event.id} (${event.phase}, ${event.mode}): запуск…`);
        break;
      case 'check.completed':
        line('runner', `${event.id}: ${event.status}, ${event.durationMs} ms${event.error ? ` — ${event.error}` : ''}`);
        if (event.status !== 'passed') {
          const log = `${event.stdout ?? ''}\n${event.stderr ?? ''}`;
          process.stdout.write(`${sanitizeTerminal(log.slice(-6000))}\n`);
        }
        break;
      case 'review.completed':
        line('review', `${event.verdict}: ${event.summary}`);
        for (const issue of event.issues) line(issue.severity, `${issue.path ?? ''} ${issue.message}`);
        break;
      case 'workspace.published':
        line('apply', `Перенесено файлов: ${event.files}`);
        break;
      default: break;
    }
  }

  async function ask(question) {
    controller.signal.throwIfAborted();
    if (!interactive) return false;
    if (!readline) {
      readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      readline.on('SIGINT', onInterrupt);
    }
    const answer = await readline.question(`${sanitizeTerminal(question)} [y/N] `, { signal: controller.signal });
    return /^(?:y|yes|д|да)$/i.test(answer.trim());
  }

  async function approve(request) {
    emit({ type: 'approval.requested', ...request });
    if (!interactive) {
      emit({ type: 'approval.denied', path: request.path, reason: 'Нет интерактивного терминала.' });
      return false;
    }
    if (request.type === 'snapshot-large') {
      line('approval', `${request.path}: ${(request.bytes / 1024).toFixed(1)} KiB`);
      line('reason', request.reason);
      return ask('Разрешить локальное чтение и копирование? Отправка модели потребует отдельного согласия.');
    }
    if (request.type === 'large-file') {
      line('approval', `${request.path}: ${(request.bytes / 1024).toFixed(1)} KiB, строки ${request.startLine}-${request.endLine ?? 'конец'}`);
      line('reason', request.reason);
      return ask('Разрешить локально прочитать файл и отправить только запрошенный фрагмент в пределах лимитов?');
    }
    line('approval', `${request.operation}: ${request.path}`);
    line('reason', request.reason);
    line('hash', `До: ${request.beforeSha256 ?? 'нет'}; после: ${request.afterSha256 ?? 'удалён'}`);
    if (request.preview) process.stdout.write(`${sanitizeTerminal(request.preview)}\n`);
    return ask('Разрешить показанное изменение? Оно всё равно потребует итоговой проверки diff.');
  }

  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major !== 26) throw new Error(`Нужен Node.js 26.x; запущен ${process.versions.node}.`);
    if (values.task && positionals.length) throw new Error('Используйте либо --task, либо позиционные аргументы задачи.');
    const task = (values.task ?? positionals.join(' ')).trim();
    if (!task) throw new Error('Укажите задачу через --task или позиционные аргументы.');
    if (values.apply && !interactive) throw new Error('--apply требует интерактивный терминал; автоматическое согласие не поддерживается.');
    const overrides = { limits: {}, execution: {} };
    if (values.budget !== undefined) overrides.limits.budgetUsd = numberOption(values.budget, 'budget');
    if (values.attempts !== undefined) overrides.limits.maxAttempts = numberOption(values.attempts, 'attempts', true);
    if (values.mode !== undefined) overrides.execution.mode = values.mode;
    if (values['allow-local-exec']) overrides.execution.allowLocal = true;
    config = await loadConfig({ root: values.root, configPath: values.config, overrides });
    if (!process.env.OPENAI_API_KEY) throw new Error('Не задан OPENAI_API_KEY.');
    if (config.execution.mode === 'local') {
      const warning = 'Локальные тесты выполняют код проекта с правами пользователя. Рабочая копия НЕ sandbox; чтение диска и сеть не ограничены.';
      emit({ type: 'warning', message: warning });
      if (!json) line('warning', warning);
      if (interactive && !await ask('Продолжить небезопасное локальное исполнение?')) return 2;
    }
    workspace = await createWorkspace(config, { emit, approve, signal: controller.signal });
    summary = await runAgent({ task, config, workspace, emit, signal: controller.signal });
    const accepted = summary.status === 'accepted';
    if (json) writeJson({ type: 'agent.result', ...summary });
    else {
      line('done', `${summary.status}: ${summary.reason}`);
      line('usage', `${summary.usage.calls} вызовов; учтено $${summary.usage.accountedUsd.toFixed(6)} / $${config.limits.budgetUsd.toFixed(2)}`);
      if (summary.diff.files.length) {
        line('diff', `${summary.diff.files.length} файлов${summary.diff.truncated ? ' (усечён; перенос запрещён)' : ''}`);
        process.stdout.write(`${sanitizeTerminal(summary.diff.text)}\n`);
      }
    }
    if (accepted && summary.diff.files.length && interactive) {
      const consent = await ask('Проверили diff? Перенести изменения в основной проект?');
      if (consent) {
        const applied = await workspace.publish();
        emit({ type: 'publication.completed', files: applied });
      } else {
        keep = true;
        line('apply', 'Основной проект не изменён. Рабочая копия сохранена.');
      }
    }
    // Preserve unsuccessful proposals for inspection; never publish them automatically.
    if (!accepted || !interactive && summary.diff.files.length) keep = true;
    errorExit = summary.status === 'cancelled' ? 130 : accepted ? 0 : 1;
    return errorExit;
  } catch (error) {
    keep = Boolean(workspace);
    errorExit = controller.signal.aborted ? 130 : 2;
    if (json) writeJson({ type: 'fatal', message: error.message, status: controller.signal.aborted ? 'cancelled' : 'blocked' });
    else line('error', error.message);
    return errorExit;
  } finally {
    readline?.close();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    if (workspace) {
      keep ||= workspace.broken;
      try {
        await workspace.dispose({ keep });
        emit({ type: 'workspace.closed', kept: keep, ...(keep ? { directory: workspace.sessionDir } : {}) });
        if (keep && !json) line('workspace', `Локальная копия сохранена: ${workspace.sessionDir}`);
      } catch (error) {
        if (json) writeJson({ type: 'cleanup.error', message: error.message });
        else line('cleanup', error.message);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
