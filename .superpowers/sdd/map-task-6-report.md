# Task 6 report: `ai map` command and docs

## What you implemented

`src/commands/map.js` exports `mapCommand`. With no subcommand it calls `buildProjectMap(cwd)` and prints `Карта записана: <path>` plus `файлов: N, символов: M`. `ai map path` calls `loadProjectMap` (no rebuild) and prints the same counts, or zeros when the file is missing. Any other subcommand, or more than one positional, throws `UsageError` (`Доступно: ai map | ai map path`), which the CLI already turns into exit 2.

`src/cli.js` registers `map: mapCommand`. `map` is not in `NEEDS_API_KEY` or `DETACHABLE`. Help lists `ai map [path]` and, under tools, `search_files scope=path|symbol|content|all читает карту проекта.`

`.gitignore` ignores `.ai/` next to `.ai-agent/`. `README.md` lists `ai map [path]` and adds the `### Карта проекта` subsection (map file, in-process reuse, `search_files` scope, planner marks, writes outside `edit`).

Pre-existing model-name edits in `README.md`, `src/cli.js`, and `test/cli.test.js` were kept and included in this commit.

## What you tested and test results

RED, before `src/commands/map.js` existed and before `map` was registered. The test body was the brief's snippet (no directory cleanup yet).

Command: `node --test --test-timeout=60000 test/cli.test.js`

Exit code 1. 13 passed, 1 failed. Unknown `map` is treated as `ask`, which requires an API key, so the empty `OPENAI_API_KEY` exits 2:

```
✖ map writes .ai/map.json without an API key (83.6898ms)
  AssertionError [ERR_ASSERTION]: ✗ Не задан OPENAI_API_KEY. Экспортируйте переменную окружения или укажите apiKey в ~/.ai-agent/config.json.
  · Справка: ai --help

  2 !== 0

      at TestContext.<anonymous> (file:///C:/Projects/Universal-AI/test/cli.test.js:237:10)
```

After the command existed, that same test reached `ai map path` and failed for a different reason. The shared `work` directory still held files from earlier tests in `test/cli.test.js`:

```
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /файлов: 1/. Input:

'C:\\Users\\U2RE\\AppData\\Local\\Temp\\ai-agent-work-QuaYjy\\.ai\\map.json\n' +
  'файлов: 5, символов: 1\n'
```

The path matched and the symbol count was 1 (`export function hello`). The file count was 5. The test now deletes those leftovers before writing `a.js`.

GREEN, after that isolation, on the committed code.

Command: `node --test --test-timeout=60000 "test/*.test.js"`

Exit code 0. 67 passed, 0 failed, including `test/map.test.js`, `test/task-map.test.js`, and `map writes .ai/map.json without an API key`. `map` and `map path` exit 0 with an empty `OPENAI_API_KEY`. `map nope` exits 2. `map path` prints `.ai\map.json` and `файлов: 1`.

```
✔ map writes .ai/map.json without an API key (257.1793ms)
✔ project map (64.739ms)
✔ draft caps edit, read, and scan and sorts paths (3.8591ms)
✔ filterTaskMap drops a path that is not in the map (0.5713ms)
ℹ tests 67
ℹ suites 0
ℹ pass 67
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3173.7917
```

## Files changed

Commit `ff77cce55f8f1bc595339fe5c2d88b4374d33171` `feat: add the ai map command for the project index`

- `src/commands/map.js` (new)
- `src/cli.js` (map command, help line, `search_files` scope line; pre-existing model-name example kept)
- `.gitignore` (`.ai/`)
- `README.md` (command line, `### Карта проекта`; pre-existing model-name edits kept)
- `test/cli.test.js` (new test plus a cleanup of `work`; pre-existing model-name assertions kept)

Not staged: `sketches/models-native.js`, `src/commands/misc.js`, `src/core/config.js`, `test/core.test.js`, `test/helpers/mock-server.js`, `test/loop.test.js`, `docs/`, `.superpowers/`. Not pushed.

## Self-review findings

- `map` is absent from `NEEDS_API_KEY` and `DETACHABLE`.
- `ai map path` does not rebuild. A missing map prints zeros.
- `countProjectMap` reads the in-memory `files` Map returned by `buildProjectMap` and `loadProjectMap`.
- The new test is last in the file. Tests in that file run one after another, so clearing `work` does not affect the tests above it.

## Concerns

- The brief's test writes `a.js` into the shared temp directory and expects `файлов: 1`. Earlier tests in the same file leave `out/answer.md`, `hello.js`, `schema.json`, and `note.txt`, so the count is 5. The committed test removes those entries first. The assertions are otherwise the brief's.

## Follow-up: model fixture alignment

The committed CLI test expects `gpt-6.1-sol`. Those names were left as-is. The mock server, default model, and the other fixture files now use the same names, so a clean checkout no longer lists `gpt-5.5`.

Command: `node --test --test-timeout=60000 "test/*.test.js"`

Exit code 0. 67 passed, 0 failed.

Commit `30488aae4d9b78c769091c664b00992350f4d9f3` `chore: align default model names with the test fixtures`

That commit also keeps two local default edits that were already in the unstaged `src/core/config.js` and `sketches/models-native.js`: `baseURL` is `https://api.proxyapi.ru/v1`, and `reasoning.effort` is `"low"`. `.superpowers/` and `docs/` were not staged. Not pushed.
