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

## File structure

- Create `src/agent/map.js` — build, load, RAM tables, LRU, one-path update, mapped search.
- Create `src/agent/task-map.js` — draft and filter.
- Create `src/commands/map.js` — `ai map` and `ai map path`.
- Create `test/map.test.js`, `test/task-map.test.js`.
- Modify `src/agent/paths.js` — export `isProtectedFileName`.
- Modify `src/agent/tools.js` — `scope`, map search, one-path update, edit label.
- Modify `src/agent/schemas.js` — `taskMap`.
- Modify `src/agent/team.js` — draft, planner prompt, collector brief, scan section, worker marks.
- Modify `src/commands/run.js` — ensure the map at the start of `ai run`.
- Modify `src/cli.js`, `index.js`, `.gitignore`, `README.md`.
- Modify `test/cli.test.js`, `test/team.test.js`.

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

### Task 2: Search through the map

**Files:**
- Modify: `src/agent/tools.js`
- Modify: `test/map.test.js`

**Interfaces:**
- Consumes: `loadProjectMap` and `searchMapped` from Task 1. `searchFiles` in `src/agent/fs-tools.js` stays the fallback walk.
- Produces: `search_files` arguments include required `scope` (`path` | `symbol` | `content` | `all`). The handler treats a missing `scope` as `all`.

- [ ] **Step 1: Write the failing test**

Append an awaited subtest inside the `project map` parent from Task 1. `root` is that parent's directory.

```javascript
  await t.test('searchMapped answers path and symbol from RAM and content from the file', async () => {
    const projectMap = await loadProjectMap(root);
    const byPath = await searchMapped(projectMap, { query: 'lib.js', scope: 'path' });
    assert.match(byPath.text, /^lib\.js$/m);
    const bySymbol = await searchMapped(projectMap, { query: 'goodbye', scope: 'symbol' });
    assert.match(bySymbol.text, /lib\.js:\d+: export goodbye/);
    const byContent = await searchMapped(projectMap, { query: 'clip', scope: 'content' });
    assert.match(byContent.text, /lib\.js:\d+:/);
    const again = await searchMapped(projectMap, { query: 'clip', scope: 'content' });
    assert.equal(again.text, byContent.text);
  });
```

