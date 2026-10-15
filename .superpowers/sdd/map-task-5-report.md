# Task 5 report: Planner confirmation and the team run

## What you implemented

`PLAN_SCHEMA.taskMap` is a required array of `{ path, role, reason }`. `role` is `read`, `edit`, or `scan`. The array description is `Final read/edit/scan marks. Empty array when nothing applies.` Each `reason` description is `Why this file has this role.` `object()` marks `path`, `role`, and `reason` required and rejects extra properties.

`run()` calls `ensureProjectMap(ctx.cwd)` before the team or single flow. A build error is already `{ error }` from `ensureProjectMap`. The run warns `Карта проекта не построена: …` and continues.

`runTeam` loads the map, renders `formatDraft(draftTaskMap(task, projectMap))` into the planner text, then filters `plan.taskMap`. Kept marks go into shared context as `Task map` (priority 8). Scan symbol lines go into `Symbols (scan)` (priority 4) when `formatScan` is non-empty. The worker toolset reads `editPaths: () => taskMarks.edit`. Collector and reviewer omit `editPaths`.

A non-trivial plan collects when `filesOfInterest`, `searchQueries`, or `questionsForCollector` is non-empty, or when any kept mark is `read` or `edit`. The collector brief lists those read and edit lines before files of interest.

`createToolset({ editPaths = () => null })` prefixes a successful `write_file`, `replace_text`, or `delete_file` result with `Не в карте правок (<path>): ` when the set is non-null and does not contain `result.rel`. The write still happens. A null set leaves the result unchanged.

`loadProjectMap(root)` does not rebuild. A direct `runTeam` (this task's test) has no `.ai/map.json` yet, so `filterTaskMap` would drop `src/sum.js` and the collector would not run. When `loadProjectMap` returns null, `runTeam` calls `ensureProjectMap` and uses that map unless it returned `{ error }`. `ai run` still ensures the map first; the second load hits the existing file.

## What you tested and test results

RED, before `src/agent/team.js` and `src/agent/tools.js` changed.

Command: `node --test --test-timeout=60000 test/team.test.js`

Exit code 1. 8 passed, 1 failed. The new test reached `result.status === 'completed'` and then threw because no collector request existed:

```
✖ team run puts the confirmed read file in the collector brief (10.0533ms)
  TypeError: Cannot read properties of undefined (reading 'input')
      at TestContext.<anonymous> (file:///C:/Projects/Universal-AI/test/team.test.js:272:26)
```

`filesOfInterest`, `searchQueries`, and `questionsForCollector` were empty, and `taskMap` was ignored, so the collector stage did not run.

Command: `node --test --test-timeout=60000 test/map.test.js`

Exit code 1. The new subtest failed because `editPaths` was ignored. The file was still written:

```
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^Не в карте правок \(extra\.js\): /. Input:

'Создан extra.js (24 B).'
```

The parent `project map` suite failed with that subtest. The other eight subtests passed.

GREEN, after the implementation, on the committed code.

Command: `node --test --test-timeout=60000 test/team.test.js test/map.test.js test/task-map.test.js`

```
✔ project map (43.99ms)
✔ draft caps edit, read, and scan and sorts paths (2.286ms)
✔ filterTaskMap drops a path that is not in the map (0.2075ms)
✔ resolveRole merges role, default role and top-level settings; --role flags parse (8.1991ms)
✔ memory store: remember / recall (FTS) / list / forget / tasks / file summaries (5.4661ms)
✔ shared context clips low-priority sections to fit the byte budget (0.5854ms)
✔ diff helpers produce a hunk and a bounded change description (2.5118ms)
✔ team run: planner → collector → worker steps → reviewer (revise → fix → accept) → memory (65.7731ms)
✔ team run: trivial plan skips collector and review; worker failure marks the run incomplete (7.2302ms)
✔ team run stops on budget and reports the stage (6.9613ms)
✔ role runner: vision delegation and file summaries with cache (12.3242ms)
✔ team run puts the confirmed read file in the collector brief (9.3144ms)
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 218.4019
```

Exit code 0.

An isolated run of `team run puts the confirmed read file in the collector brief` (fresh temp root, no map from an earlier test) also passed. A print of the collector text, removed before the commit, showed both of these lines and did not contain `missing.js`:

```
## Task map
Task map:
- read src/sum.js — функция sum

# Collector brief
Task map (read/edit):
- read src/sum.js — функция sum
```

## Files changed

Commit `f271c477cbc56032dc9528c4f5ca99bf54e26b7c` `feat: confirm read, edit, and scan marks in the team plan`

- `src/agent/schemas.js`
- `src/agent/team.js`
- `src/agent/tools.js`
- `src/commands/run.js`
- `test/team.test.js` (includes pre-existing model-name hunks: `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-luna-vision`, `gpt-6-luna-nano`)
- `test/map.test.js`

`src/commands/run.js` had no pre-existing hunks. README, `cli.js`, `config.js`, and the other dirty files were not staged. Not pushed.

## Self-review findings

- `mkdir` was added to the existing `node:fs/promises` import in `test/team.test.js`. `readFile` was added to the import in `test/map.test.js`.
- Filtered marks drop `missing.js`. The collector prompt keeps `read src/sum.js — функция sum`.
- A trivial plan still skips the collector. The budget test still stops with status `budget`.
- `editPaths` defaults to `() => null`. An empty `Set` is non-null, so every successful write, replace, or delete is labeled. A path in the set is not labeled.
- The label is applied only after the filesystem operation succeeds. `updateProjectMapPath` still runs, and a map-update failure still warns without failing the write.

## Concerns

- None that leave the tests failing. `runTeam` calls `ensureProjectMap` when `loadProjectMap` returns null. The brief's snippet only called `loadProjectMap`. Without the rebuild, `filterTaskMap` drops every path and the new team test still fails.
