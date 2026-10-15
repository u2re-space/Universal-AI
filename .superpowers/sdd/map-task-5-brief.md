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