Add `searchMapped` to the import from `../src/agent/map.js`. The symbol line uses the kind and name from Task 1 (`export goodbye`). Content still contains `clip` because the import line remains.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/map.test.js`

Expected: FAIL on `searchMapped` if Task 1 did not export it yet, or PASS if Task 1 already implemented it. If it passes, keep the test and continue to the tool schema.

- [ ] **Step 3: Wire `search_files`**

In `TOOL_SPECS.search_files`, change the description to say the search uses the project map when `.ai/map.json` is present, and add a required property:

```javascript
scope: { type: 'string', enum: ['path', 'symbol', 'content', 'all'], description: 'path and symbol read the map only. content reads file text. all (use this unless a narrower scope is enough) returns path, then symbol, then content.' },
```

`schema()` already puts every key in `required`, so `scope` becomes required.

In the `search_files` handler:

```javascript
async search_files(args) {
  const scope = args.scope ?? 'all';
  if (!['path', 'symbol', 'content', 'all'].includes(scope)) throw new Error('scope: path, symbol, content или all.');
  const projectMap = await loadProjectMap(root);
  if (projectMap) {
    const result = await searchMapped(projectMap, { query: args.query, dir: args.path || '.', scope, regex: Boolean(args.regex), maxResults: limits.maxSearchResults });
    return { output: result.text, summary: `${result.count} совпадений` };
  }
  const result = await searchFiles({ root, query: args.query, dir: args.path || '.', regex: Boolean(args.regex), maxResults: limits.maxSearchResults });
  return { output: `Карта проекта недоступна; поиск по дереву.\n${result.text}`, summary: `${result.count} совпадений` };
},
```

Import `loadProjectMap` and `searchMapped` from `./map.js`. Leave the `searchFiles` import in place for the fallback.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/map.test.js`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/tools.js test/map.test.js src/agent/map.js
git commit -m "feat: search the project map before reading file bytes"
```

### Task 3: Update one path after an edit

**Files:**
- Modify: `src/agent/tools.js`
- Modify: `test/map.test.js`

**Interfaces:**
- Consumes: `updateProjectMapPath(root, rel)` from Task 1.
- Produces: a successful `write_file`, `replace_text`, or `delete_file` calls `updateProjectMapPath`. A throw becomes a `warning` event and does not change the tool's success result. No map file means the update returns without writing.

- [ ] **Step 1: Write the failing test**

Append an awaited subtest inside the same `project map` parent. Import `createToolset` from `../src/agent/tools.js`.

```javascript
  await t.test('write_file updates the map entry for that path only', async () => {
    const events = [];
    const toolset = createToolset({
      root, config: { limits: { maxFileWriteBytes: 1024 * 1024, maxFileReadBytes: 1024 * 1024, maxSearchResults: 20, maxListEntries: 50, maxCommandOutputBytes: 1000, commandTimeoutMs: 1000, maxFetchBytes: 1000, maxImageBytes: 1000 }, tools: { fs: true }, shell: null, image: {} },
      names: ['write_file'], approvalLevel: 'all', emit: (event) => events.push(event),
    });
    const written = await toolset.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'fresh.js', content: 'export function fresh() {}\n', overwrite: true }) });
    assert.equal(written.ok !== false, true);
    const loaded = await loadProjectMap(root);
    assert.ok(loaded.files.get('fresh.js').symbols.some((symbol) => symbol.name === 'fresh'));
    assert.equal(loaded.files.has('widget.py'), true);
    assert.equal(events.some((event) => event.type === 'warning'), false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/map.test.js`

Expected: FAIL. `fresh.js` is not in the map.

- [ ] **Step 3: Call the one-path update**

After each successful `write_file`, `replace_text`, and `delete_file` result is computed, and before `return`:

```javascript
try { await updateProjectMapPath(root, result.rel); }
catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
```

Use the `result.rel` from that handler. Do not wrap the file edit itself in this try. An update failure leaves `output` unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/map.test.js`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/tools.js test/map.test.js
git commit -m "feat: refresh one map entry after a file edit"
```

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

### Task 5: Planner confirmation and the team run

**Files:**
- Modify: `src/agent/schemas.js`
- Modify: `src/agent/team.js`
- Modify: `src/agent/tools.js`
- Modify: `src/commands/run.js`
- Modify: `test/team.test.js`
- Modify: `test/map.test.js`

**Interfaces:**
- Consumes: `ensureProjectMap` from Task 1 and `draftTaskMap`, `filterTaskMap`, `formatDraft`, `formatMarks`, `formatScan` from Task 4.
- Produces: `PLAN_SCHEMA.taskMap` as specified. `run()` ensures a map before the team or single flow. `createToolset({ editPaths })` where `editPaths` is `() => Set|null`.

- [ ] **Step 1: Write the failing test**

Append to `test/team.test.js` inside the existing mock-server setup. The planner response must include `taskMap`. Reuse `baseConfig`, `client`, `root`, and `roleOf`.

```javascript
test('team run puts the confirmed read file in the collector brief', async () => {
  await writeFile(path.join(root, 'src', 'sum.js'), 'export function sum(a, b) { return a + b; }\n').catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'sum.js'), 'export function sum(a, b) { return a + b; }\n');
  });
  const seen = [];
  script = (body) => {
    const role = roleOf(body);
    seen.push(body);
    if (role === 'planner') return { text: JSON.stringify({ summary: 's', complexity: 'normal', steps: [{ goal: 'прочитать', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [], taskMap: [{ path: 'src/sum.js', role: 'read', reason: 'функция sum' }, { path: 'missing.js', role: 'edit', reason: 'нет файла' }] }) };
    if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [], conventions: [], notes: '' }) };
    if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
    return { text: 'ok' };
  };
  const result = await runTeam({ client: client(), config: baseConfig(), ledger: createLedger(), task: 'sum', root, approvalLevel: 'read', emit() {} });
  assert.equal(result.status, 'completed', result.error?.message);
  const collector = seen.find((body) => roleOf(body) === 'collector');
  assert.match(collector.input[0].content[0].text, /src\/sum\.js/);
  assert.equal(/missing\.js/.test(collector.input[0].content[0].text), false);
});
```

`baseConfig()` in this file already points `baseURL` at the mock server. `roleOf` classifies `context_report` as `collector`. A normal plan with an empty `filesOfInterest` still collects because the confirmed map has a `read` file.

Write `src/sum.js` with `mkdir` from the existing `node:fs/promises` import at the top of `test/team.test.js` if `mkdir` is already imported. The file imports `mkdir`? It imports `mkdtemp, readFile, rm, writeFile`. Add `mkdir` to that import instead of a dynamic import. Use:

```javascript
await mkdir(path.join(root, 'src'), { recursive: true });
await writeFile(path.join(root, 'src', 'sum.js'), 'export function sum(a, b) { return a + b; }\n');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/team.test.js`

Expected: FAIL. The collector stage does not run, or its prompt has no `src/sum.js`, because `filesOfInterest` is empty and `taskMap` is ignored.

Also append this awaited subtest to the `project map` parent. It fails until `editPaths` prefixes the tool result.

```javascript
  await t.test('a write outside the edit set is labeled and still writes', async () => {
    const toolset = createToolset({
      root, config: { limits: { maxFileWriteBytes: 1024 * 1024, maxFileReadBytes: 1024, maxSearchResults: 20, maxListEntries: 50, maxCommandOutputBytes: 1000, commandTimeoutMs: 1000, maxFetchBytes: 1000, maxImageBytes: 1000 }, tools: { fs: true }, shell: null, image: {} },
      names: ['write_file'], approvalLevel: 'all', editPaths: () => new Set(['widget.py']),
    });
    const written = await toolset.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'extra.js', content: 'export const extra = 1;\n', overwrite: true }) });
    assert.match(written.output, /^Не в карте правок \(extra\.js\): /);
    assert.equal(await readFile(path.join(root, 'extra.js'), 'utf8'), 'export const extra = 1;\n');
  });
