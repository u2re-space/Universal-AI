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



### Task 1: Build, load, and cache the map

**Files:**
- Create: `src/agent/map.js`
- Create: `test/map.test.js`
- Modify: `src/agent/paths.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `NOISY_DIRS` and `isProtectedFileName(name)` from `src/agent/paths.js`.
- Produces:
  - `buildProjectMap(root) → Promise<ProjectMap>`
  - `loadProjectMap(root, { rebuild = false } = {}) → Promise<ProjectMap|null>`
  - `ensureProjectMap(root) → Promise<ProjectMap|{ error: Error }>`
  - `updateProjectMapPath(root, rel) → Promise<void>`
  - `searchMapped(projectMap, { query, dir = '.', scope = 'all', regex = false, maxResults = 60 }) → Promise<{ text, count }>`
  - `projectMapFile(root) → string`
  - `countProjectMap(projectMap) → { files: number, symbols: number }`
  - `ProjectMap` is `{ map, files: Map, symbols: Map, mtimeMs, readText(rel): Promise<string> }`
  - `files` values are `{ bytes, mtimeMs, imports: string[], symbols: { name, kind, line }[] }`
  - `symbols` keys are lower-case names. Values are `{ path, kind, line }[]`.

- [ ] **Step 1: Write the failing test**

Create `test/map.test.js`. The cases share one directory and must run in order. Put them inside a single parent and `await` each subtest. Tasks 2 and 3 add more `await t.test(...)` calls in that same parent, not new top-level `test()` calls.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { buildProjectMap, loadProjectMap, updateProjectMapPath, projectMapFile } from '../src/agent/map.js';

test('project map', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-map-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  await t.test('build indexes source symbols and imports, and skips binary files and node_modules', async () => {
    await mkdir(path.join(root, 'util'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'util', 'text.js'), 'export function clip() {}\n');
    await writeFile(path.join(root, 'lib.js'), "import { clip } from './util/text.js';\nexport function hello() {}\n");
    await writeFile(path.join(root, 'widget.py'), 'class Widget:\n    pass\n');
    await writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'function hidden() {}\n');
    const built = await buildProjectMap(root);
    assert.equal(built.files.has('lib.js'), true);
    assert.equal(built.files.has('widget.py'), true);
    assert.equal(built.files.has('blob.bin'), false);
    assert.equal(built.files.has('node_modules/pkg/index.js'), false);
    assert.deepEqual(built.files.get('lib.js').imports, ['util/text.js']);
    assert.ok(built.files.get('lib.js').symbols.some((symbol) => symbol.name === 'hello' && symbol.kind === 'export'));
    assert.ok(built.files.get('widget.py').symbols.some((symbol) => symbol.name === 'Widget' && symbol.kind === 'class'));
  });

  await t.test('a second load with the same modification time does not observe a rewritten map file', async () => {
    const first = await loadProjectMap(root);
    assert.equal(first.files.has('lib.js'), true);
    const file = projectMapFile(root);
    const before = await stat(file);
    await writeFile(file, '{"version":1,"builtAt":"x","files":{}}\n');
    await utimes(file, before.atime, before.mtime);
    const second = await loadProjectMap(root);
    assert.equal(second.files.has('lib.js'), true);
    assert.equal(second, first);
  });

  await t.test('updateProjectMapPath replaces one file and keeps the others', async () => {
    await writeFile(path.join(root, 'lib.js'), "import { clip } from './util/text.js';\nexport function goodbye() {}\n");
    await updateProjectMapPath(root, 'lib.js');
    const loaded = await loadProjectMap(root);
    assert.ok(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'goodbye'));
    assert.equal(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'hello'), false);
    assert.equal(loaded.files.has('widget.py'), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/map.test.js`

Expected: FAIL. Cannot find `src/agent/map.js`.

- [ ] **Step 3: Write the implementation**

In `src/agent/paths.js`, export the existing secret-file check without changing its regex:

```javascript
export function isProtectedFileName(name) {
  return PROTECTED_FILES.test(name);
}
```

Create `src/agent/map.js` with the behavior below. Use `readdir`, `readFile`, `writeFile`, `mkdir`, `stat`, `open` from `node:fs/promises`.

`projectMapFile(root)` returns `path.join(root, '.ai', 'map.json')`.

`TEXT_CACHE_BYTES` is `32 * 1024 * 1024`. `MAX_INDEX_BYTES` is `1024 * 1024`.

