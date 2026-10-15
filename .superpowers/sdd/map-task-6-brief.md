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
