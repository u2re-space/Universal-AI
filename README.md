# Universal-AI

Консольная программа для Node.js 26: промптинг, генерация кода, документов и текстов,
генерация картинок, автономное решение задач в рабочем каталоге (в том числе в фоне),
с живым отображением действий ИИ, статуса, использованных токенов и стоимости.
Понимает изображения и файлы во входе.

Только Responses API, только встроенные модули Node (без SDK и без зависимостей).

## Возможности

| Что | Как |
| --- | --- |
| Один запрос → ответ | `ai "объясни event loop в Node"` |
| Чат с историей | `ai chat --session work` (сессии сохраняются между запусками) |
| Код, документы, тексты | `ai "напиши README для проекта" --out README.md`, структурированный вывод `--schema` |
| Картинки | `ai image "кот-космонавт" --size 1024x1024 --quality high` (инструмент `image_generation`, черновики пишутся по мере генерации) |
| Изображения и файлы во входе | `ai --image screenshot.png "что не так на экране?"`, `ai -f spec.pdf "сделай план"` |
| Автономные задачи | `ai run "добавь тесты для src/utils.js и прогони их"` — инструменты: файлы, команды, URL, web-поиск, картинки |
| Разные модели под роли | старшая модель планирует и проверяет, младшие собирают контекст и генерируют вызовы инструментов, отдельная модель читает картинки: `--role planner=gpt-6.1-sol:high --role worker=gpt-6-luna --role vision=gpt-6-luna` |
| Память и общий контекст | долговременная память в SQLite (факты, соглашения, решения — по проекту и глобально), заметки проекта `AGENTS.md`, история задач, кеш сводок файлов; один общий контекст для всех ролей |
| Фон | `--background` (сервер считает, можно переподключиться `ai resume`) и `--detach` (локальная фоновая задача, `ai jobs …`) |
| Что происходит | строка статуса: роль и модель, фаза («думает», «выполняется read_file», «генерирует изображение»), время, токены ↑↓, стоимость; краткие рассуждения модели; журнал этапов, шагов и действий; итоговая сводка с расходом по ролям и моделям |

## Установка

```bash
# Node.js ≥ 26, внешних зависимостей нет
npm link               # делает команду `ai` доступной глобально (или запускайте `node bin/ai.js`)
export OPENAI_API_KEY=sk-...   # PowerShell: $env:OPENAI_API_KEY = "sk-..."
ai config init         # создаст ~/.ai-agent/config.json
```

Модель по умолчанию — `gpt-6.1-sol`; меняется флагом `--model`, переменной `AI_MODEL` или в конфигурации.
`ai models` покажет доступные ключу модели.

## Команды

```
ai [ask] "запрос"            один запрос → ответ
ai chat                      интерактивный чат (/help — команды чата)
ai run "задача"              автономный агент в текущем каталоге
ai image "описание"          генерация изображения
ai resume <resp_id>          подключиться к фоновому ответу API
ai cancel <resp_id>          отменить фоновый ответ API
ai jobs list|status|log|result|wait|cancel|rm [id]    локальные фоновые задачи
ai memory list|search|add|forget|clear|tasks|stats|path   долговременная память
ai models [фильтр]           список моделей
ai config show|init|path     конфигурация
ai map [path]                индекс файлов и символов (.ai/map.json)
```

Полный список флагов — `ai --help`.

### Карта проекта

`ai map` строит `.ai/map.json`: пути, время изменения и символы. Повторный поиск читает эту карту из памяти процесса. `ai map path` печатает путь и число файлов и символов.

`search_files` принимает `scope`: `path`, `symbol`, `content` или `all`.

В `ai run` правила намечают файлы как `read`, `edit` или `scan`. Planner подтверждает список. Запись в файл вне `edit` выполняется, а ответ инструмента начинается с пометки, что пути не было в карте правок.

### Примеры

