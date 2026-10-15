# Метки JSDoc

Исходники в `src/` пишутся с отступом в 4 пробела. У каждого модуля первый блок `/** ... */` — карточка файла. У функций, классов и методов — свой блок сразу над объявлением. Карта проекта (`.ai/map.json`, модуль `agent/map`) забирает эти метки в поля `doc` и `symbols`, чтобы агент мог сузить чтение, не открывая весь файл.

## Карточка файла

```js
/**
 * @file src/agent/map.js
 * @module agent/map
 * @purpose Одна фраза: что делает модуль.
 * @depends agent/paths, agent/map-scan
 * @usedBy commands/map, agent/tools, index.js
 * @exports loadProjectMap, searchMapped
 * @ai.tags index, cache
 * @ai.hint pure-read | writes .ai/map.json | hot
 * @changed 2026-10-15 Что изменилось в этом проходе.
 */
```

| Метка | Куда попадает | Зачем |
| --- | --- | --- |
| `@file` | `doc.file` | Стабильный путь модуля |
| `@module` | `doc.module` | Имя для поиска и для `@depends` / `@usedBy` |
| `@purpose` | `doc.purpose` | Смысл без чтения тела. Если метки нет, берётся первый абзац комментария |
| `@depends` | `doc.depends` | Модули, без которых этот файл не работает |
| `@usedBy` | `doc.usedBy` | Кто импортирует. Обратная сторона `@depends` |
| `@exports` | `doc.exports` | Имена публичного API через запятую |
| `@ai.tags` | `doc.tags` | Короткие слова для поиска: `index`, `io`, `pure`, `desktop` |
| `@ai.hint` | `doc.hint` | Как упрощать: `pure`, `io`, `hot`, `split-ok`, `keep` |
| `@changed` | `doc.changed` | Последняя заметная правка в шапке |

`@exports` на функции (без списка имён) помечает сам символ: `symbols[].exported = true`. У `export function` это и так видно по `kind: "export"`.

## Символ

```js
/**
 * Кратко, что делает и кто вызывает.
 * @param {string} root Абсолютный корень проекта.
 * @returns {string} Путь к `.ai/map.json`.
 * @exports
 * @ai.hint pure
 */
export function projectMapFile(root) {}
```

В символ карты попадают `purpose`, `exported`, `hint`, `tags`, `params` (`{ name, type }`), `returns`. Поиск `scope=symbol` смотрит имя, purpose, hint и tags.

## Подсказки для упрощения

- `pure` — нет диска, сети и процесса. Можно выносить и тестировать отдельно.
- `io` — читает или пишет файлы, сеть, процесс.
- `hot` — на каждом ходе агента. Не раздувать.
- `keep` — связка хрупкая, не дробить без теста.
- `split-ok` — файл ещё можно резать по этой границе.

Поиск по карте: `search_files` с `scope=symbol` или `ai map` после пересборки. Пересборка: `ai map` или правка файла инструментом `write_file` / `replace_text`.
