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
| Векторизация логотипов и бейджей | `ai run "конвертируй логотипы PNG/WebP в SVG"` — инструмент `vectorize_image` (`recraft/recraft-v4.1-pro-vector`) с локальным удалением фона; источник — кроп из `.tmp/<id>/crops/` |
| Изображения и файлы во входе | `ai --image screenshot.png "что не так на экране?"`, `ai -f spec.pdf "сделай план"` |
| Автономные задачи | `ai run "добавь тесты для src/utils.js и прогони их"` — инструменты: файлы, команды, URL, web-поиск, картинки |
| Сайты, лендинги, бэкенды | `ai gen landing "собери страницу" --image test-gen/landing.png` — точность 87% (цель, не измерение), креативность, профиль Chrome 157 Beta |
| Свои MCP-серверы | `ai mcp add design --mcp-command node --mcp-arg server.js` — инструменты и ресурсы по stdio |
| Решения и модерация | `ai decide`, `ai moderate` — `/v1/decisions` (`openai/gpt-6-luna-decisions`) или `omni-moderation-latest`, если шлюз отдаёт `/v1/moderations` |
| Чаты и Telegram | `ai channels --listen`, `ai telegram poll` — группы, каналы, личные чаты, черновик ответа или пост |
| Разные модели под роли | старшая модель планирует и проверяет, младшие собирают контекст и генерируют вызовы инструментов, отдельная модель читает картинки: `--role planner=gpt-6.1-sol:high --role worker=gpt-6-luna --role vision=gpt-6-luna` |
| Память и общий контекст | долговременная память в SQLite (факты, соглашения, решения — по проекту и глобально), заметки проекта `AGENTS.md`, история задач, кеш сводок файлов; один общий контекст для всех ролей |
| Фон | `--background` (сервер считает, можно переподключиться `ai resume`) и `--detach` (локальная фоновая задача, `ai jobs …`) |
| Что происходит | строка статуса: роль и модель, фаза («думает», «выполняется read_file», «генерирует изображение»), время, токены ↑↓, стоимость; краткие рассуждения модели; журнал этапов, шагов и действий; итоговая сводка с расходом по ролям и моделям |

## Установка

```bash
# Node.js ≥ 26, внешних зависимостей нет
npm install -g .       # из клона: команда `ai` в PATH
# npm install -g @u2ai/universal-ai   # то же после публикации пакета
# либо из любого каталога: bin/ai.cmd, bin/ai.sh, bin/ai.ps1, или node <путь>/bin/ai.js
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
ai complete                  вставка в месте курсора (редактор, быстрая модель)
ai complete --listen [--port n]   HTTP и WebSocket для IDE на 127.0.0.1
ai gen <landing|site|backend|app> "задача"   сгенерировать проект по референсам
ai mcp list|add|remove|probe    пользовательские MCP-серверы (stdio)
ai decide [набор] "текст"        вероятности модели решений
ai moderate [набор] "текст"      модерация сообщения
ai channels --listen [--port n]  HTTP и WebSocket для чатов и решений
ai telegram poll|send            адаптер Telegram Bot API
ai serve [--port <n>]        локальная шина WebSocket на 127.0.0.1
```

Полный список флагов — `ai --help`.

### Локальная шина

`ai serve` слушает `ws://127.0.0.1:<порт>` и на том же порту отдаёт дополнение редактора: `POST /v1/complete`, `POST /v1/structure` и WebSocket `/v1/complete`. Адрес шины, адреса дополнения и токен пишутся в `~/.ai-agent/serve.json` (права `0600`). Токен в журнал не попадает. Его же принимает дополнение (`Authorization: Bearer` или `?token=`). Подходит и `AI_COMPLETE_TOKEN`, `--token` или `completion.token`. `--port` задаёт порт; без него берётся свободный.

Дополнительные аргументы запуска — обычные флаги CLI (`--model`, `--approve`, `--web`). Они становятся конфигурацией сервера и дополнения. Поля одного запуска передаются в кадре `start`: `prompt`, `cwd`, `approve`, `tools`, `files`, `images`, `role`, `single`, `team` и остальные флаги команды.

```bash
ai serve --port 8765
# WS   ws://127.0.0.1:8765            шина ask/run/chat/image
# POST http://127.0.0.1:8765/v1/complete
# POST http://127.0.0.1:8765/v1/structure
# WS   ws://127.0.0.1:8765/v1/complete
ai run "добавь тест" --serve
ai run "добавь тест" --serve ws://127.0.0.1:8765
```

Клиент WebSocket после `hello` с токеном может отправить `start` (`ask`, `run`, `chat`, `image`) и подписаться на любой запуск. Подтверждения записи и команд для клиентского запуска приходят кадром `approval.request` тому сокету, который отправил `start`. Наблюдатели получают события и не могут подтверждать действия.

Сокет может забрать исполнение части инструментов клиентского запуска. В `start` поле `processing` — массив имён, которые сразу берёт владелец: `list_files`, `read_file`, `search_files`, `write_file`, `replace_text`, `delete_file`, `run_command`, `run_script`. Другой сокет после `hello` шлёт `processing.claim` с `runId` и `tools`. Одно имя держит один сокет. Повторный claim этого сокета заменяет его список, а занятое имя переходит к новому сокету. Прежнему уходит `processing.released`. Подписчики видят снимок `processing.held`.

