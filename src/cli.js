import path from 'node:path';
import { parseArgs } from 'node:util';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadConfig } from './core/config.js';
import { createRenderer, detectMode } from './ui/renderer.js';
import { createJobManager } from './jobs/manager.js';
import { ApiError, BudgetError, CancelledError, isAbortError } from './openai/errors.js';
import { UsageError, overridesFrom } from './commands/shared.js';
import { ask } from './commands/ask.js';
import { chat } from './commands/chat.js';
import { run } from './commands/run.js';
import { image } from './commands/image.js';
import { jobs } from './commands/jobs.js';
import { memoryCommand } from './commands/memory.js';
import { resume, cancel, models, configCommand } from './commands/misc.js';
import { mapCommand } from './commands/map.js';

const pkg = createRequire(import.meta.url)('../package.json');

export const HELP = `ai — CLI-агент на OpenAI Responses API (Node.js 26)

Использование:
  ai [ask] "запрос"                 один запрос → ответ (текст, код, документ)
  ai chat                           интерактивный чат (/help — команды чата)
  ai run "задача"                   автономный агент: файлы, команды, URL, web, картинки
  ai image "описание"               генерация изображения (image_generation)
  ai resume <resp_id>               подключиться к фоновому ответу API
  ai cancel <resp_id>               отменить фоновый ответ API
  ai jobs [list|status|log|result|wait|cancel|rm] [id]   локальные фоновые задачи
  ai memory [list|search|add|forget|clear|tasks|stats|path] …   долговременная память (SQLite)
  ai models [фильтр]                список доступных моделей
  ai config [show|init|path]        конфигурация (~/.ai-agent/config.json)
  ai map [path]                     карта проекта .ai/map.json (файлы и символы). Черновик read/edit/scan подтверждает planner; запись вне edit выполняется и помечается

Ввод:
  --image <путь|url>     приложить изображение (можно несколько)   --detail auto|low|high|original
  --file, -f <путь>      приложить файл: PDF, текст (можно несколько)
  stdin                  текст из канала добавляется как контекст (или становится запросом)
  --instructions, -i <текст|@файл>   дополнительные инструкции модели
  --schema <файл.json>   структурированный вывод по JSON-схеме (ask)

Модель и вывод:
  --model, -m <id>       модель (по умолчанию из конфигурации / AI_MODEL)
  --effort <уровень>     reasoning: none|minimal|low|medium|high|xhigh|max
  --summary <режим>      показ рассуждений: auto|concise|detailed|none      --no-reasoning  скрыть
  --verbosity low|medium|high   --temperature <n>   --max-output-tokens <n>
  --out, -o <путь>       сохранить ответ в файл (для image — путь/каталог изображений)
  --session, -s <имя>    постоянная сессия (история сохраняется в ~/.ai-agent/sessions)
  --store                хранить состояние на сервере (previous_response_id) вместо локальной истории
  --no-stream            без потоковой передачи

Инструменты и автономность:
  --tools fs,shell,fetch  локальные инструменты для ask/chat (run включает их по конфигурации)   --no-tools
  search_files scope=path|symbol|content|all читает карту проекта.
  --web                  поиск в интернете (web_search)       --images   генерация картинок в ответах
  --approve ask|read|write|all   политика подтверждений (по умолчанию: ask в терминале, read без него)
  --yes, -y              = --approve all (без вопросов; осторожно)
  --cwd, -C <каталог>    рабочий каталог для инструментов (по умолчанию текущий)
  --max-turns <n>        лимит ходов агента          --shell powershell|pwsh|bash|sh|cmd
  --budget-usd <n>       лимит расходов (нужны prices в конфигурации)   --budget-tokens <n>

Роли и память (run):
  --role <роль=модель[:effort]>  модель для роли: planner, collector, worker, reviewer, vision, summarizer, default, all
                         (например: --role planner=gpt-6.1-sol:high --role worker=gpt-6-luna --role vision=gpt-6-luna)
  --team / --single      команда ролей (план → сбор контекста → исполнение → ревью → память) / один агент
  --no-memory            не использовать долговременную память (SQLite в ~/.ai-agent/memory.db)
  --global               memory: работать с глобальными записями   --kind <вид>  --tags a,b

Фон:
  --background, -b       фоновый режим Responses API (сервер считает, можно переподключиться: ai resume)
  --detach, -d           запустить как локальную фоновую задачу (ai jobs …)
  --follow               jobs log: следить за журналом

Изображения (image / --images):
  --size WxH|auto  --quality low|medium|high|xhigh|max|auto  --format png|webp|jpeg
  --image-background transparent|opaque|auto  --partials 0..3  --image-model <id>  --count, -n <n>

Прочее:
  --json                 события и результат в формате JSON Lines     --quiet, -q   только ответ
  --verbose, -v          подробный журнал     --timeout <сек>   таймаут простоя соединения
  --config <файл>        дополнительный файл конфигурации     --base-url <url>
  --help, -h  --version, -V

Переменные окружения: OPENAI_API_KEY (обязательно), OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID,
AI_MODEL, AI_IMAGE_MODEL, AI_AGENT_HOME (по умолчанию ~/.ai-agent), AI_ASCII=1 (без Unicode-символов).
Коды выхода: 0 — успех, 1 — задача не завершена/ошибка API, 2 — ошибка аргументов/конфигурации, 130 — отменено.
`;

