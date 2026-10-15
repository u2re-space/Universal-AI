# Project Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index the working directory in `.ai/map.json` and in RAM so search and team runs can find files, symbols, and read/edit/scan marks without walking the tree.

**Architecture:** `src/agent/map.js` builds the JSON index, keeps path and symbol tables plus a 32 MiB text LRU in process memory, and answers `search_files`. Rules in `src/agent/task-map.js` draft marks. The planner confirms them on `PLAN_SCHEMA.taskMap`. Writes update one map entry and still succeed when that update fails.

**Tech Stack:** Node.js 26 ESM, `node:fs`, `node:test`. No parser package and no new dependencies.

## Global Constraints

- Node.js built-in modules only.
- Map path is `<working directory>/.ai/map.json`. `.gitignore` gains `.ai/`. The indexer skips `.ai` and `NOISY_DIRS`.
- Map `version` is 1. A missing file, invalid JSON, or another version is rebuilt at `ai map` and at the start of `ai run`, not on every write.
- Indexed files are UTF-8 text of at most 1 MiB. Binary files, larger files, and protected secret names are omitted.
- Symbols for `.js` `.mjs` `.cjs` `.ts` `.tsx` `.py` `.go` `.rs` only. Other indexed files have empty `symbols` and `imports`.
- `kind` is `function`, `class`, or `export`. One symbol per line. An `export` or `pub` form wins over `function` or `class` on that line.
- `imports` are other keys in `files`. Go and Rust files have `"imports": []`.
- RAM cache is per working directory, reused while the stored map modification time matches. Text LRU cap is 32 MiB (33554432 bytes). A file larger than that is read and not stored.
- `search_files` `scope` is `path`, `symbol`, `content`, or `all`. Missing scope means `all`. Any other value is a tool error and does not scan.
- When the map cannot be loaded, content search uses the existing walk and the first line is `Карта проекта недоступна; поиск по дереву.`
- Draft caps are 12 `edit`, 20 `read`, 40 `scan`. Ties break by path, ascending.
- A write outside `edit` still runs. The tool result starts with `Не в карте правок (<path>): `.
- `list_files` stays as it is.
- `ai map` does not require `OPENAI_API_KEY`. Any subcommand other than `path` is exit 2.

---



### Task 4: Task-map draft and filter

**Files:**
- Create: `src/agent/task-map.js`
- Create: `test/task-map.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: a `ProjectMap`-like `{ files: Map }` whose records have `imports` and `symbols`.
- Produces:
  - `draftTaskMap(task, projectMap) → { edit, read, scan }`, each an array of `{ path, role, reason }`
  - `filterTaskMap(entries, projectMap) → { path, role, reason }[]`
  - `formatDraft(draft) → string`
  - `formatMarks(marks) → string`
  - `formatScan(projectMap, marks) → string`

- [ ] **Step 1: Write the failing test**

Create `test/task-map.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftTaskMap, filterTaskMap } from '../src/agent/task-map.js';

function projectMap(files) {
  return { files: new Map(Object.entries(files)) };
}

test('draft caps edit, read, and scan and sorts paths', () => {
  const files = {};
  const imports = [];
  for (let i = 1; i <= 13; i++) {
    const name = `edit/a${String(i).padStart(2, '0')}-alpha.js`;
    files[name] = { imports: [], symbols: [] };
  }
  for (let i = 0; i < 21; i++) {
    const name = `read/r${String(i).padStart(2, '0')}.js`;
    files[name] = { imports: [], symbols: [] };
    imports.push(name);
  }
  files['edit/a01-alpha.js'].imports = imports;
  for (let i = 0; i < 41; i++) files[`edit/s${String(i).padStart(2, '0')}.js`] = { imports: [], symbols: [] };
  const draft = draftTaskMap('touch alpha', projectMap(files));
  assert.equal(draft.edit.length, 12);
  assert.deepEqual(draft.edit.map((item) => item.path), [...draft.edit.map((item) => item.path)].sort());
  assert.equal(draft.read.length, 20);
  assert.equal(draft.scan.length, 40);
  assert.equal(draft.scan.every((item) => item.path.startsWith('edit/')), true);
});

test('filterTaskMap drops a path that is not in the map', () => {
  const map = projectMap({ 'src/a.js': { imports: [], symbols: [{ name: 'a', kind: 'function', line: 1 }] } });
  const marks = filterTaskMap([
    { path: 'src/a.js', role: 'read', reason: 'called' },
    { path: 'missing.js', role: 'edit', reason: 'nope' },
    { path: 'src/a.js', role: 'other', reason: 'bad' },
  ], map);
  assert.deepEqual(marks, [{ path: 'src/a.js', role: 'read', reason: 'called' }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/task-map.test.js`

Expected: FAIL. Cannot find `src/agent/task-map.js`.

- [ ] **Step 3: Write the implementation**

Create `src/agent/task-map.js`.

Words: `task.toLowerCase().split(/[^0-9a-zа-яё]+/i).filter((word) => word.length >= 3)`. A path is also an edit hit when `task.includes(path)`.

Edit hits: a path segment, the full lower-case path, or a lower-case symbol name contains a word, or the task contains the path. Sort ascending, take 12. `reason` is `совпадение с задачей`.

Read hits: not already edit. Record `imports` includes an edit path, or an edit record's `imports` includes this path. Sort, take 20. `reason` is `импорт рядом с правкой`.

Scan hits: same directory (`path.posix.dirname`) as an edit path, not edit or read. Sort, take 40. `reason` is `тот же каталог`.

`formatDraft`: when all three arrays are empty, return `Task map draft: (empty)`. Otherwise:

```text
Task map draft:
- edit <path> — <reason>
- read <path> — <reason>
- scan <path> — <reason>
```

`filterTaskMap`: non-array becomes `[]`. Keep entries whose `role` is `read`, `edit`, or `scan`, whose `path` is a key in `projectMap.files`, and whose `reason` is a string. `null` projectMap yields `[]`.

`formatMarks` is the same bullet list with header `Task map:`, or `Task map: (empty)`.

`formatScan` joins `path:line: kind name` for symbols of marks whose role is `scan`. Empty string when there are none.

Append to `index.js`:

```javascript
export { draftTaskMap } from './src/agent/task-map.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/task-map.test.js`

Expected: PASS, 2 tests. `read/r00.js` through `read/r19.js` are the read hits because `edit/a01-alpha.js` is the first edit path and lists those imports. `edit/a01-alpha.js` stays in `edit`, so it is not also `read`.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/task-map.js test/task-map.test.js index.js
git commit -m "feat: draft read, edit, and scan marks from the project map"
```