После подтверждения держателю уходит `tool.request` (`runId`, `requestId`, `name`, `args`). Ответ — `tool.result` с `output`, `summary` и необязательным `changes` (`op`: `create`, `overwrite`, `edit`, `delete`, и `path`). Поле `error` завершает вызов ошибкой инструмента. Пустой список и неназванное имя выполняет Node. Захват на запуск из терминала (`--serve`) отклоняется.

`ai jobs` и `--detach` не меняются.

### Карта проекта

`ai map` строит `.ai/map.json`: пути, время изменения и символы. Повторный поиск читает эту карту из памяти процесса. `ai map path` печатает путь и число файлов и символов.

`search_files` принимает `scope`: `path`, `symbol`, `content` или `all`. `scope=symbol` смотрит имя, `@purpose`, `@ai.hint` и `@ai.tags`.

Исходники в `src/` с отступом в 4 пробела. Карточка модуля (`@file`, `@purpose`, `@exports`, `@depends`, `@usedBy`) и типы функций (`@param`, `@returns`) описаны в `docs/jsdoc/TAGS.md`. Сборка карты кладёт их в `.ai/map.json`: у файла поле `doc`, у символа `purpose`, `params`, `returns`, `hint`, `tags`.

В `ai run` правила намечают файлы как `read`, `edit` или `scan`. Planner подтверждает список. Запись в файл вне `edit` выполняется, а ответ инструмента начинается с пометки, что пути не было в карте правок.

### Дополнение для редактора

`ai complete` возвращает текст, который нужно вставить в месте курсора. Модель по умолчанию — `gpt-6-luna`, уровень рассуждений — `none`. Один запрос — JSON в stdin. Для IDE тот же JSON принимается по HTTP и WebSocket:

```bash
ai complete --json
# stdin: {"path":"src/app.js","language":"javascript","content":"function total(items) {\n  return |\n}\n","cursor":{"line":1,"character":9}}

ai complete --listen --port 8765
# только дополнение, без шины

ai serve --port 8765
# тот же POST /v1/complete, /v1/structure и WebSocket, плюс шина на этом порту
# POST http://127.0.0.1:8765/v1/complete
# WS   ws://127.0.0.1:8765/v1/complete
```

Курсор задаётся полем `cursor` или диапазоном `selection` (номера строк и `character` с нуля, как в LSP). Если координат нет, курсор — первый символ `|` в `content`, либо граница `prefix` и `suffix`. Файл можно не присылать целиком: достаточно `path` внутри рабочего каталога, контекст будет сокращён. Строка длиннее 0.5 МиБ (часто это base64) в модель не отправляется — рядом с курсором остаются ближайшие обычные строки.

Сервер слушает только `127.0.0.1`. Секрет `--token` или `AI_COMPLETE_TOKEN` (либо `completion.token` в конфигурации) передаётся заголовком `Authorization: Bearer` или параметром `?token=`. У `ai serve` тот же заголовок принимает токен из `serve.json`.

Для каждой модели дополнение ищет самый быстрый канал. Каналы — основной `baseURL` с `OPENAI_API_KEY` и `fallback.providers` (у каждого свой `apiKey` или `env`). При первом запросе и после `completion.probeTtlMs` (60 с) каналы параллельно получают короткий пробный запрос; побеждает первый ответивший, остальные остаются запасными в порядке задержки. Если канал не обслуживает модель или отвечает ошибкой, запрос уходит следующему. Выбор запоминается отдельно для каждой модели. `completion.channelProbe: false` отключает поиск (порядок: основной, затем запасные), `completion.probeTimeoutMs` (1500 мс) ограничивает пробу.

Тот же сервер принимает правку структуры: `POST /v1/structure` и кадр WebSocket `{"type":"structure"}`. В `tasks` — `sort-imports`, `dedupe`, `merge`, `group-properties`, `group-selectors`, `sort-rules`, `sort-properties`, `layers`, `clean`, `sort-lines`. В `rules` — свой порядок импортов, группы свойств и слои. `prompt` описывает задачу, которую встроенные шаги не покрывают. `selection` ограничивает правку открытым диапазоном; без `write` сервер только возвращает текст. Агент делает то же самое инструментом `structure_file`.

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
# прозрачность: gpt-image-* (кроме gpt-image-2) получают background=transparent и output_format=png нативно;
# у recraft и подобных моделей модель рисует чёрно-белую маску (белое — объект, чёрное — фон),
# а ImageMagick вливает её в RGB+A: -colorspace Gray -compose CopyOpacity -composite.
# если маска не удалась, остаётся запасной путь — заливка от углов по цвету фона.
# по умолчанию для растра берутся openai/gpt-image-2.5-sunburst (генерация) и openai/gpt-image-2.5-sunburst
# (правка): они держат палитру источника, тогда как recraft v4.1 сдвигает нейтральные цвета в сине-фиолетовый.
# Для GPT Image 2.5 входные изображения дополняются прозрачными пикселями справа и снизу до кратности 16 без масштабирования; после правки padding снимается локально.
# Готовый PNG с настоящим alpha сохраняется; при необходимости WebP делается локальной конверсией, повторная генерация не нужна.

# команда агентов с подтверждением каждой записи/команды (по умолчанию в терминале)
ai run "исправь падающий тест в test/"

# свои модели под роли: старшая планирует и ревьюит, младшая делает, самая дешёвая пишет сводки и память
ai run --role planner=gpt-6.1-sol:high --role reviewer=gpt-6.1-sol --role worker=gpt-6-luna \
       --role orchestrator=gpt-6.1-sol --role summarizer=gpt-6-luna "добавь кеширование в src/api.js"

