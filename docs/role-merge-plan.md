# План объединения ролей

## Цель

Сократить число ролей, объединив узкоспециализированные в более крупные.
Заодно сменить формат идентификации в заголовке рана с `role=model:effort` на `model:role`.

## Слияния

### 1. tester + vision → reviewer

**Почему:** reviewer и так проверяет результат; tester проверяет одно утверждение — та же работа в меньшем масштабе. vision описывает картинку, что reviewer делает при проверке визуального результата.

**Что происходит:**
- `src/roles/tester.js` → **удалить**
- `src/roles/vision.js` → **удалить**, но helpers `imageLongSide` / `imageTier` перенести в `src/roles/reviewer.js`
- `src/roles/reviewer.js` → добавить `checkInstructions` (бывший tester) и `visionInstructions` / `visionScreenInstructions` (бывший vision)
- `src/agent/role-registry.js` → удалить `tester` и `vision` из `EXECUTORS`, их инструменты слить в `reviewer` (слайс `check` + `read` + `screenshot`)
- `src/core/config-defaults.js` → удалить `tester` и `vision` из `defaults.roles`, tiers vision перенести в `reviewer.tiers`
- `src/agent/tool-specs.js` → удалить `tester` и `vision` из enum `delegate_role` и `run_subagent`
- `src/agent/roles.js` → `describeImage`/`describeScreen` вызывают `run('reviewer', ...)` вместо `run('vision', ...)`; `shouldDelegateVision` сравнивает `resolve('reviewer')`; импорт `imageLongSide/imageTier` из `../roles/reviewer.js`
- `src/agent/team.js` → `vision(role)` возвращает `roles.describeImage` (внутри уже вызывает reviewer); `visionDelegate` конфиг → переименовать в `reviewerDelegate` или оставить ключ, но использовать reviewer
- `src/commands/misc.js` → удалить `tester` и `vision` из init-шаблона
- `src/cli-help.js` → убрать tester/vision из описаний
- `src/roles/untrusted.js` → убрать tester из @usedBy и из текста delegate_role
- `src/agent/pace.js` → `reviewer` остаётся один, без tester/vision
- Тесты: `roles.test.js`, `role-registry.test.js`, `subagents.test.js`, `solver.test.js` (imageTier/imageLongSide), `team.test.js`, `roles.test.js`

### 2. extractor → encoder

**Почему:** encoder превращает ответ в file-commands; extractor чистит артефакты ответа в файлы. Задача та же — кодификация ответа в артефакты.

**Что происходит:**
- `src/roles/extractor.js` → **удалить**
- `src/roles/encoder.js` → добавить `extractInstructions` (бывший extractor)
- `src/agent/role-registry.js` → **не меняется** (extractor не был в EXECUTORS)
- `src/core/config-defaults.js` → удалить `extractor` из `defaults.roles`, `verbosity: 'low'` перенести в `encoder`
- `src/agent/tool-specs.js` → удалить `extractor` из enum `delegate_role` (если был)
- `src/agent/team.js` → `roles.run('extractor', ...)` → `roles.run('encoder', ...)`; `ROLE_INSTRUCTIONS.extractor` → `ROLE_INSTRUCTIONS.encoderExtract`; pace extractor → encoder
- `src/agent/extract.js` → уведомления `Extractor: ...` → `Encoder: ...` (или оставить тексты, но поменять роль)
- `src/agent/pace.js` → `extractor: role(...)` → удалить или слить в `encoder`
- `src/commands/misc.js` → удалить `extractor` из init-шаблона
- `src/cli-help.js` → убрать extractor
- `src/roles/untrusted.js` → убрать extractor из @usedBy
- Тесты: `roles.test.js`, `team.test.js`, `pace.test.js`, `extract.test.js`

### 3. summarizer + writer → orchestrator

**Почему:** orchestrator и так несёт весь контекст команды. summarizer делает сводки (компакция, файлы, память) — это часть контекстной работы. writer пишет документы, но orchestrator знает проект лучше всех и сам может их генерировать.

