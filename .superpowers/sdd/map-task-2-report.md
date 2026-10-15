# Task 2 report: Search through the map

## What you implemented

`search_files` in `src/agent/tools.js` loads `.ai/map.json` through `loadProjectMap` and, when that returns a map, answers with `searchMapped`. `searchFiles` from `src/agent/fs-tools.js` stays the fallback walk.

The tool schema adds a required `scope` property: `path`, `symbol`, `content`, or `all`. `schema()` puts every key in `required`, so `scope` is required. The description says the search uses the project map when `.ai/map.json` is present, and still says matches look like `path:line: text`.

The handler treats a missing `scope` as `all`. Any other value throws `scope: path, symbol, content или all.` before a scan. When the map cannot be loaded, the walk result is prefixed with `Карта проекта недоступна; поиск по дереву.`

`src/agent/map.js` was not changed. Task 1 already exported `searchMapped` and `loadProjectMap`. The new subtest was appended at the end of the `project map` parent. `searchMapped` was already imported there.

## What you tested and test results

Command: `node --test --test-timeout=60000 test/map.test.js`

The brief expected 4 tests. Node counts the parent plus every subtest. Task 1 already had 6 subtests (7 tests with the parent). This task added one subtest, so the summary is 8 passed, 0 failed.

A scratch script (not committed) called `createToolset` `search_files`:

- Required parameters: `query,path,regex,scope`. Enum: `path,symbol,content,all`.
- No `.ai/map.json`, omitted `scope`: `ok` true, first line `Карта проекта недоступна; поиск по дереву.`
- `scope: 'nope'`: `ok` false, `Ошибка: scope: path, symbol, content или all.`
- After `buildProjectMap`, `scope: 'symbol'`, query `goodbye`: `lib.js:2: export goodbye`, summary `1 совпадений`, no fallback prefix.

## TDD evidence

### RED

The failing test was appended before `src/agent/tools.js` was edited. `searchMapped` was already implemented by Task 1, which the brief allows: keep the test and continue to the tool schema.

Command: `node --test --test-timeout=60000 test/map.test.js`

```
▶ project map
  ✔ build indexes source symbols and imports, and skips binary files and node_modules (16.6722ms)
  ✔ a second load with the same modification time does not observe a rewritten map file (1.5643ms)
  ✔ updateProjectMapPath replaces one file and keeps the others (2.6017ms)
  ✔ deleting an imported file removes it from other files' imports (2.0087ms)
  ✔ a content search skips a map path whose file is gone and still returns other hits (1.9571ms)
  ✔ a file under .ssh is not indexed (2.8192ms)
  ✔ searchMapped answers path and symbol from RAM and content from the file (1.326ms)
✔ project map (34.1727ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 86.3059
```

Exit code 0. There was no failing assertion. `widget.py` and `util/text.js` were already deleted by earlier subtests. The new assertions used the remaining `lib.js` (`import { clip }` and `export function goodbye`) and recreated nothing.

### GREEN

`search_files` was wired after that run. The same command was run again.

```
▶ project map
  ✔ build indexes source symbols and imports, and skips binary files and node_modules (14.9652ms)
  ✔ a second load with the same modification time does not observe a rewritten map file (1.3675ms)
  ✔ updateProjectMapPath replaces one file and keeps the others (2.0559ms)
  ✔ deleting an imported file removes it from other files' imports (1.5373ms)
  ✔ a content search skips a map path whose file is gone and still returns other hits (1.2206ms)
  ✔ a file under .ssh is not indexed (2.0757ms)
  ✔ searchMapped answers path and symbol from RAM and content from the file (1.0359ms)
✔ project map (28.7925ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 80.4229
```

Exit code 0. The committed test does not call the `search_files` handler. The scratch script above is the evidence for that wiring.

## Files changed

Commit `b293147c9d6819cb03c9604010857cff5d57cd19` `feat: search the project map before reading file bytes`

- `src/agent/tools.js`
- `test/map.test.js`

`src/agent/map.js` was not staged. Pre-existing edits (README, CLI, config, other tests, sketches) were not staged. Not pushed.

## Self-review findings

- Path search for `lib.js` matches `^lib.js$`. Symbol search prints `lib.js:<line>: export goodbye`. Content search for `clip` still hits the import line after `util/text.js` is gone. A second content search returns the same text.
- Invalid `scope` is rejected before `loadProjectMap` and before `searchFiles`.
- A null `path` still becomes `.` via `args.path || '.'`.
- `list_files` is unchanged.

## Concerns

- The new subtest passed on the first run. It does not prove a missing feature, and it does not execute `search_files`.
- The brief's "PASS, 4 tests" count is the Task 1 parent plus its original three subtests. This tree reports 8 because later Task 1 subtests are already in the parent.
- `test/team.test.js` still sends a collector `search_files` call without `scope`. The handler treats that as `all`. That file was not re-run and was not staged. Strict callers must now send `scope`.