# оркестратор после каждого этапа: правки плана и указания следующему шагу
ai run --orchestrator --role orchestrator=gpt-6.1-sol:high "перепиши слой доступа к данным на репозитории"

# рабочий стол Windows: --desktop включает screenshot, click, type, run_ahk, run_batch и delegate_role для worker и reviewer
ai run --desktop --approve ask "посмотри экран и закрой лишний диалог"

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

`agent.encode: mcp` поднимает в `ai run`, `ai gen` и `ai chat` локальный MCP-сервер на `127.0.0.1:3000` и печатает в stderr строки `MCP:` и `Processing:`. Если 3000 занят, процесс останавливается. Пока сервер поднят, этап encoder исполняет его и не вызывает модель пакета файлов. `agent.encode: encoder` (значение по умолчанию) оставляет эту модель. `ai serve` этот порт не занимает: без `--port` он берёт свободный.

`ai run` по умолчанию работает **командой ролей**, у каждой роли своя модель и уровень рассуждений
(`roles.*` в конфигурации или `--role роль=модель[:effort]`):

| Роль | Задача | Инструменты | По умолчанию |
| --- | --- | --- | --- |
| `planner` | понять задачу, составить план (JSON: шаги, файлы, вопросы, критерии приёмки, нужно ли ревью), посмотреть приложенные картинки | — | старшая модель, effort `high` |
| `measurer` | снять метрики с референсов после плана: блоки элементов в пикселях, на какой угол повёрнут каждый, где проходят границы и скругления, как картинка делится на области и слои (с коробками кропа), правила отступов, куда и как ставить каждый элемент | `view_image`, `crop_image`, `split_image` | тривиально (только разделить): `gpt-6-luna` / `low`; стили: `gpt-6.1-sol` / `medium`; стили, SVG и геометрия: `gpt-6.1-sol` / `high` |
| `image-processor` | выполнить отдельные `imageTasks` из плана до реализации: подготовить запрошенные изображения, фрагменты и assets; вернуть пути, форматы и рекомендации worker | только включённые image/assets-инструменты; без shell и редактирования кода | общая модель, effort `medium`; настраивается `--role image-processor=<модель>[:effort]` |
| `orchestrator` | знает проект лучше всех и делает две работы: (1) собрать контекст из файлов для остальных — ответить на вопросы планировщика, выписать нужные фрагменты и соглашения; (2) после этапа (план, сбор контекста, шаг worker, ревью, исправления) посмотреть план, progress, свои находки и свежий diff — вернуть правку плана и указания следующему шагу | только чтение: `list_files`, `search_files`, `read_file`, `summarize_file`, `recall` | старшая модель, effort `high`; координация включается `--orchestrator`, бюджет контекста `agent.orchestrator.maxContextBytes` (4 МиБ ≈ 1M токенов) |
| `worker` | выполнять шаги плана по одному: генерировать вызовы инструментов (JSON для локального исполнителя), проверять, отчитываться | все (по политике `--approve`) | младшая/средняя модель |
| `reviewer` | независимо проверить результат по diff и критериям приёмки; `accept` или `revise` с конкретными замечаниями → worker исправляет (до `agent.maxReviewRounds` раундов) | чтение + `run_command` | старшая модель |
| `vision` | описывать изображения для других ролей (`view_image` делегирует ей, когда у неё своя модель — `agent.visionDelegate`) | — | длинная сторона до 512 px: `gpt-6-luna` / `low`; до 1280 px: `gpt-6-luna` / `medium`; крупнее и любой скриншот экрана: `gpt-6.1-sol` / `high` |
| `summarizer` | сводки больших файлов (`summarize_file`, кешируются по хешу), извлечение фактов в память после задачи | — | самая дешёвая модель, без рассуждений |
| `solver` | решить шаг по экрану или файлу (формула, фрагмент текста, капча) и указать, где элементы | `screenshot`, `view_image` | trivial: `gpt-6-luna` / `low`; normal: `gpt-6-luna` / `medium`; complex: `gpt-6.1-sol` / `high` |
| `clicker` | кликнуть | `click`, `screenshot` | общая `model`, effort `low` |
| `typer` | ввести текст в поле | `type`, `screenshot` | общая `model`, effort `low` |
| `encoder` | вернуть пакет действий | `screenshot` | общая `model`, effort `medium` |
| `extractor` | очистить verbose-ответ и разложить чистые файлы по `.tmp/<id>/extracted/`; один вызов на пачку артефактов | — | дешёвая модель, effort `low` |
| `tester` | проверить результат, в том числе по экрану | `screenshot` | общая `model`, effort `medium` |
| `default` | `ask`, `chat`, `run --single` | — | общая `model` |

Поток: память + заметки проекта → **план** → (если к задаче приложены референсы) **замеры** → (если задача не тривиальная) **сбор контекста** → (если `imageTasks` не пуст) **подготовка изображений** → **выполнение**
по шагам → **ревью** и правки → **память**. Все роли читают один **общий контекст** (задача, окружение,
заметки `AGENTS.md`, релевантные записи памяти, план, находки оркестратора, отчёты по шагам, diff изменений);
при переполнении бюджета `agent.maxContextBytes` менее важные разделы обрезаются. Планировщик помечает
простые задачи как `trivial` — тогда сбор контекста и ревью пропускаются; image processing запускается только если
план содержит конкретные `imageTasks`. Его отчёт и пути assets сохраняются в `.tmp/<id>/image-assets.json`, попадают в общий контекст и повторно используются при resume. `--single` возвращает одиночный цикл.