```bash
# текст из stdin как контекст
git diff | ai "напиши сообщение коммита"

# документ в файл, с заданным уровнем рассуждений
ai --effort high "спроектируй REST API для заметок, формат Markdown" --out docs/api.md

# структурированный ответ по JSON-схеме (strict)
ai --schema schema.json "извлеки данные из текста: ..." --quiet > data.json

# картинка во входе + поиск в интернете
ai --image chart.png --web "что это за график и актуальны ли данные?"

# правка картинки (image-to-image)
ai image --image logo.png "сделай фон прозрачным" --image-background transparent --out logo2.png

# команда агентов с подтверждением каждой записи/команды (по умолчанию в терминале)
ai run "исправь падающий тест в test/"

# свои модели под роли: старшая планирует и ревьюит, младшая делает, самая дешёвая пишет сводки и память
ai run --role planner=gpt-6.1-sol:high --role reviewer=gpt-6.1-sol --role worker=gpt-6-luna \
       --role collector=gpt-6-luna --role summarizer=gpt-6-luna "добавь кеширование в src/api.js"

# один агент вместо команды (как раньше), без долговременной памяти
ai run --single --no-memory "переименуй getCwd в getCurrentWorkingDirectory"

# агент без вопросов, только файлы (команды и сеть запрещены)
ai run --approve write "переведи комментарии в src/ на английский"

# память: посмотреть, что агент запомнил о проекте, добавить своё, история задач
ai memory list
ai memory add "Деплой только через make release, не руками" --kind convention --tags deploy
ai memory tasks

# полностью автономно, в фоне, с лимитами
ai run --detach --approve all --max-turns 40 --budget-usd 2 "добавь линтер и исправь замечания"
ai jobs list
ai jobs log <id> --follow
ai jobs result <id>

# фоновый режим API для долгих одиночных ответов
ai --background "подробный отчёт на 20 страниц о ..."     # Ctrl-C не прервёт работу сервера
ai resume resp_...                                          # вернуться к ответу

# машинно-читаемый вывод
ai --json "список 5 идей" | jq -r 'select(.type=="result").text'
```

### Чат