```

Add `readFile` to the `node:fs/promises` import in `test/map.test.js`.

- [ ] **Step 3: Confirm marks in the team run**

Add `taskMap` to `PLAN_SCHEMA` with the object from the spec. `object()` marks it required. Description on the array: `Final read/edit/scan marks. Empty array when nothing applies.` Each `reason` description: `Why this file has this role.`

In `createToolset`, add parameter `editPaths = () => null`. After a successful write, replace, or delete, prefix `output` when the set is non-null and does not contain `result.rel`:

```javascript
const allowed = typeof editPaths === 'function' ? editPaths() : editPaths;
if (allowed && !allowed.has(result.rel)) output = `Не в карте правок (${result.rel}): ${output}`;
```

`result.rel` uses forward slashes from `resolveInside`.

In `run()` in `src/commands/run.js`, before `runTeamFlow` / `runSingleFlow`:

```javascript
const ensured = await ensureProjectMap(ctx.cwd);
if (ensured?.error) renderer.line('warn', `Карта проекта не построена: ${ensured.error.message}`);
```

Import `ensureProjectMap` from `../agent/map.js`. A thrown build is already converted to `{ error }` by `ensureProjectMap`. Do not abort the run.

In `runTeam`, before the planner call:

```javascript
const projectMap = await loadProjectMap(root);
const draft = formatDraft(draftTaskMap(task, projectMap));
```

Pass `` `${ctx.render({ maxBytes })}\n\n${draft}\n\n# Task\n${task}` `` as the planner text.

Hold the edit set in an object created before `workerTools`:

```javascript
const taskMarks = { edit: null };
```

Pass `editPaths: () => taskMarks.edit` into the worker `createToolset` call. Collector and reviewer omit it.

After `plan.steps` is normalized:

```javascript
const marks = filterTaskMap(plan.taskMap, projectMap);
taskMarks.edit = new Set(marks.filter((item) => item.role === 'edit').map((item) => item.path));
ctx.set('taskMap', 'Task map', formatMarks(marks), { priority: 8 });
const scan = formatScan(projectMap, marks);
if (scan) ctx.set('scan', 'Symbols (scan)', scan, { priority: 4 });
```

Change `wantsContext` so a non-trivial plan also collects when any mark has role `read` or `edit`.

Collector brief, with the task-map lines first:

```javascript
const focus = marks.filter((item) => item.role === 'read' || item.role === 'edit').map((item) => `${item.role} ${item.path} — ${item.reason}`);
const brief = `# Collector brief\nTask map (read/edit):\n${bullets(focus)}\nFiles of interest:\n${bullets(plan.filesOfInterest)}\nSearch queries:\n${bullets(plan.searchQueries)}\nQuestions to answer:\n${bullets(plan.questionsForCollector)}`;
```

`marks` must be in scope for the collector. Declare `let marks = []` next to `taskMarks` and assign it after the plan.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/team.test.js test/map.test.js test/task-map.test.js`