Крупный шаг, в котором названо несколько файлов, режется на шаг на файл. План и progress пишутся в `.tmp/<id>/plan.json` и `progress.json`, а в общий контекст попадает только краткая сводка. Файл собирается двумя ходами (каркас, затем тела), после файлов идёт шаг согласования импортов и имён. Повтор той же задачи продолжает незавершённый progress; `--no-resume` начинает заново. По ходу worker может дописать план блоком `plan-update`.

Первый ответ сохраняется целиком в `.tmp/<id>/answer.md`, вместе с markdown и описаниями. Для маршрута `encoder` роль `extractor` (по умолчанию `agent.extract: "auto"`) режет ответ на пачки, убирает prose и fences и пишет чистые `js`, `ts`, `html`, `css`, `json` и другие файлы в `.tmp/<id>/extracted/`. Encoder получает ссылки на них и переносит в рабочий каталог через `fs:write`; исходный ответ остаётся в `answer.md`, а его артефакты помечаются `supersededBy`. `--extract always` включает очистку и для маршрута `planner`, `--extract off` или `--no-extract` выключает её. Ошибка extractor не останавливает запуск: остаются исходные артефакты.

### Замеры референсов

Роль `measurer` стоит сразу после планировщика и перед исполнителем: она превращает макет в числа, по которым
потом пишутся стили, SVG и кропы. Ответ — JSON-лист замеров: для каждого элемента коробка в пикселях источника,
угол поворота по часовой стрелке, где проходят границы и с какой толщиной, радиус скругления, внутренние и внешние
отступы и как элемент ставится (грид или флекс, абсолютный якорь, порядок слоёв); отдельно — на какие области и слои
делится картинка, с коробкой кропа для каждой, и отдельно — повторяющиеся правила (шаг сетки, пропорции, ширина колонки).

Роль видит приложенные картинки сама (сильная визон-модель, без пересказа через `vision`) и в процессе может
`crop_image`/`split_image`, чтобы померить мелкую деталь, иконку или наклонный край по уже обрезанному фрагменту.
Поэтому повторные замеры по фрагментам и слоям — это тот же этап: `agent.measurerMaxTurns` (по умолчанию 12) ходов
на такие уточнения, а на исчерпанном лимите интерактивный запуск предложит продлить его ещё на `limits.extendTurns`.
Если продлить нельзя (неинтерактивный режим), роль одним последним запросом без инструментов отдаёт лист по тому,
что уже успела разглядеть; непроверенные значения в нём остаются `null`. При включённом `--desktop` worker может
вызвать её повторно через `delegate_role` с ролью `measurer`.

Модель следует сложности плана: только разделить картинку — `gpt-6-luna` / `low`, собрать стили — `gpt-6.1-sol` / `medium`,
стили с SVG и геометрией — `gpt-6.1-sol` / `high`. Задают своё: `roles.measurer.model`, `roles.measurer.effort` или
`--role measurer=<модель>[:effort]`.

Лист замеров кладётся в общий контекст (раздел «Reference measurements») и в `.tmp/<id>/measurements.json`, поэтому
следующие роли видят его и после возобновления. Готовые кропы областей автоматически складываются в
`.tmp/<id>/crops/` и указываются рядом с областью в листе замеров; worker передаёт такой путь в
`generate_image(reference=...)` (или `extra_images`) и не тратит ход на повторный `crop_image`.
Плоские кропы (логотип, бейдж, иконка — малая палитра, обычно 1:1) worker вместо растра отдаёт в
`vectorize_image`: инструмент снимает фон через ImageMagick, проверяет палитру и пишет SVG в `assets/`,
сохраняя форму источника. Вызов без `image` показывает, какие кропы ещё остались и какие из них
подходят вектору. Роль выключается `--no-measure` (или `agent.measure: "off"`);
`--measure always` заставляет снимать метрики и с тривиальными планами. Ошибка замеров запуск не останавливает:
работник продолжает по плану и референсам.

### Оркестратор

Единая роль `orchestrator` делает две работы: собирает контекст из файлов для остальных и координирует команду
между этапами. Координация включается `--orchestrator` (алиасы `--coordinator` и `--collector` тоже мигрируют в неё;
или `agent.orchestrator.enabled: true`). Она вызывается после выбранных этапов (`agent.orchestrator.after`,
по умолчанию `plan`, `work`, `review`, `fix`; сбор контекста идёт до этапа `work`) и получает не только общий
контекст, но и свежий diff изменений с прошлого этапа. Ответ координации — JSON: оценка состояния, `nextStep` для
следующего хода worker и необязательная правка плана (`addSteps`, `revise`). Правка применяется после этапов
`plan` и `work`; на ревью и исправлениях оркестратор только даёт указания. Его заметки попадают в `progress.json`
и в общий контекст, поэтому следующие роли видят, что уже сделано и что менять дальше.

Бюджет контекста оркестратора — `agent.orchestrator.maxContextBytes` (по умолчанию 4 МиБ, примерно 1M токенов);
он больше общего `agent.maxContextBytes`, поэтому оркестратор видит больше плана, отчётов и diff. Модель роли
задаётся как у остальных: `roles.orchestrator.model` или `--role orchestrator=<модель>[:effort]`. Координация
выключена по умолчанию: каждый её вызов — дополнительный запрос к старшей модели.

