/**
 * @file src/cli-help.js
 * @module cli-help
 * @purpose Help text printed by `ai --help`. Wording is user-facing; keep the spacing inside the template.
 * @usedBy cli
 * @exports HELP
 * @ai.tags cli
 * @ai.hint pure
 * @changed 2026-10-15 Split from cli.js.
 */
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
  --desktop              включает экран Windows, мышь, клавиатуру и AutoHotkey v2
  --approve ask|read|write|all   политика подтверждений (по умолчанию: ask в терминале, read без него)
  --yes, -y              = --approve all (без вопросов; осторожно)
  --cwd, -C <каталог>    рабочий каталог для инструментов (по умолчанию текущий)
  --max-turns <n>        лимит ходов агента          --shell powershell|pwsh|bash|sh|cmd
  --budget-usd <n>       лимит расходов (нужны prices в конфигурации)   --budget-tokens <n>

Роли и память (run):
  --role <роль=модель[:effort]>  модель для роли: planner, collector, worker, reviewer, vision, summarizer,
                         scanner, solver, clicker, typer, encoder, tester, default, all
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

