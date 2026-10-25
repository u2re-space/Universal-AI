/**
 * @file src/cli-help.js
 * @module cli-help
 * @purpose Help text printed by `ai --help`. Wording is user-facing; keep the spacing inside the template.
 * @usedBy cli
 * @exports HELP
 * @ai.tags cli
 * @ai.hint pure
 * @changed 2026-10-22 Help mentions turn extension, image tools, and asset downloads.
 */
export const HELP = `ai — CLI-агент на OpenAI Responses API (Node.js 26)

Использование:
  ai [ask] "запрос"                 один запрос → ответ (текст, код, документ)
  ai chat                           интерактивный чат (/help — команды чата)
  ai run "задача"                   автономный агент: файлы, команды, URL, web, картинки
  ai gen [landing|site|backend|app] "задача"   то же, что run; первое слово-вид выбирает генерацию
  ai image "описание"               генерация изображения (image_generation)
  ai resume                         последний незавершённый шаг в этом каталоге
  ai resume "что доработать"        продолжить и добавить, исправить или доработать
  ai resume <шаг> ["текст"]         начиная с шага (2 или s02); без номера — с незавершённого
  ai resume <resp_id>               подключиться к фоновому ответу API
  ai cancel <resp_id>               отменить фоновый ответ API
  ai jobs [list|status|log|result|wait|cancel|rm] [id]   локальные фоновые задачи
  ai memory [list|search|add|forget|clear|tasks|stats|path] …   долговременная память (SQLite)
  ai agents [show|init]             показать найденные AGENTS.md или создать шаблон
  ai models [фильтр]                список доступных моделей
  ai config [show|init|path]        конфигурация (~/.ai-agent/config.json)
  ai map [path]                     карта проекта .ai/map.json (файлы и символы). Черновик read/edit/scan подтверждает planner; запись вне edit выполняется и помечается
  ai complete                       вставка в месте курсора (JSON из stdin), учитывает AGENTS.md. Модель gpt-6-luna, effort none
  ai complete --listen [--port n]   HTTP POST и WebSocket /v1/complete на 127.0.0.1 (для редактора)
  ai mcp [list|add|remove|probe]    пользовательские MCP-серверы (stdio)
  ai decide [набор] "текст"         вероятности Decisions API (community, support, smm, guard, route)
  ai moderate [набор] "текст"       модерация: omni-moderation-latest или decisions, если /moderations нет
  ai channels --listen [--port n]   HTTP и WebSocket: /v1/decisions, /v1/moderate, /v1/chats/reply, /v1/channels
  ai telegram poll                  длинный опрос Telegram: модерация групп, каналов и личных чатов
  ai telegram send <chat_id> "текст"  отправить сообщение ботом
  ai serve [--port n]               шина и дополнение кода на одном порту 127.0.0.1: WebSocket шины, POST /v1/complete, POST /v1/structure и их WebSocket. Токен из ~/.ai-agent/serve.json (или --token / AI_COMPLETE_TOKEN). Кадр start принимает дополнительные поля. approval.request отвечает сокет, отправивший start

Ввод:
  --image <путь|url>     приложить изображение (можно несколько)   --detail auto|low|high|original
  --file, -f <путь>      приложить файл: PDF, текст (можно несколько)
  stdin                  текст из канала добавляется как контекст (или становится запросом)
  --instructions, -i <текст|@файл>   дополнительные инструкции модели
  --agents-file <путь>   использовать указанный файл инструкций проекта
  --no-agents            отключить автоматическую загрузку AGENTS.md
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
  --tools fs,shell,fetch,mcp,channels,subagents  локальные инструменты для ask/chat (run включает их по конфигурации)   --no-tools
  search_files scope=path|symbol|content|all читает карту проекта.
  --web                  поиск web_search на /v1/responses (ProxyAPI), включён по умолчанию; --no-web выключает
                         запросы и страницы печатаются под ответом
  --images               генерация картинок в ответах; вместе с tools.images — split_image, crop_image, generate_svg
  --desktop              включает экран Windows, мышь, клавиатуру и AutoHotkey v2
  --unsafe-screenshot    разрешить снимок рабочего стола. Без флага screenshot и снимок после клика выключены
  --approve ask|read|write|all   политика подтверждений (по умолчанию: ask в терминале, read без него)
  --yes, -y              = --approve all (без вопросов; осторожно)
  --cwd, -C <каталог>    рабочий каталог для инструментов (по умолчанию текущий)
  --max-turns <n>        лимит ходов агента          --shell powershell|pwsh|bash|sh|zsh|cmd
                         когда лимит исчерпан, терминал предлагает продлить на limits.extendTurns (10) ходов
  При tools.fetch доступны download_font (Google Fonts или URL) и download_icons (Phosphor, Lucide с CDN).
  При tools.subagents доступен run_subagent: отдельный агент со своим контекстом, своими инструментами
  и лимитом ходов. coder, worker, writer правят файлы; reviewer и tester только проверяют; vision описывает
  картинки; solver отвечает по экрану или картинке; image-processor готовит ассеты. Суб-агент не видит
  переписку — задачу пишут целиком; свой суб-агент ему недоступен, и правит он лишь то, что разрешено вызвавшему.

  split_image и crop_image требуют ImageMagick (magick или convert); путь задаётся полем magickPath.
  crop_image режет коробку x/y/width/height, а с trim=true снимает padding по краям.
  При tools.shell агент может: run_command (оболочка на вызов), run_script (.ps1 .cmd .bat .sh .bash), ssh (команда или файл, scp put/get).
  --budget-usd <n>       лимит расходов (нужны prices в конфигурации)   --budget-tokens <n>

Команда (run и gen):
  --role <роль=модель[:effort]>  модель для роли: planner, architect, orchestrator, worker, coder, writer, reviewer, vision,
                         summarizer, solver, clicker, typer, encoder, tester, classifier, extractor, measurer, image-processor, default, all
                         (например: --role planner=gpt-6-luna:high --role worker=gpt-6-luna --role vision=gpt-6-luna)
                         --role collector=... и --role coordinator=... принимают orchestrator (объединённая роль)
    --team / --single      команда ролей / один агент     --no-chain   сразу planner, без первого ответа
    --orchestrator         оркестратор после этапов: сбор контекста, свежий взгляд на план, правки плана и указания следующему шагу
   --extract off|auto|always  extractor чистит ответ и кладёт готовые файлы в .tmp/<id>/extracted.
                         auto — только для маршрута encoder, always — и для planner. --no-extract выключает
   --measure off|auto|always  measurer снимает метрики с референсов после плана: блоки, углы, границы, деление, отступы, расстановку.
                          Планировщик может назначить imageTasks; image-processor готовит их до worker.
                          auto — только при приложенных картинках и нетривиальном плане (по умолчанию), always — всегда, --no-measure выключает.
                          Лист замеров уходит в общий контекст и в .tmp/<id>/measurements.json
   --architect off|auto|always  architect после плана и замеров строит файловую/модульную структуру, дизайн-решения
                          и пошаговый бриф для остальных ролей; его вопросы получает orchestrator.
                          auto — только для нетривиального плана (по умолчанию), always — всегда, --no-architect выключает.
                          Структура уходит в общий контекст и в .tmp/<id>/architecture.json
  --no-resume            не продолжать незавершённый шаг, фазу и ход из .tmp (по умолчанию тот же текст задачи продолжается с места остановки)
  --route encoder|planner|decisions  куда отдать первый ответ. decisions спрашивает модель решений. Без флага решает метка ответа
  В каталоге Node.js или фронтенда сканер (до ответа, encoder и planner) кладёт в контекст package.json, tsconfig.json или jsconfig.json, import map и найденные по ним файлы. Корневой index.html целиком — если он до 8 КиБ или задача про страницу.
  --template <файл>      текст задачи из файла. {{message}} заменяется целью. Можно несколько
  --fidelity <0..100>    цель соответствия референсам (по умолчанию 87). Процент не измеряется
  --speed <0..200>       скорость работы (по умолчанию 10). Сумма со --quality до 100 стабильна. Выше 100 скорость срывает гарантии
  --quality <0..200>     качество работы (по умолчанию 40). Выше 200 и сумма больше 200 — отказ
  --pace auto|a|b|c      кто выключает стадии (по умолчанию auto)
  --max-steps <n>        потолок шагов плана. Закрепляет число и заменяет расчёт pace
  --creativity <0..100>  сколько можно добавить сверх референсов (по умолчанию 20)
  --platform <id>        профиль платформы (по умолчанию chrome-157-beta)
  --example <путь|url>   пример или шаблон оформления, можно несколько
  --kind landing|site|backend|app  вид генерации. У memory --kind по-прежнему вид записи
  --no-memory            не использовать долговременную память (SQLite в ~/.ai-agent/memory.db)
  --global               memory: работать с глобальными записями   --tags a,b

Фон:
  --background, -b       фоновый режим Responses API (сервер считает, можно переподключиться: ai resume <resp_id>)
  --detach, -d           запустить как локальную фоновую задачу (ai jobs …)
  --follow               jobs log: следить за журналом
  --serve [ws://127.0.0.1:порт]  публиковать события этого запуска в ai serve. Без адреса берётся ~/.ai-agent/serve.json
  --port <n>             порт ai serve, ai complete --listen и ai channels --listen. 0 — свободный порт

Изображения (image / --images):
  --size WxH|auto  --quality low|medium|high|xhigh|max|auto  --format png|webp|jpeg
  Целое --quality задаёт качество работы, слово low|medium|high|xhigh|max|auto — качество картинки.
  --image-background transparent|opaque|auto  --partials 0..3  --image-model <id>  --count, -n <n>
  Для api.proxyapi.ru картинки идут через /images/generations и /images/edits (openai/gpt-image-2.5-sunburst для генерации по тексту,
  openai/gpt-image-2.5-sunburst для правки и генерации по картинке, если не задана --image-model).
  transparent: gpt-image-* (кроме gpt-image-2) получают нативную альфу; у recraft и подобных моделей
  модель рисует чёрно-белую маску, и ImageMagick вливает её в RGB+A (заливка от углов — запасной путь).
  GPT Image 2.5 дополняет входной растр прозрачными пикселями справа/снизу до кратности 16 без масштабирования и снимает padding после правки.
  PNG с настоящей альфой сохраняется; если нужен WebP, используйте локальную конверсию, а не повторную генерацию.
  Инструмент vectorize_image конвертирует плоские PNG/WebP (логотипы, бейджи, иконки) в SVG через
  recraft/recraft-v4.1-pro-vector: удаляет фон, проверяет палитру, сохраняет .svg вместо .png.

Дополнение кода (complete):
  JSON: content и/или prefix+suffix, cursor или selection (line/character с нуля, как в LSP), либо символ | в тексте.
  --file, --line, --character, --language   файл и курсор, если JSON не передан
  --listen    сервер только на 127.0.0.1. Токен: --token или AI_COMPLETE_TOKEN (Bearer или ?token=)
  Строка длиннее 0.5 МиБ в модель не попадает; берутся ближайшие обычные строки. Контекст файла сокращается.
  Самый быстрый канал под модель: основной baseURL и fallback.providers (свои apiKey/env). Каналы
  опрашиваются параллельно, выбор запоминается на completion.probeTtlMs (60 000 мс); channelProbe false
  отключает поиск, probeTimeoutMs (1500 мс) ограничивает пробу.
  Структура: POST /v1/structure и кадр WebSocket {"type":"structure",...}. tasks: sort-imports, sort-rules,
  sort-properties, group-properties, group-selectors, layers, clean, dedupe, merge, sort-lines.
  rules — порядок импортов, группы свойств, слои. prompt — своя задача. selection правит только диапазон.

Референсы run/gen: --image, --file, --example. Контракт .ai/generation.json пишется, когда задан вид или флаг точности, креативности, платформы или примера. measured остаётся null.

MCP:
  ai mcp add <id> --mcp-command <команда> [--mcp-arg <аргумент> ...]
  ai mcp add <id> --mcp-url <https://…> [--mcp-description <текст>] [--mcp-approval never|always]
  ai mcp remove <id>     ai mcp probe <id>
  Локальный сервер — stdio. Сторонний https-адрес уходит в API как type mcp, процесс не запускается.
  add/remove правят ~/.ai-agent/config.json. Вызовы локальных инструментов MCP подтверждаются как сеть.

Чаты и решения:
  ai decide и POST /v1/decisions — модель openai/gpt-6-luna-decisions (или decisions.model). Если маршрута нет, шаг решений пропускается.
  Запасные модели: gpt-6-luna → anthropic/claude-haiku-5-5, gpt-6.1-sol → anthropic/claude-opus-5.5, решения → typesafe/jev-1.14.
  Если провайдер недоступен и задан SPRUTDOCK_API_KEY или AI_FALLBACK_API_KEY, запрос уходит на https://sprutdock.ru/v1 или AI_FALLBACK_BASE_URL.
  ai moderate в режиме auto сначала вызывает /moderations (omni-moderation-latest). Если шлюз отвечает 404, 405 или 501,
  тот же текст уходит в decisions. Пороги decisions.reviewAt (0.5) и blockAt (0.9) дают allow, review или hide.
  Наборы вопросов: community (группы и каналы), support (клиенты), smm (публикация), guard (подмена инструкций), route (encode или plan).
  ai channels --listen слушает 127.0.0.1. WebSocket: кадр {"type":"moderate"|"decide"|"reply"|"telegram", ...}.
  Токен: --token или AI_CHANNELS_TOKEN. Адрес 0.0.0.0 без токена не поднимается.
  ai telegram poll не требует публичного URL. Удаление — только действие hide в группе, супергруппе или канале.
  Личные сообщения и сообщения о вреде себе не удаляются. Ответ клиенту включается telegram.reply.
  Инструменты decide, moderate_text, channel_reply, telegram_call включаются tools.channels или --tools channels.

Прочее:
  --json                 события и результат в формате JSON Lines     --quiet, -q   только ответ
  --verbose, -v          подробный журнал     --timeout <сек>   таймаут простоя соединения
  --config <файл>        дополнительный файл конфигурации     --base-url <url>
  --help, -h  --version, -V

Переменные окружения: OPENAI_API_KEY (обязательно), OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID,
AI_MODEL (или OPENAI_MODEL), AI_IMAGE_MODEL, AI_DECISION_MODEL, TELEGRAM_BOT_TOKEN, AI_CHANNELS_TOKEN,
AI_AGENT_HOME (по умолчанию ~/.ai-agent), AI_ASCII=1 (без Unicode-символов).
Файл .env в рабочем каталоге задаёт те же имена и перекрывает унаследованное окружение.
На Windows ключ и адрес из разных областей (пользователь и система) не смешиваются: берётся пара из той области, где заданы оба.
Коды выхода: 0 — успех, 1 — задача не завершена/ошибка API, 2 — ошибка аргументов/конфигурации, 130 — отменено.
`;