Skip a directory whose name matches `NOISY_DIRS` or is `.ai`. Skip a file whose name matches `isProtectedFileName`. Skip a file whose size is greater than `MAX_INDEX_BYTES`, whose first 8192 bytes contain a 0, or which is not fatal-UTF-8.

`extractSymbols(rel, text)` returns `{ symbols, importSpecs }`.

JavaScript and TypeScript (`function` / `class` / `export`), checked in this order on each line:

- `export function name`, `export class name`, `export const name`, `export { name }` → `{ name, kind: 'export' }`. For a brace list, use the first name and ignore the rest of that line.
- `function name` → `function`
- `class name` → `class`

Python: `def name` → `function`, `class name` → `class`.

Go: `func name` → `function` (skip the receiver if present: `func (r T) name`), `type name struct` → `class`.

Rust, `pub` forms first: `pub fn` / `pub struct` / `pub enum` → `export`; then `fn` → `function`; `struct` / `enum` → `class`.

`importSpecs` for JavaScript and TypeScript are the relative strings inside `from '…'`, `import '…'`, and `require('…')` when the string starts with `.`. Python specs are `{ dots, name }` from `from .name import` and `from ..name import`. Go and Rust add no import specs.

After every file is known, resolve imports. Join the specifier to the file's directory. Try the path as written, then with `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, and `/index.js`. Keep candidates that are keys. Python: `dots.length === 1` stays in the file's directory; each extra dot moves to the parent; the file is `name.py`. Drop candidates that are not keys. Sort and unique the kept keys.

`buildProjectMap` walks `root`, writes the JSON (`version`, `builtAt`, `files`), stats the file, and installs the RAM entry. Installing replaces any previous entry for that `root`.

The RAM entry holds `map`, `files` (`Map`), `symbols` (`Map` of lower-case name → `{ path, kind, line }[]`), `mtimeMs`, an LRU `Map`, and `readText(rel)`. `readText` stats the file. On the same path and `mtimeMs`, it returns the cached string and moves that key to the most recently used end. Otherwise it reads UTF-8 text. It stores the text only when `Buffer.byteLength(text) <= TEXT_CACHE_BYTES`. Before storing, it deletes the oldest keys until the sum of stored bytes plus the new text is at most `TEXT_CACHE_BYTES`.

`loadProjectMap(root, { rebuild = false })`:

- If the RAM entry exists and `stat(projectMapFile(root)).mtimeMs` equals the stored `mtimeMs`, return that same object.
- If the file is missing, invalid JSON, or `version !== 1`: when `rebuild` is true, call `buildProjectMap`; otherwise return `null`.
- A valid file is parsed, installed with that stat `mtimeMs`, and returned.

`ensureProjectMap(root)` calls `loadProjectMap(root, { rebuild: true })` and on throw returns `{ error }`.

`updateProjectMapPath(root, rel)` returns immediately when `projectMapFile(root)` does not exist. Otherwise it loads the map with `rebuild: false`, reindexes or deletes that one key using the same skip rules, writes the JSON, stats the new modification time, and installs a new RAM entry with that time. `rel` is stored with forward slashes.

`searchMapped` throws `Пустой запрос поиска.` on an empty query. `scope` other than the four names throws `scope: path, symbol, content или all.` A missing scope is `all`.

- `path`: keys under `dir` whose lower-case path contains the lower-case query. One line per key, the key itself. No `readText`.
- `symbol`: symbols whose lower-case name contains the lower-case query, files under `dir`. Line format `path:line: kind name`. No `readText`.
- `content`: `readText` for indexed files under `dir`. A line matches when `regex` is true and `new RegExp(query, 'i')` matches, otherwise when the lower-case line contains the lower-case query. Format `path:line: trimmed` with the text cut at 240 characters.
- `all`: path lines, then symbol lines, then content lines. Content files are the paths that already appeared. When no path or symbol line was produced, content covers every indexed file under `dir`.

Stop at `maxResults`. Append `\n…результаты усечены (N)` when truncated. `dir` of `.` is the whole map. Another `dir` includes that path and paths that start with `dir + '/'`.

`countProjectMap(projectMap)` returns `{ files: projectMap.files.size, symbols: sum of symbol array lengths }`.

Append to `index.js`:

```javascript
export { loadProjectMap } from './src/agent/map.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/map.test.js`

Expected: PASS, 3 tests. The second test returns the identical object, so a rewritten file with the old modification time is invisible.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/map.js src/agent/paths.js test/map.test.js index.js
git commit -m "feat: index project files and symbols in .ai/map.json"
```