**Что происходит:**
- `src/roles/summarizer.js` → **удалить**
- `src/roles/writer.js` → **удалить**, но `isWritingStep` перенести в `src/roles/orchestrator.js`
- `src/roles/orchestrator.js` → добавить `memoryInstructions`, `fileSummaryInstructions` (бывший summarizer) и `writingInstructions` (бывший writer); перенести `isWritingStep`
- `src/agent/role-registry.js` → удалить `writer` из `EXECUTORS`
- `src/core/config-defaults.js` → удалить `summarizer` и `writer` из `defaults.roles`; `summary: 'none'` и `verbosity: 'medium'` из summarizer → в `orchestrator`
- `src/agent/tool-specs.js` → удалить `writer` из enum `run_subagent`
- `src/agent/roles.js` → `summarizeFile` вызывает `run('orchestrator', ...)` с `instructionsOnly: true` и `instructions: ROLE_INSTRUCTIONS.orchestratorFileSummary`
- `src/agent/team.js`:
  - `authorFor`: `'writer'` → `'orchestrator'` (или `'worker'`, т.к. orchestrator — не автор шага; **лучше**: `isWritingStep` возвращает `'worker'`, т.к. writer больше нет как отдельный автор)
  - Memory extraction: `roles.run('summarizer', ...)` → `roles.run('orchestrator', ...)` с `instructionsOnly: true` и `instructions: ROLE_INSTRUCTIONS.orchestratorMemory`
  - `toolNamesForRole`: для `'orchestrator'` расширить с read-only до `all` (права writer = all tools)
  - pace roles: `summarizer` → `orchestrator`
- `src/agent/pace.js` → удалить `summarizer` из `directive.roles`; writer → worker/orchestrator
- `src/commands/misc.js` → удалить `writer` и `summarizer` из init-шаблона
- `src/cli-help.js` → убрать writer/summarizer из описаний
- `src/roles/untrusted.js` → убрать writer/summarizer из @usedBy
- Тесты: `writer.test.js` → **удалить**, `roles.test.js`, `role-registry.test.js`, `subagents.test.js`, `team.test.js`, `pace.test.js`, `role-tiers.test.js`, `effort-ceilings.test.js`, `solver.test.js`

## Формат `model:role` вместо `model:effort`

**Где:** `src/commands/shared.js` → `describeRoles`

**Сейчас:** `role=model:effort` (например `planner=gpt-6.1-terra:xhigh`)

**Станет:** `model:role` (например `gpt-6.1-terra:planner`)

```js
// Было
return `${name}=${role.model}${role.effort ? `:${role.effort}` : ''}`;

// Станет
return `${role.model}:${name}`;
```

**Флаг `--role name=model:effort`** в `src/commands/flags.js` остаётся как есть (там effort нужен для указания модели), но **описание в ошибке** и **help** обновляются на `model:role` где это визуальная идентификация.

## Порядок выполнения

1. `src/roles/reviewer.js` — добавить checkInstructions, visionInstructions, visionScreenInstructions, imageLongSide, imageTier
2. Удалить `src/roles/tester.js`, `src/roles/vision.js`
3. `src/roles/encoder.js` — добавить extractInstructions
4. Удалить `src/roles/extractor.js`
5. `src/roles/orchestrator.js` — добавить memoryInstructions, fileSummaryInstructions, writingInstructions, isWritingStep
6. Удалить `src/roles/summarizer.js`, `src/roles/writer.js`
7. `src/roles/index.js` — обновить импорты и ROLE_INSTRUCTIONS
8. `src/agent/role-registry.js` — удалить tester, vision, writer; обновить reviewer
9. `src/core/config-defaults.js` — удалить tester, vision, extractor, summarizer, writer; обновить reviewer, encoder, orchestrator
10. `src/agent/tool-specs.js` — обновить enum'ы
11. `src/agent/roles.js` — vision → reviewer, summarizer → orchestrator
12. `src/agent/team.js` — все ссылки на удалённые роли
13. `src/agent/extract.js` — Extractor → Encoder в уведомлениях
14. `src/agent/pace.js` — extractor → encoder, summarizer → orchestrator
15. `src/commands/shared.js` — `model:role` формат
16. `src/commands/flags.js` — обновить текст ошибки
17. `src/commands/misc.js` — обновить init-шаблон
18. `src/cli-help.js` — обновить описания
19. `src/roles/untrusted.js` — обновить @usedBy и текст
20. Тесты — обновить все затронутые

## Итоговый список ролей после слияния

| Роль | Что делает |
|------|-----------|
| `default` | ask / chat / single-agent run |
| `planner` | понимает задачу, пишет план |
| `architect` | план → файловая структура, дизайн |
| `orchestrator` | собирает контекст, координирует, сводки, память, документы |
| `worker` | выполняет шаги не-код |
| `coder` | пишет код |
| `styler` | пишет CSS/SCSS |
| `iconifier` | подбирает иконки |
| `reviewer` | ревью, проверка утверждений, описание картинок |
| `solver` | решает шаг по экрану/картинке |
| `clicker` | один клик |
| `typer` | ввод текста |
| `encoder` | батч для десктопа, file-commands, чистка артефактов |
| `classifier` | тривиал/нормал/комплекс |
| `decomposer` | разбивает референсы на экраны |
| `measurer` | замеряет референсы |
| `decorator` | декоративные элементы |
| `image-processor` | подготовка картинок |

**Упразднены:** `tester`, `vision`, `extractor`, `summarizer`, `writer`