const OPTIONS = {
  model: { type: 'string', short: 'm' }, effort: { type: 'string' }, summary: { type: 'string' },
  reasoning: { type: 'boolean', default: true }, instructions: { type: 'string', short: 'i' },
  image: { type: 'string', multiple: true }, file: { type: 'string', short: 'f', multiple: true }, detail: { type: 'string' },
  out: { type: 'string', short: 'o' }, session: { type: 'string', short: 's' }, store: { type: 'boolean', default: false },
  web: { type: 'boolean', default: false }, images: { type: 'boolean', default: false }, tools: { type: 'string' },
  'no-tools': { type: 'boolean', default: false }, approve: { type: 'string' }, yes: { type: 'boolean', short: 'y', default: false },
  cwd: { type: 'string', short: 'C' }, 'max-turns': { type: 'string' }, 'budget-usd': { type: 'string' }, 'budget-tokens': { type: 'string' },
  'max-output-tokens': { type: 'string' }, temperature: { type: 'string' }, verbosity: { type: 'string' }, shell: { type: 'string' },
  background: { type: 'boolean', short: 'b', default: false }, detach: { type: 'boolean', short: 'd', default: false }, job: { type: 'string' },
  json: { type: 'boolean', default: false }, quiet: { type: 'boolean', short: 'q', default: false }, verbose: { type: 'boolean', short: 'v', default: false },
  stream: { type: 'boolean', default: true }, config: { type: 'string' }, 'base-url': { type: 'string' }, timeout: { type: 'string' },
  size: { type: 'string' }, quality: { type: 'string' }, format: { type: 'string' }, 'image-background': { type: 'string' },
  partials: { type: 'string' }, 'image-model': { type: 'string' }, count: { type: 'string', short: 'n' }, schema: { type: 'string' },
  follow: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', short: 'V', default: false },
  role: { type: 'string', multiple: true }, single: { type: 'boolean', default: false }, team: { type: 'boolean', default: false },
  memory: { type: 'boolean', default: true }, global: { type: 'boolean', default: false }, kind: { type: 'string' }, tags: { type: 'string' },
};

const COMMANDS = { ask, chat, run, image, jobs, memory: memoryCommand, resume, cancel, models, config: configCommand, map: mapCommand };
const NEEDS_API_KEY = new Set(['ask', 'chat', 'run', 'image', 'resume', 'cancel', 'models']);
const DETACHABLE = new Set(['ask', 'run', 'image']);