Команды внутри `ai chat`: `/image <путь>`, `/file <путь>`, `/model`, `/effort`, `/tools fs,shell,fetch`,
`/approve`, `/web on`, `/images on`, `/system <текст>`, `/usage`, `/tokens` (подсчёт входных токенов через API),
`/compact` (серверная компактизация контекста), `/history`, `/save`, `/clear`, `/exit`.
Многострочный ввод: строка с `\` на конце или блок `""" … """`. Ctrl-C во время ответа прерывает только ответ.

## Роли, команда агентов и общий контекст

`ai run` по умолчанию работает **командой ролей**, у каждой роли своя модель и уровень рассуждений
(`roles.*` в конфигурации или `--role роль=модель[:effort]`):

| Роль | Задача | Инструменты | По умолчанию |
| --- | --- | --- | --- |
| `planner` | понять задачу, составить план (JSON: шаги, файлы, вопросы, критерии приёмки, нужно ли ревью), посмотреть приложенные картинки | — | старшая модель, effort `high` |
| `collector` | собрать контекст из файлов для остальных: ответить на вопросы планировщика, выписать нужные фрагменты и соглашения | только чтение: `list_files`, `search_files`, `read_file`, `summarize_file`, `recall` | младшая модель, effort `low` |
| `worker` | выполнять шаги плана по одному: генерировать вызовы инструментов (JSON для локального исполнителя), проверять, отчитываться | все (по политике `--approve`) | младшая/средняя модель |
| `reviewer` | независимо проверить результат по diff и критериям приёмки; `accept` или `revise` с конкретными замечаниями → worker исправляет (до `agent.maxReviewRounds` раундов) | чтение + `run_command` | старшая модель |
| `vision` | описывать изображения для других ролей (`view_image` делегирует ей, когда у неё своя модель — `agent.visionDelegate`) | — | — |
| `summarizer` | сводки больших файлов (`summarize_file`, кешируются по хешу), извлечение фактов в память после задачи | — | самая дешёвая модель, без рассуждений |
| `default` | `ask`, `chat`, `run --single` | — | общая `model` |

Поток: память + заметки проекта → **план** → (если задача не тривиальная) **сбор контекста** → **выполнение**
по шагам → **ревью** и правки → **память**. Все роли читают один **общий контекст** (задача, окружение,
заметки `AGENTS.md`, релевантные записи памяти, план, находки коллектора, отчёты по шагам, diff изменений);
при переполнении бюджета `agent.maxContextBytes` менее важные разделы обрезаются. Планировщик помечает
простые задачи как `trivial` — тогда сбор контекста и ревью пропускаются. `--single` возвращает одиночный цикл.

## Память

* **База** — `~/.ai-agent/memory.db` (SQLite, `node:sqlite`, полнотекстовый поиск FTS5): записи видов
  `fact | convention | decision | preference | pitfall | note`, с областью `project` (привязка к рабочему
  каталогу) или `global`; кеш сводок файлов; история задач (`ai memory tasks`).
* **Файлы** — заметки проекта `AGENTS.md` (`memory.notesFile`) попадают в общий контекст; резервные копии
  изменённых файлов — `~/.ai-agent/backups/`.
* **Как наполняется** — после задачи роль `summarizer` извлекает 0–6 устойчивых фактов (`memory.autoSave`);
  агент может сам вызывать `remember`/`recall`; пользователь — `ai memory add/forget/clear`.
* **Как используется** — перед планированием ищутся релевантные записи (`memory.maxRecall`), в чате и `ask`
  с `--tools` доступны инструменты `recall`/`remember`. `--no-memory` отключает всё это.

## Что показывается во время работы

В терминале (stderr) идёт строка статуса, обновляемая несколько раз в секунду:

```
⠹ [worker · gpt-6-luna] выполняется read_file… · 12.3 s · ↑ 14,210 ↓ 1,082 +~120 · $0.031 · ход 3/25
```

роль и модель · фаза · время · токены (вход/выход по завершённым запросам, `+~N` — оценка текущего ответа) · стоимость · ход агента.
В журнале видны этапы (`этап «план» — planner · gpt-6.1-sol`), план, шаги, вердикт ревью, найденные и сохранённые записи памяти;
итоговая сводка показывает расход токенов по ролям и по моделям.
Выше — журнал: `∙` краткие рассуждения модели (`--no-reasoning` скрывает), `▸`/`✓`/`✗` вызовы инструментов,
`▣` сохранённые изображения, `≡` usage каждого ответа. Ответ модели идёт в stdout, поэтому его можно
перенаправлять в файл или канал. Без терминала (пайп, CI, фоновые задачи) — те же строки без курсорных
управляющих кодов; `--json` — поток событий JSON Lines; `--quiet` — только ответ.

Стоимость считается по ценам из конфигурации (`prices`, USD за 1M токенов; поддерживаются шаблоны вида
`"gpt-6.1-sol*"`). Встроенных таблиц цен нет — они устаревают. Токены показываются всегда; плата за
встроенные инструменты (генерация картинок, web-поиск) в сумму не входит.

## Конфигурация

`~/.ai-agent/config.json` (каталог меняется `AI_AGENT_HOME`), затем `--config файл`, затем переменные
окружения, затем флаги. Все поля и значения по умолчанию — в `src/core/config.js`; ключевые:

```json
{
  "model": "gpt-6.1-sol",
  "imageModel": null,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "store": false,
  "approve": "ask",
  "shell": null,
  "tools": { "fs": true, "shell": true, "fetch": true, "web": false, "images": false, "askUser": true },
  "limits": { "maxTurns": 60, "budgetUsd": null, "budgetTokens": null, "commandTimeoutMs": 180000 },
  "roles": {
    "planner":    { "model": "gpt-6.1-sol", "effort": "high" },
    "reviewer":   { "model": "gpt-6.1-sol", "effort": "medium" },
    "collector":  { "model": "gpt-6-luna", "effort": "low" },
    "worker":     { "model": "gpt-6-luna", "effort": "medium" },
    "vision":     { "model": "gpt-6-luna" },
    "summarizer": { "model": "gpt-6-luna", "summary": "none" }
  },
  "agent": { "mode": "team", "maxSteps": 12, "maxReviewRounds": 2, "workerMaxTurnsPerStep": 25, "maxContextBytes": 98304, "visionDelegate": "auto" },
  "memory": { "enabled": true, "autoSave": true, "maxRecall": 8, "notesFile": "AGENTS.md", "dbFile": null },
  "image": { "size": "auto", "quality": "auto", "format": "png", "partialImages": 2, "outputDir": "." },
  "compaction": { "auto": false, "afterInputTokens": 200000 },
  "prices": { "gpt-6.1-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 }, "gpt-6-luna*": { "input": 0.25, "output": 2 } },
  "instructions": "Отвечай кратко."
}
```

Поля роли: `model`, `effort`, `summary`, `verbosity`, `maxOutputTokens`, `temperature`, `instructions`
(дополнительные инструкции только для этой роли); `null` — наследовать от `roles.default`, затем от общих настроек.
Цены в примере условные — проверьте актуальные.

Переменные окружения: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`,
`AI_MODEL`, `AI_IMAGE_MODEL`, `AI_AGENT_HOME`, `AI_ASCII=1` (без Unicode-символов в журнале).

### Состояние разговора

По умолчанию `store: false`: история хранится локально (в сессии), а рассуждения моделей передаются
обратно в зашифрованном виде (`include: ["reasoning.encrypted_content"]`) — ничего не остаётся на
сервере. `--store` переключает на серверное состояние через `previous_response_id`.
Фоновый режим API (`--background`) требует `store: true` и включает его сам.

## Инструменты агента и безопасность

Локальные инструменты (строгие function tools): `list_files`, `read_file`, `search_files`, `write_file`,
`replace_text`, `delete_file`, `make_dir`, `view_image`, `summarize_file`, `run_command`, `fetch_url`,
`recall`, `remember`, `ask_user`; встроенные инструменты API: `web_search` (`--web`), `image_generation` (`--images`).

Политика подтверждений `--approve`:

| Уровень | Чтение, память | Запись файлов | Команды, сеть |
| --- | --- | --- | --- |
| `ask` (терминал по умолчанию) | да | спросить (`y`/`n`/`a` — всегда для инструмента/`q`) | спросить |
| `read` (без терминала по умолчанию) | да | нет | нет |
| `write` | да | да | нет |
| `all` / `--yes` | да | да | да |

Коллектор всегда работает в режиме только чтения; ревьюер — чтение плюс `run_command` по той же политике.

Инструменты работают только внутри `--cwd` (по умолчанию текущий каталог): выход за его пределы,
в том числе через символические ссылки, запрещён; `.env*`, ключи и сертификаты, `.ssh`, `.aws` и т. п.
недоступны; запись в `.git` и `node_modules` запрещена. Перед перезаписью и удалением файл копируется в
`~/.ai-agent/backups/<дата>/`. Команды выполняются через cmd.exe (Windows) или /bin/sh с таймаутом и
ограничением вывода, дерево процессов завершается принудительно; из окружения вырезаются переменные,
похожие на секреты (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`). Весь текст модели перед выводом
очищается от управляющих последовательностей терминала.

Содержимое файлов, страниц и вывод команд — ненадёжные данные (prompt injection): для автономных
запусков с `--approve all` задавайте лимиты `--max-turns`, `--budget-usd`/`--budget-tokens`.

## Фоновая работа

* `--background` — фоновый режим Responses API: сервер продолжает генерацию даже если клиент отключился.
  Клиент держит поток и при обрыве переподключается (`GET /responses/{id}?stream=true&starting_after=N`);
  `--no-stream --background` опрашивает статус (`queued` → `in_progress` → `completed`).
  `ai resume resp_…` / `ai cancel resp_…` работают с такими ответами.
* `--detach` — локальная фоновая задача: отдельный процесс CLI (`--json`), события и статус пишутся в
  `~/.ai-agent/jobs/<id>/` (`events.jsonl`, `status.json` с фазой/токенами/стоимостью, `result.json`).
  `ai jobs list` показывает статус и токены всех задач, `ai jobs log <id> --follow` — живой журнал,
  `ai jobs cancel <id>` останавливает процесс. Для фоновых агентов нужен явный `--approve write|all`.

## Архитектура

```
bin/ai.js                 точка входа
src/cli.js                разбор аргументов, команды, сигналы, коды выхода
src/openai/http.js        транспорт на node:https (явный таймаут простоя, без скрытых лимитов undici)
src/openai/sse.js         ограниченный по размеру парсер Server-Sent Events
src/openai/stream.js      события Responses API → события приложения, финальный объект ответа
src/openai/client.js      /responses (create, retrieve+resume, cancel, compact, input_tokens), /models, повторы
src/core/config.js        конфигурация, роли (resolveRole) и валидация
src/core/session.js       история разговора (stateless / previous_response_id), сохранение сессий
src/core/usage.js         учёт токенов и стоимости (всего, по ролям, по моделям), бюджеты
src/core/memory.js        долговременная память: SQLite + FTS5, сводки файлов, история задач
src/core/context.js       общий контекст ролей с приоритетами разделов и обрезкой по размеру
src/core/attachments.js   изображения и файлы → input_image / input_file / input_text
src/core/background.js    опрос и переподключение к фоновым ответам
src/core/images.js        сохранение итоговых и промежуточных изображений
src/agent/tools.js        описания инструментов, политика подтверждений, исполнение (вкл. память, vision, сводки)
src/agent/fs-tools.js     операции с файлами (лимиты, резервные копии)
src/agent/shell.js        запуск команд с таймаутом и завершением дерева процессов
src/agent/paths.js        ограничение путей рабочим каталогом, защищённые имена
src/agent/loop.js         цикл «модель ⇄ инструменты», сборка тела запроса, компактизация
src/agent/roles.js        запуск запросов от имени роли (модель/effort роли, строгий JSON, vision, сводки файлов)
src/agent/team.js         оркестратор команды: план → сбор контекста → шаги → ревью/правки → память
src/agent/schemas.js      JSON-схемы структурированных ответов ролей
src/agent/diff.js         diff изменений для ревьюера
src/ui/renderer.js        строка статуса, журнал, вопросы пользователю; режимы tty/plain/json/quiet
src/jobs/manager.js       локальные фоновые задачи
src/commands/*.js         ask, chat, run, image, jobs, memory, resume/cancel/models/config
```

Программный интерфейс (`index.js`): `createClient`, `createSession`, `createLedger`, `createToolset`,
`runTurn`, `createRoleRunner`, `runTeam`, `openMemory`, `createSharedContext`, `resolveRole`,
`buildUserMessage`, `createRenderer`, `createJobManager`.

## Тесты

```bash
npm test
```

Тесты (node:test) используют локальный мок Responses API (`test/helpers/mock-server.js`) и покрывают
SSE-парсер, клиент (повторы, ошибки, обрыв и возобновление потока, фон), цикл агента (инструменты,
политика, лимиты, картинки, бюджеты), команду ролей (план → сбор → шаги → ревью → память, разные модели
по ролям, делегирование vision, кеш сводок), память (SQLite/FTS5), общий контекст, сессии, вложения, пути,
запуск команд и CLI целиком (включая `--detach`, `jobs`, `memory`). Сетевые вызовы к OpenAI в тестах не выполняются.

## Ограничения

* Hosted-агенты OpenAI (бета `/agents`, `/agents/sessions`) не используются — всё построено на
  Responses API; `src/openai/client.js` и `runTurn` — точка расширения.
* Цены моделей не встроены: без `prices` в конфигурации показываются только токены.
* Прокси для соединения с API не поддерживается транспортом (`OPENAI_BASE_URL` позволяет указать шлюз).
