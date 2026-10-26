# План версии 0.2.0 — роли, effort, контекст, динамический пайплайн

Цель: перевести `@u2ai/universal-ai` с фиксированной ролевой команды и одного
потолка настроек на декларируемую конфигурацию: профили моделей, потолки
reasoning effort, символьные уровни контекста, пользовательские роли и
динамическая последовательность этапов.

Проверка успеха: `npm test` (58 файлов) зелёный, новые тесты проходят, README
описывает поведение.

---

## 1. [x] Реестр профилей моделей

Метаданных о моделях нет: `src/openai/model-map.js` содержит только замены
моделей (`MODEL_FALLBACKS`). Ни окна, ни max output, ни поддерживаемых effort.

- Навыки: koda-coder
- Файлы:
  - `src/openai/model-profiles.js` (новый) — `MODEL_PROFILES`, `profileFor(model)`,
    `EFFORT_ORDER`, `capEffort(effort, ceiling)`
  - `src/core/config-defaults.js` — секция `models` для переопределений юзером
  - `src/core/config.js` — резолвер профиля с учётом переопределений
- Проверка: `test/model-profiles.test.js`

## 2. [x] Потолок reasoning effort

`pace.js` умеет только пол (`applyShift(base, shift, floor)`), потолка нет.
Потолок = потолок модели ∩ потолок роли (`roles.<name>.maxEffort`).

- Файлы:
  - `src/core/config.js` — `resolveRole` применяет потолок
  - `src/agent/pace.js` — потолок при сборке `directive.roles.*`
  - `src/agent/loop.js` — `buildRequestBody` финальная страховка
  - `src/core/config-defaults.js` — `maxEffort` в `roles.default`
- Проверка: `test/pace.test.js`, `test/core.test.js`

## 3. [x] Символьные уровни контекста

`small` 16 KiB / `normal` 96 KiB / `large` 512 KiB / `max` 8 MiB / `auto` — по
окну модели. Резолвить после `deepMerge` и до `validateConfig`
(`config.js:193-199`), иначе мерж затрёт значение.

- Файлы:
  - `src/openai/model-profiles.js` — `CONTEXT_LEVELS`, `resolveContextBytes`
  - `src/core/config.js` — нормализация полей `*ContextBytes`
  - `src/core/config-defaults.js` — уровни вместо голых чисел в дефолтах
- Поля-потребители: `agent.maxContextBytes`, `agent.measurerMaxContextBytes`,
  `agent.orchestrator.maxContextBytes`, `completion.maxContextBytes`,
  `limits.maxRequestBytes`
- Проверка: `test/core.test.js`

## 4. [x] Пользовательские роли

`config.js:301` отвергает неизвестное имя роли, `:303` — неизвестное поле.
Снимаем запрет имени, добавляем `maxEffort`, `tools`, `context` в whitelist полей.

- Файлы:
  - `src/core/config-defaults.js` — `BUILTIN_ROLE_NAMES`, новые поля
  - `src/core/config.js` — `roleNames(config)`, `resolveRole` для своих ролей
  - `src/commands/flags.js` — `--role` принимает своё имя
  - `src/commands/run.js` — описание ролей в статус-строке
- Проверка: `test/roles.test.js`, `test/cli.test.js`

## 5. [x] `delegate_role` наравне с `run_subagent`

Две разные логики: `delegate_role` — фиксированный enum 6 специалистов без
контекста; `run_subagent` — 8 ролей со срезом инструментов. Делаем единый
реестр ролей-исполнителей (встроенные + пользовательские), `delegate_role`
получает параметр `context`.

- Файлы:
  - `src/agent/role-registry.js` (новый) — единый реестр исполнителей
  - `src/agent/subagents.js` — реестр из registry + свои роли
  - `src/agent/tool-specs.js` — `delegate_role`: динамический enum, `context`
  - `src/agent/team.js` — `delegate()` идёт через тот же реестр
- Проверка: `test/subagents.test.js`, `test/desktop.test.js`

## 6. [x] Динамическая последовательность этапов

`team.js:815-1458` — 15 последовательных `await`, массива этапов нет.
Порядок выражается как данные: реестр этапов + план + конфиг.

- Файлы:
  - `src/agent/pipeline.js` (новый) — реестр `{ id, role, when, run }`
  - `src/agent/team.js` — цикл по этапу вместо if-цепочки
  - `src/agent/schemas.js` — `PLAN_SCHEMA.pipeline`
  - `src/core/config-defaults.js` — `agent.pipeline`
- Проверка: `test/team.test.js`, `test/pipeline.test.js`

## 7. [x] Флаги, конфигурация, тесты, README

- Файлы:
  - `src/commands/flags.js` — `--max-effort`, `--context`, `:ceiling` в `--role`
  - `src/cli-help.js` — справка по новым флагам
  - `README.md` — разделы 0.2.0
  - `package.json` — версия `0.2.0`
- Проверка: `npm test` целиком

---

## Решения, подтверждённые пользователем

1. Профили моделей: дефолты в коде, переопределение в `config.json → models`.
2. Уровни контекста: small 16 KiB, normal 96 KiB, large 512 KiB, max 8 MiB, auto по окну.
3. Инструкции своих ролей: только текстом в `roles.<name>.instructions`.
4. `run_subagent` и `delegate_role` остаются обоими именами (совместимость),
   один реестр и один раннер под ними.

---

## Результат

Все семь шагов выполнены, `npm test` — 576 тестов, 0 падений, версия `0.2.0`.

- Профили: `src/openai/model-profiles.js` (окно, maxOutput, потолок, лестница),
  переопределения `models.*`, `resolveRole` и `buildRequestBody` не просят больше
  output-токенов, чем принимает модель.
- Потолок effort: модель ∩ роль, применяется в `resolveRole`, `resolvePace`,
  `applyPins` и `buildRequestBody`; `--max-effort` ставит его всем ролям.
- Контекст: `small|normal|large|max|auto` в пяти полях и `roles.<имя>.context`,
  `--context` для общего бюджета.
- Свои роли: слаг в `roles.<имя>`, поля `instructions`, `tools`, `model`, `effort`,
  `maxEffort`, `context`; доступны в `--role` и `delegate_role`.
- `delegate_role`: общий реестр с `run_subagent`, `context: true` прикладывает
  общий контекст команды.
- Пайплайн: `src/agent/pipeline.js` (`STAGE_CATALOG`, `resolvePipeline`,
  `createPipeline`), порядок из `plan.pipeline` → `agent.pipeline` → каталог,
  зависимости подтягиваются вперёд, хвостовые этапы `outcome` и `memory`
  добавляются всегда.
- Флаги и справка: `--max-effort`, `--context`, `--role роль=модель[:effort[:max-effort]]`,
  README и `ai --help` описывают 0.2.0.