### Рабочий стол

`--desktop` включает `screenshot`, `click`, `type`, `run_ahk`, `run_batch` и `delegate_role` для worker и reviewer.
`delegate_role` передаёт один шаг роли `solver`, `clicker`, `typer`, `encoder`, `tester` или `measurer`.
Нужен AutoHotkey v2: установленный `AutoHotkey64.exe`, либо `desktop.ahkPath` указывает на него.
`--approve ask` подтверждает каждое действие рабочего стола. `--approve read` и `--approve write` рабочий стол не разрешают. `--approve all` разрешает.
Снимки попадают в `.ai/desktop/`; роль `vision` описывает их как TOON.
Роль `encoder` записывает пакет. `run_batch` его выполняет.
Клик — по координатам, заголовку окна, элементу управления или картинке.

## Генерация проектов

`ai gen` собирает лендинг, статический сайт, бэкенд или небольшое приложение. Команда пишет контракт в `.ai/generation.json` и запускает ту же команду ролей, что и `ai run`.

```bash
ai gen landing "повтори макет" --image test-gen/landing.png --approve write
ai gen backend "заметки по HTTP" --creativity 10 --approve write
ai gen site "витрина" --example templates/base --example https://css-tricks.com/ --fidelity 87
ai run --template quest.md --file notes.md "допиши шейдер"
```

