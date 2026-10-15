# Task 4 report: Task-map draft and filter

## What you implemented

`src/agent/task-map.js` drafts read, edit, and scan marks from a project map's in-memory `files` table. It does not walk the tree and does not change the team run.

Words are `task.toLowerCase().split(/[^0-9a-zа-яё]+/i)` with length at least 3. An edit hit is a path segment, the full lower-case path, or a lower-case symbol name that contains a word, or a path contained in the task string. Edit is capped at 12, sorted by path. Reason: `совпадение с задачей`.

Read hits are other indexed files whose `imports` include a kept edit path, or that appear in a kept edit file's `imports`. Cap 20. Reason: `импорт рядом с правкой`.

Scan hits are other indexed files in the same directory (`path.posix.dirname`) as a kept edit path. Cap 40. Reason: `тот же каталог`.

`filterTaskMap` returns `[]` for a non-array or a null map. It keeps entries whose role is `read`, `edit`, or `scan`, whose path is a key in `projectMap.files`, and whose reason is a string.

`formatDraft` and `formatMarks` print the bullet list, or `Task map draft: (empty)` and `Task map: (empty)`. `formatScan` joins `path:line: kind name` for symbols of `scan` marks, or `''`.

`index.js` exports `draftTaskMap`.

## What you tested and test results

Command: `node --test --test-timeout=60000 test/task-map.test.js`

Expected after the implementation: PASS, 2 tests. `read/r00.js` through `read/r19.js` are the read hits because `edit/a01-alpha.js` is the first edit path and lists those imports. `edit/a01-alpha.js` stays in `edit`.

## TDD evidence

### RED

`test/task-map.test.js` was written before `src/agent/task-map.js` existed.

Command: `node --test --test-timeout=60000 test/task-map.test.js`

```
node:internal/modules/esm/resolve:272
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Projects\Universal-AI\src\agent\task-map.js' imported from C:\Projects\Universal-AI\test\task-map.test.js
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
    at moduleResolve (node:internal/modules/esm/resolve:879:10)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:708:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:728:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:766:56)
    at #resolve (node:internal/modules/esm/loader:690:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:610:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:277:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:389:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///C:/Projects/Universal-AI/src/agent/task-map.js'
}

Node.js v26.5.0
✖ test\task-map.test.js (43.9919ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 48.561

✖ failing tests:

test at test\task-map.test.js:1:1
✖ test\task-map.test.js (43.9919ms)
  'test failed'
```

Exit code 1. The file failed to load because `src/agent/task-map.js` was missing. Node counts that load failure as 1 failed test.

### GREEN

The module and the `index.js` export were added after that run. The same command was run again.

```
✔ draft caps edit, read, and scan and sorts paths (2.2221ms)
✔ filterTaskMap drops a path that is not in the map (0.1689ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 57.1021
```

Exit code 0.

A separate check of the same fixture, not part of the committed test file, confirmed `read/r00.js` through `read/r19.js`, and that `edit/a01-alpha.js` is in `edit` and not in `read`. The same check confirmed the empty draft line, the em-dash bullets, a two-symbol scan line `edit/s00.js:4: class Widget` / `edit/s00.js:9: function draw`, a symbol-name edit hit, a file that imports an edit path as `read`, and `task.includes(path)` for `ab/cd.js`. `index.js`'s `draftTaskMap` is the same function.

## Files changed

Commit `54b37cb5aac2f33748621805273deee2adf0fc37` `feat: draft read, edit, and scan marks from the project map`

- `src/agent/task-map.js`
- `test/task-map.test.js`
- `index.js`

The team run was not changed. Pre-existing edits (README, CLI, config, other tests, sketches) were not staged. Not pushed.

## Self-review findings

- Caps apply after the path sort, and only the 12 kept edit paths feed read and scan.
- A path already in `edit` is not also `read` or `scan`. A path kept as `read` is not also `scan`.
- `filterTaskMap` drops a missing path, a role outside `read` / `edit` / `scan`, a non-string reason, a non-array, and a null map.
- `formatScan` emits lines only for marks whose role is `scan`.

## Concerns

- `formatDraft`, `formatMarks`, and `formatScan` are not asserted by the two committed tests. The brief specified that test file. The follow-up check above matched the brief's text.