/** Remove --detach / -d (also inside combined short groups like -dv) from the raw argv. */
export function stripDetach(argv) {
  const result = [];
  for (const arg of argv) {
    if (arg === '--detach') continue;
    if (/^-[a-zA-Z]+$/.test(arg) && arg.includes('d')) {
      const rest = arg.slice(1).replace('d', '');
      if (rest) result.push(`-${rest}`);
      continue;
    }
    result.push(arg);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, allowNegative: true }));
  } catch (error) {
    process.stderr.write(`Ошибка аргументов: ${error.message}\nСправка: ai --help\n`);
    return 2;
  }
  if (values.version) { process.stdout.write(`${pkg.name} ${pkg.version}\n`); return 0; }
  const hasCommand = positionals.length && Object.hasOwn(COMMANDS, positionals[0]);
  const commandName = hasCommand ? positionals[0] : positionals[0] === 'help' ? 'help' : 'ask';
  const rest = hasCommand || commandName === 'help' ? positionals.slice(1) : positionals;
  if (values.help || commandName === 'help') { process.stdout.write(HELP); return 0; }

  const mode = detectMode({ json: values.json, quiet: values.quiet });
  const renderer = createRenderer({ mode, showReasoning: values.reasoning !== false, verbose: values.verbose });
  const controller = new AbortController();
  let turnController = null;
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (turnController && !turnController.signal.aborted) {
      turnController.abort(new CancelledError('Ответ прерван пользователем.'));
      renderer.line('warn', 'Прерывание текущего ответа… (ещё раз Ctrl-C — выход)');
    } else if (!controller.signal.aborted) {
      controller.abort(new CancelledError('Операция отменена пользователем.'));
      renderer.line('warn', 'Отмена…');
    } else if (interrupts >= 3) {
      process.exit(130);
    }
  };
  renderer.onInterrupt = onInterrupt;
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  let reporter = null;
  let exitCode = 1;
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 26) throw new UsageError(`Нужен Node.js 26+; запущен ${process.versions.node}.`);
    const cwd = path.resolve(values.cwd ?? '.');
    if (!(await stat(cwd).then((s) => s.isDirectory()).catch(() => false))) throw new UsageError(`Каталог не найден: ${cwd}`);
    const config = await loadConfig({ configPath: values.config, overrides: overridesFrom(values) });
    if (NEEDS_API_KEY.has(commandName) && !config.apiKey) {
      throw new UsageError('Не задан OPENAI_API_KEY. Экспортируйте переменную окружения или укажите apiKey в ~/.ai-agent/config.json.');
    }

    if (values.detach) {
      if (values.job) throw new UsageError('--detach нельзя сочетать с --job.');
      if (!DETACHABLE.has(commandName)) throw new UsageError('--detach поддерживается для ask, run и image.');
      const manager = createJobManager({ home: config.home });
      const childArgv = stripDetach(argv);
      const title = `${commandName} ${rest.join(' ')}`.trim();
      const { id } = await manager.create({ title, argv: childArgv, cwd });
      const pid = await manager.spawnDetached({ id, script: fileURLToPath(new URL('../bin/ai.js', import.meta.url)), argv: childArgv, cwd });
      if (commandName === 'run' && !config.approve) {
        renderer.line('warn', 'Фоновая задача неинтерактивна: без --approve write|all агент сможет только читать файлы.');
      }
      renderer.write(`Фоновая задача ${id} запущена (pid ${pid}).\n  статус:  ai jobs status ${id}\n  журнал:  ai jobs log ${id} --follow\n  стоп:    ai jobs cancel ${id}\n`);
      renderer.json({ type: 'job.started', id, pid, title });
      return 0;
    }
    if (values.job) {
      reporter = createJobManager({ home: config.home }).reporter(values.job);
      renderer.onStatus = (status) => reporter.status(status);
    }
    const emit = (event) => { renderer.handle(event); reporter?.event(event); };
    const ctx = {
      argv, values, positionals: rest, config, renderer, controller, signal: controller.signal, emit, cwd, reporter, backupDir: null,
      setTurnController(next) { turnController = next; },
      turnSignal: () => (turnController ? AbortSignal.any([controller.signal, turnController.signal]) : controller.signal),
    };
    exitCode = await COMMANDS[commandName](ctx);
    return exitCode;
  } catch (error) {
    renderer.idle();
    if (error instanceof UsageError) {
      renderer.line('fail', error.message);
      renderer.line('info', 'Справка: ai --help', { dim: true });
      exitCode = 2;
    } else if (isAbortError(error) || controller.signal.aborted) {
      renderer.line('warn', 'Отменено.');
      exitCode = 130;
    } else if (error instanceof ApiError) {
      const details = [error.status ? `HTTP ${error.status}` : null, error.apiCode ? `код ${error.apiCode}` : null,
        error.requestId ? `request-id ${error.requestId}` : null].filter(Boolean).join(', ');
      renderer.line('fail', `${error.message}${details ? ` (${details})` : ''}`);
      if (error.code === 'NO_API_KEY') renderer.line('info', 'Задайте OPENAI_API_KEY в окружении.', { dim: true });
      if (values.verbose && error.cause) renderer.line('info', String(error.cause?.stack ?? error.cause), { dim: true });
      exitCode = 1;
    } else if (error instanceof BudgetError) {
      renderer.line('fail', error.message);
      exitCode = 1;
    } else {
      renderer.line('fail', `Ошибка: ${error.message}`);
      if (values.verbose && error.stack) renderer.line('info', error.stack, { dim: true });
      exitCode = 1;
    }
    renderer.json({ type: 'fatal', message: error.message, code: error.code ?? null, exitCode });
    await reporter?.finish({ status: exitCode === 130 ? 'cancelled' : 'failed', text: '', error: { message: error.message, code: error.code ?? null } }, exitCode).catch(() => {});
    return exitCode;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    renderer.close();
  }
}