* **Точность** (`--fidelity`, по умолчанию 87) — насколько видимая структура, текст, палитра и порядок блоков должны совпасть с референсами. Это цель. Поле `measured` остаётся `null`: сравнения кадра и вёрстки нет, процент не вычисляется. При quality 40 заявленные 87 работают как 66.
* **Скорость и качество** (`--speed` 10, `--quality` 40, `--pace auto`) — как дробить шаги и какую ступень модели брать. Лестница по умолчанию: `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`. Модель выбирается для каждого шага по его собственной сложности, поэтому после сложного шага простые шаги снова идут на дешёвую ступень. Если шаг генерации исчерпал ходы уже после записи файлов, один короткий проход проверки выполняется на самой дешёвой ступени. Флаги делят бюджет 200. Сумма до 100 стабильна. `quality` выше 200 и сумма больше 200 отклоняются. Высокая скорость не обещает короткий запуск и не обещает, что планка качества будет взята. `--max-steps` закрепляет потолок шагов.
* **Креативность** (`--creativity`, по умолчанию 20) — сколько можно добавить того, чего в референсах нет. 0 ничего не добавляет. Оси независимы.
* **Референсы** — `--image` (макеты), `--file`, `--example` (примеры и шаблоны оформления). Можно несколько каждого. `--template` — файл с текстом задачи, в том числе вместо фразы в команде.
* **Зависимости** — при `--approve all` (и по подтверждению при `ask`) система выполняет `npm install` сразу после записи каркаса, до первого шага. Тогда `npm run build` работает с Vite. При `write` и `read` команды запрещены: установите зависимости вручную.
* **Платформа** — `--platform chrome-157-beta` (единственный профиль и значение по умолчанию). Chrome 157 Beta без экспериментальных флагов и без origin trial. ECMAScript — редакция 2026, только то, что Chrome 157 выполняет без флага. CSS `random()` и пять флаговых возможностей снимка от 2026-10-15 не используются. Ориентиры: [CSS-Tricks](https://css-tricks.com/), [дорожная карта Chrome](https://chromestatus.com/roadmap), [ECMA-262](https://262.ecma-international.org/), [caniuse](https://caniuse.com/).
* Страницы без npm и без сборщика. Бэкенд и приложение — Node.js 26, ESM, только `node:http`, адрес `127.0.0.1`, порт `PORT` или 3000.

## MCP-источники

Локальный сервер MCP запускается здесь по stdio. Сторонний сервер с адресом `https://` в запрос не порождается: в `tools` уходит `{ "type": "mcp", "server_label", "server_url" }`, и его вызывает сам Responses API.

```bash
ai mcp add design --mcp-command node --mcp-arg servers/design.js
ai mcp add openai_docs --mcp-url https://developers.openai.com/mcp --mcp-description "OpenAI docs"
ai mcp list
ai mcp probe design
ai mcp remove design
```

`add` и `remove` меняют `~/.ai-agent/config.json` и не запускают процесс. `probe`, `ai run` и `ai gen` запускают. Один упавший сервер не останавливает остальные. Имя инструмента для модели: `mcp_<id>_<tool>`. Вызов требует того же подтверждения, что и сеть (`--approve ask` спрашивает, `--approve all` разрешает, `--approve write` не разрешает). Чтение ресурсов (`mcp_list_resources`, `mcp_read_resource`) доступно без подтверждения.

```json
"mcp": {
  "servers": [
    { "id": "design", "command": "node", "args": ["servers/design.js"], "env": { "TOKEN": "…" }, "enabled": true },
    { "id": "openai_docs", "server_url": "https://developers.openai.com/mcp", "server_description": "OpenAI docs", "require_approval": "never" }
  ]
}
```

`tools.mcp` по умолчанию `true`. Пустой список серверов ничего не добавляет. `--no-tools` и `--tools` без `mcp` отключают и локальные источники, и сторонние адреса. `require_approval` по умолчанию `never`: API вызывает сервер сам. Значение `always` записывается, но ход не отвечает на `mcp_approval_request`.

## Чаты, решения и Telegram

Проект остаётся универсальным: решения размечают обращение, модерация решает, пропускать ли его, текстовая модель пишет ответ клиенту или пост. Один и тот же слой доступен агенту, CLI, HTTP и WebSocket.

ProxyAPI принимает `POST /v1/decisions`. Модель по умолчанию — `openai/gpt-6-luna-decisions`. В `state` лежат данные, в `questions` — вопросы типов `noul` (да/нет и вероятность), `choice` и `score`. Ответ — вероятности, не текст. Платится вход.

`ai moderate` в режиме `moderation.mode: auto` сначала вызывает `POST /v1/moderations` с `omni-moderation-latest`. Если шлюз отвечает 404, 405 или 501, то же сообщение уходит в decisions. Режим `decisions` не трогает `/moderations`. Режим `moderations` не делает запасной вызов.

Пороги `decisions.reviewAt` (0.5) и `decisions.blockAt` (0.9):

| Действие | Смысл |
| --- | --- |
| `allow` | можно отвечать |
| `review` | оставить человеку |
| `hide` | убрать из группы, супергруппы или канала |

Наборы вопросов: `community` (группа, супергруппа, канал), `support` (клиент), `smm` (готовность поста), `guard` (подмена инструкций и можно ли показать ответ), `route` (encoder или planner), `quality` (можно ли принять готовый результат). `ai run --route decisions` спрашивает набор `route` после первого ответа. Если вызов не удался, остаётся прежняя эвристика.

Перед ревью команда спрашивает `quality`: решает ли результат задачу, всё ли готово, проверено ли это и совпадает ли картинка с референсом. Уверенное `accept` заменяет ревьюера и его шаги. `decisions.assess: false` выключает эту оценку, `decisions.vision: false` запрещает отправлять картинки. Если шлюз не принимает изображения, оценка повторяется без них; если нет самого `/decisions`, работает обычное ревью.

```bash
ai decide support "после оплаты страница пустая"
ai moderate community "купите подписчиков дёшево"
ai channels --listen --port 8787
# POST http://127.0.0.1:8787/v1/decisions
# POST http://127.0.0.1:8787/v1/moderate
# POST http://127.0.0.1:8787/v1/chats/reply
# POST http://127.0.0.1:8787/v1/telegram/webhook
# WS   ws://127.0.0.1:8787/v1/channels
ai telegram poll
ai telegram send 123456 "текст"
```

Кадр WebSocket: `{"type":"moderate","input":"текст","preset":"community"}`. Типы: `decide`, `moderate`, `reply`, `telegram`, `ping`. Сервер слушает `channels.host` (`127.0.0.1`). `0.0.0.0` требует `channels.token` или `--token` / `AI_CHANNELS_TOKEN`.

Telegram — Bot API без SDK: `getUpdates`, `sendMessage`, `deleteMessage`, `getChat`, `banChatMember`, `restrictChatMember`. Токен: `TELEGRAM_BOT_TOKEN` или `telegram.token`. Длинный опрос не нуждается в публичном адресе. Webhook на этом сервере принимает обновление, если до машины доходит обратный прокси на localhost.

Удаление автоматическое только при `hide` и `telegram.enforce: delete` в группе, супергруппе или канале. Личный чат не удаляется. Сообщение о вреде себе получает `review`, а не `hide`. `telegram.reply: true` отправляет черновик, когда действие `allow`: личный чат — поддержка, канал — пост, группа — короткий ответ модератора. Инструменты `decide`, `moderate_text`, `channel_reply`, `telegram_call` включаются `tools.channels` или `--tools channels` и подтверждаются как сеть.

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
  "magickPath": null,
  "tools": { "fs": true, "shell": true, "fetch": true, "web": true, "images": false, "askUser": true, "desktop": false, "mcp": true, "channels": false },
  "desktop": { "ahkPath": null },
  "limits": { "maxTurns": 60, "extendTurns": 10, "budgetUsd": null, "budgetTokens": null, "commandTimeoutMs": 180000 },
  "documentation": {
    "sources": {
      "mdnCss": "https://developer.mozilla.org/en-US/docs/Web/CSS",
      "teamGuide": "https://example.com/frontend-guide"
    },
    "roles": {
      "planner": ["mdnCss"],
      "orchestrator": ["mdnCss", "teamGuide"],
      "worker": ["mdnCss", "teamGuide"],
      "coder": ["mdnCss", "teamGuide"]
    }
  },
  "roles": {
    "planner":    { "model": "gpt-6.1-sol", "effort": "high" },
    "reviewer":   { "model": "gpt-6.1-sol", "effort": "medium" },
    "orchestrator": { "model": "gpt-6.1-sol", "effort": "high" },
    "worker":     { "model": "gpt-6-luna", "effort": "medium" },
    "vision":     { "model": "gpt-6-luna" },
    "summarizer": { "model": "gpt-6-luna", "summary": "none" }
  },
  "agent": { "mode": "team", "maxSteps": 12, "maxReviewRounds": 2, "workerMaxTurnsPerStep": 25, "maxContextBytes": 98304, "visionDelegate": "auto",
             "orchestrator": { "enabled": false, "after": ["plan", "work", "review", "fix"], "maxContextBytes": 4194304, "applyPlan": true } },
  "memory": { "enabled": true, "autoSave": true, "maxRecall": 8, "notesFile": "AGENTS.md", "dbFile": null },
  "image": { "size": "auto", "quality": "auto", "format": "png", "partialImages": 2, "outputDir": ".", "image_format": "png" },
  "completion": { "model": "gpt-6-luna", "effort": "none", "maxLineBytes": 524288, "maxContextBytes": 24576,
                  "channelProbe": true, "probeTtlMs": 60000, "probeTimeoutMs": 1500 },
  "compaction": { "auto": false, "afterInputTokens": 200000 },
  "decisions": { "model": "openai/gpt-6-luna-decisions", "reviewAt": 0.5, "blockAt": 0.9 },
  "moderation": { "mode": "auto", "model": "omni-moderation-latest", "preset": "community", "guardReplies": false },
  "telegram": { "token": null, "reply": false, "moderate": true, "enforce": "delete" },
  "channels": { "host": "127.0.0.1", "port": 8787, "token": null },
  "prices": { "gpt-6.1-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 }, "gpt-6-luna*": { "input": 0.25, "output": 2 } },
  "instructions": "Отвечай кратко."
}
```

Поля роли: `model`, `effort`, `summary`, `verbosity`, `maxOutputTokens`, `temperature`, `instructions`
(дополнительные инструкции только для этой роли); `null` — наследовать от `roles.default`, затем от общих настроек.
`documentation.sources` задаёт именованный каталог HTTP(S)-ссылок (по умолчанию доступны MDN CSS/JavaScript,
ECMA-262, TypeScript, Sass, ESLint, Stylelint и Prettier); `documentation.roles` выбирает имена источников для
`planner`, `orchestrator`, `worker` и `coder`. Передача пустого массива отключает ссылки для выбранной роли.
Встроенные веб-правила используют ES2025 как базу, требуют сверять поддержку ES2026 и новых CSS-возможностей
с целевым runtime и конфигурацией проекта, а также ориентируют роли на уже настроенные линтеры, форматтеры и проверки.
Цены в примере условные — проверьте актуальные.

Переменные окружения: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`,
`AI_MODEL`, `AI_IMAGE_MODEL`, `AI_AGENT_HOME`, `AI_DECISION_MODEL`, `TELEGRAM_BOT_TOKEN`, `AI_CHANNELS_TOKEN`,
`AI_ASCII=1` (без Unicode-символов в журнале).

### Состояние разговора

По умолчанию `store: false`: история хранится локально (в сессии), а рассуждения моделей передаются
обратно в зашифрованном виде (`include: ["reasoning.encrypted_content"]`) — ничего не остаётся на
сервере. `--store` переключает на серверное состояние через `previous_response_id`.
Фоновый режим API (`--background`) требует `store: true` и включает его сам.

## Инструменты агента и безопасность

Локальные инструменты (строгие function tools): `list_files`, `read_file`, `search_files`, `write_file`,
`replace_text`, `delete_file`, `make_dir`, `view_image`, `summarize_file`, `run_command`, `run_script`, `ssh`, `fetch_url`,
`recall`, `remember`, `ask_user`; с `--images` — `split_image`, `crop_image`, `generate_svg`; при `tools.fetch` —
`download_font`, `download_icons` (Google Fonts и CDN Phosphor/Lucide); с `--desktop` у worker и reviewer —
`screenshot`, `click`, `type`, `run_ahk`, `run_batch`, `delegate_role`; встроенные инструменты API: `web_search`
(включён по умолчанию, `--no-web` выключает), `image_generation` (`--images`).

`split_image` и `crop_image` используют ImageMagick (`magick` или `convert` из `PATH`; явный путь —
`magickPath` в конфигурации) и возвращают координаты плиток, чтобы их можно было передать в `view_image`.
Без ImageMagick инструменты отвечают ошибкой, остальной агент работает как обычно. `download_font` берёт файл
Google Fonts или прямой URL, `download_icons` — набор иконок или одну иконку с jsDelivr/unpkg.

Политика подтверждений `--approve`:

| Уровень | Чтение, память | Запись файлов | Команды, сеть | Рабочий стол |
| --- | --- | --- | --- | --- |
| `ask` (терминал по умолчанию) | да | спросить (`y`/`n`/`a` — всегда для инструмента/`q`) | спросить | спросить |
| `read` (без терминала по умолчанию) | да | нет | нет | нет |
| `write` | да | да | нет | нет |
| `all` / `--yes` | да | да | да | да |

Оркестратор всегда работает в режиме только чтения; ревьюер — чтение плюс `run_command`, `run_script` и `ssh` по той же политике.
`--approve ask` подтверждает каждое действие рабочего стола. `--approve read` и `--approve write` рабочий стол не разрешают. `--approve all` разрешает.

Инструменты работают только внутри `--cwd` (по умолчанию текущий каталог): выход за его пределы,
в том числе через символические ссылки, запрещён; `.env*`, ключи и сертификаты, `.ssh`, `.aws` и т. п.
недоступны; запись в `.git` и `node_modules` запрещена. Перед перезаписью и удалением файл копируется в
`~/.ai-agent/backups/<дата>/`. `run_command` выбирает оболочку на вызов: cmd, powershell, pwsh, bash, sh или zsh
(пусто — cmd.exe в Windows и /bin/sh в остальных системах). `run_script` запускает файл `.ps1`, `.cmd`, `.bat`, `.sh` или `.bash`.
`ssh` вызывает системные `ssh` и `scp`: удалённая команда, скрипт `.ps1`/`.sh` на stdin, либо один файл (`put` / `get`).
Пароль ввести нельзя (`BatchMode`); пустой `identity` — ключ ssh по умолчанию. Таймаут и лимит вывода те же,
дерево процессов завершается принудительно; из окружения вырезаются переменные,
похожие на секреты (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`). Весь текст модели перед выводом
очищается от управляющих последовательностей терминала.

Содержимое файлов, страниц и вывод команд — ненадёжные данные (prompt injection): для автономных
запусков с `--approve all` задавайте лимиты `--max-turns`, `--budget-usd`/`--budget-tokens`.
Когда `limits.maxTurns` исчерпан, в терминале агент спрашивает, продлить ли работу ещё на
`limits.extendTurns` ходов (по умолчанию 10); отказ или запуск без терминала останавливают задачу.

Вложения `--file` и `--image` принимают локальный путь, ссылку `http(s)://` и `data:` URL.
Изображения уходят в модель как `input_image`, PDF — как `input_file` в base64, текст — как `input_text`;
HTML предварительно превращается в текст. Исполняемые файлы, архивы, шрифты и другие бинарные файлы
не отправляются в модель — вместо этого возвращается понятная ошибка. Для них есть отдельные
инструменты: `download_font`, `download_icons`, `split_image`, `crop_image`, `generate_svg`.

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
src/cli-help.js           текст `ai --help`
src/openai/http.js        транспорт на node:https (явный таймаут простоя, без скрытых лимитов undici)
src/openai/sse.js         ограниченный по размеру парсер Server-Sent Events
src/openai/stream.js      события Responses API → события приложения, финальный объект ответа
src/openai/client.js      /responses (create, retrieve+resume, cancel, compact, input_tokens), /models, повторы
src/core/config-defaults.js  значения по умолчанию и списки допустимых полей
src/core/config.js        конфигурация, роли (resolveRole) и валидация
src/core/session.js       история разговора (stateless / previous_response_id), сохранение сессий
src/core/usage.js         учёт токенов и стоимости (всего, по ролям, по моделям), бюджеты
src/core/memory.js        долговременная память: SQLite + FTS5, сводки файлов, история задач
src/core/context.js       общий контекст ролей с приоритетами разделов и обрезкой по размеру
src/core/attachments.js   изображения и файлы → input_image / input_file / input_text
src/core/background.js    опрос и переподключение к фоновым ответам
src/core/images.js        сохранение итоговых и промежуточных изображений
src/agent/tool-specs.js   схемы и список включённых инструментов
src/agent/tools.js        политика подтверждений и исполнение (память, vision, сводки)
src/agent/assets.js       SVG, шрифты Google Fonts, наборы иконок с CDN
src/agent/image-magick.js поиск ImageMagick, обрезка и разбивка изображений
src/agent/image-alpha.js  маска модели → альфа-канал (CopyOpacity), запасная заливка от углов
src/agent/map.js          `.ai/map.json` и кеш в памяти
src/agent/map-scan.js     символы, JSDoc-метки и относительные импорты
src/agent/team-text.js    текст плана и находок сборщика
src/agent/fs-tools.js     операции с файлами (лимиты, резервные копии)
src/agent/shell.js        запуск команд с таймаутом и завершением дерева процессов
src/agent/paths.js        ограничение путей рабочим каталогом, защищённые имена
src/agent/loop.js         цикл «модель ⇄ инструменты», сборка тела запроса, компактизация
src/agent/roles.js        запуск запросов от имени роли (модель/effort роли, строгий JSON, vision, сводки файлов)
src/agent/team.js         оркестратор команды: план → сбор контекста → шаги → ревью/правки → память
src/agent/schemas.js      JSON-схемы структурированных ответов ролей
src/agent/diff.js         diff изменений для ревьюера
src/ui/glyphs.js          кадры спиннера и определение режима вывода
src/ui/renderer.js        строка статуса, журнал, вопросы пользователю; режимы tty/plain/json/quiet
src/ui/renderer-events.js текст одного события агента
src/util/toon.js          фасад кодека TOON (encode / decode в соседних файлах)
src/interact/ahk-script.js  текст программы AutoHotkey v2
src/commands/flags.js     флаги CLI → поля конфигурации
src/jobs/manager.js       локальные фоновые задачи
src/complete/context.js   курсор, сокращение файла, пропуск строк длиннее 0.5 МиБ
src/complete/complete.js  запрос к быстрой модели (по умолчанию gpt-6-luna, effort none)
src/complete/server.js    POST /v1/complete и WebSocket на 127.0.0.1
src/complete/ws.js        кадры WebSocket поверх node:http
src/channels/             решения, модерация, черновики, HTTP и WebSocket /v1/channels
src/telegram/             адаптер Bot API, нормализация апдейтов, длинный опрос
src/commands/*.js         ask, chat, run, image, jobs, memory, complete, decide, moderate, channels, telegram, serve
src/server/protocol.js    WebSocket поверх node:http для ai serve
src/server/hub.js         запуски, подписчики и подтверждения
src/server/publish.js     --serve: публикация событий терминала
```

Программный интерфейс (`index.js`): `createClient`, `createSession`, `createLedger`, `createToolset`,
`runTurn`, `createRoleRunner`, `runTeam`, `openMemory`, `createSharedContext`, `resolveRole`,
`buildUserMessage`, `createRenderer`, `createJobManager`, `buildCompletionContext`,
`completeCode`, `startCompletionServer`, `requestDecision`, `moderateText`, `draftReply`,
`handleInbound`, `startChannelServer`, `listenProtocol`, `createHub`, `createTelegram`, `normalizeUpdate`.

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
