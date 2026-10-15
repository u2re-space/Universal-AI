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

