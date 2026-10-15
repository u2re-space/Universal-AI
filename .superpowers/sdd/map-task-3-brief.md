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

