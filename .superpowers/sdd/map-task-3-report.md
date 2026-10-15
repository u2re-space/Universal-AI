# Task 3 report: Update one path after an edit

## What you implemented

After a successful `write_file`, `replace_text`, or `delete_file` in `src/agent/tools.js`, the handler calls `updateProjectMapPath(root, result.rel)`. The file edit stays outside that `try`. If the update throws, `notify` emits `{ type: 'warning', message: 'Карта проекта не обновлена: …' }` and the handler still returns the success `output` and `summary` computed from the edit. `make_dir` is unchanged.

`updateProjectMapPath` is the Task 1 function. A missing `.ai/map.json` returns without writing. No change to `src/agent/map.js`.

## What you tested and test results

Command: `node --test --test-timeout=60000 test/map.test.js`

The brief expected 5 tests. Node counts the parent plus every subtest. Tasks 1 and 2 already left 7 subtests (8 tests with the parent). This task added one subtest, so the summary is 9 passed, 0 failed.

Earlier subtests delete `widget.py` and `buildProjectMap` drops it from the map. The new subtest checks `loadProjectMap` first. When `widget.py` is absent it writes `class Widget:\n    pass\n` and calls `updateProjectMapPath(root, 'widget.py')` before `write_file`. The three assertions from the brief are unchanged.

## TDD evidence

### RED

The failing subtest was appended, and `createToolset` was imported, before `src/agent/tools.js` was edited.

Command: `node --test --test-timeout=60000 test/map.test.js`

```
▶ project map
  ✔ build indexes source symbols and imports, and skips binary files and node_modules (18.1731ms)
  ✔ a second load with the same modification time does not observe a rewritten map file (1.6517ms)
  ✔ updateProjectMapPath replaces one file and keeps the others (2.6363ms)
  ✔ deleting an imported file removes it from other files' imports (2.5259ms)
  ✔ a content search skips a map path whose file is gone and still returns other hits (1.7766ms)
  ✔ a file under .ssh is not indexed (3.8622ms)
  ✔ searchMapped answers path and symbol from RAM and content from the file (1.0699ms)
  ✖ write_file updates the map entry for that path only (3.7676ms)
✖ project map (41.5205ms)
ℹ tests 9
ℹ suites 0
ℹ pass 7
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 99.5087

✖ failing tests:

test at test\map.test.js:89:11
✖ write_file updates the map entry for that path only (3.7676ms)
  TypeError: Cannot read properties of undefined (reading 'symbols')
      at TestContext.<anonymous> (file:///C:/Projects/Universal-AI/test/map.test.js:103:43)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async TestContext.<anonymous> (file:///C:/Projects/Universal-AI/test/map.test.js:89:3)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
```

Exit code 1. `written.ok` had already passed. `loaded.files.get('fresh.js')` was undefined, so `fresh.js` was not in the map. The parent is the second failure because its subtest failed.

### GREEN

`updateProjectMapPath` was wired into the three handlers after that run. The same command was run again.

```
▶ project map
  ✔ build indexes source symbols and imports, and skips binary files and node_modules (16.8416ms)
  ✔ a second load with the same modification time does not observe a rewritten map file (1.5132ms)
  ✔ updateProjectMapPath replaces one file and keeps the others (1.9847ms)
  ✔ deleting an imported file removes it from other files' imports (1.673ms)
  ✔ a content search skips a map path whose file is gone and still returns other hits (1.3937ms)
  ✔ a file under .ssh is not indexed (3.1161ms)
  ✔ searchMapped answers path and symbol from RAM and content from the file (1.0599ms)
  ✔ write_file updates the map entry for that path only (5.6544ms)
✔ project map (39.1422ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 95.9244
```

Exit code 0. `fresh.js` has a symbol named `fresh`, `widget.py` is still in the map, and no `warning` event was emitted.

## Files changed

Commit `e31791151cd743d2498166a7636f89340154f678` `feat: refresh one map entry after a file edit`

- `src/agent/tools.js`
- `test/map.test.js`

`src/agent/map.js` was not changed. Pre-existing edits (README, CLI, config, other tests, sketches) were not staged. Not pushed.

## Self-review findings

- The update runs only after `writeTextFile`, `replaceInFile`, or `deleteFile` returns, using that result's `rel`.
- A thrown update does not replace `output` or `summary`.
- `make_dir` does not refresh the map.

## Concerns

- The brief's "PASS, 5 tests" count does not match this tree. Node reports 9 because the parent and the Task 1 and Task 2 subtests are already in the file. All 9 passed.
- The new subtest covers `write_file` only. `replace_text` and `delete_file` use the same update call. The warning path when `updateProjectMapPath` throws is not asserted.