Expected: PASS. The new team test's collector text matches `src/sum.js` and does not match `missing.js`.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/schemas.js src/agent/team.js src/agent/tools.js src/commands/run.js test/team.test.js test/map.test.js
git commit -m "feat: confirm read, edit, and scan marks in the team plan"
```

### Task 6: `ai map` command and docs

**Files:**
- Create: `src/commands/map.js`
- Modify: `src/cli.js`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `test/cli.test.js`

**Interfaces:**
- Consumes: `buildProjectMap`, `loadProjectMap`, `projectMapFile`, `countProjectMap`.
- Produces: command `map`, not listed in `NEEDS_API_KEY`.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.js`. `runCli` sets `OPENAI_API_KEY` first and then spreads `env`, so the override sticks. `work` is that file's temp directory.

```javascript
test('map writes .ai/map.json without an API key', async () => {
  await writeFile(path.join(work, 'a.js'), 'export function hello() {}\n');
  const built = await runCli(['map'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(built.code, 0, built.stderr);
  const shown = await runCli(['map', 'path'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /\.ai[/\\]map\.json/);
  assert.match(shown.stdout, /файлов: 1/);
  const unknown = await runCli(['map', 'nope'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(unknown.code, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/cli.test.js`

Expected: FAIL. Unknown command `map` exits 2, or the help path rejects it before a map file exists. The assertion `built.code === 0` fails.

- [ ] **Step 3: Add the command**

Create `src/commands/map.js`:

```javascript
import { buildProjectMap, loadProjectMap, projectMapFile, countProjectMap } from '../agent/map.js';
import { UsageError } from './shared.js';

export async function mapCommand(ctx) {
  const { renderer, positionals, cwd } = ctx;
  const sub = positionals[0] ?? '';
  if (positionals.length > 1 || (sub && sub !== 'path')) throw new UsageError('Доступно: ai map | ai map path');
  if (sub === 'path') {
    const projectMap = await loadProjectMap(cwd);
    const counts = projectMap ? countProjectMap(projectMap) : { files: 0, symbols: 0 };
    renderer.write(`${projectMapFile(cwd)}\nфайлов: ${counts.files}, символов: ${counts.symbols}\n`);
    return 0;
  }
  const projectMap = await buildProjectMap(cwd);
  const counts = countProjectMap(projectMap);
  renderer.write(`Карта записана: ${projectMapFile(cwd)}\nфайлов: ${counts.files}, символов: ${counts.symbols}\n`);
  return 0;
}
```

In `src/cli.js`, import `mapCommand` and add `map: mapCommand` to `COMMANDS`. Do not add `map` to `NEEDS_API_KEY` or `DETACHABLE`.

HELP command line:

```text
  ai map [path]                     карта проекта .ai/map.json (файлы и символы). Черновик read/edit/scan подтверждает planner; запись вне edit выполняется и помечается
```

In the tools section of HELP, add: `search_files scope=path|symbol|content|all читает карту проекта.`

Add `.ai/` to `.gitignore` next to `.ai-agent/`.

In `README.md` command block, add:

```text
ai map [path]                индекс файлов и символов (.ai/map.json)
```

Add a short subsection:

```markdown
### Карта проекта

`ai map` строит `.ai/map.json`: пути, время изменения и символы. Повторный поиск читает эту карту из памяти процесса. `ai map path` печатает путь и число файлов и символов.

`search_files` принимает `scope`: `path`, `symbol`, `content` или `all`.

В `ai run` правила намечают файлы как `read`, `edit` или `scan`. Planner подтверждает список. Запись в файл вне `edit` выполняется, а ответ инструмента начинается с пометки, что пути не было в карте правок.
```

- [ ] **Step 4: Run the full suite**

Run: `node --test --test-timeout=60000 "test/*.test.js"`

Expected: PASS, including the previous suite plus `test/map.test.js` and `test/task-map.test.js`. The new CLI test exits 0 for `map` and `map path`, and 2 for `map nope`.

- [ ] **Step 5: Commit**

```powershell
git add src/commands/map.js src/cli.js .gitignore README.md test/cli.test.js
git commit -m "feat: add the ai map command for the project index"
```
