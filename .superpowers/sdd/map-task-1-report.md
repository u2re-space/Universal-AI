# Task 1 report: Build, load, and cache the map

## What you implemented

`src/agent/map.js` builds `.ai/map.json` (`version` 1, `builtAt`, per-file `bytes`, `mtimeMs`, resolved `imports`, and `symbols`) and keeps one RAM entry per working directory. The entry holds `map`, `files`, a lower-case `symbols` table, the map file `mtimeMs`, and `readText` backed by a 32 MiB text LRU.

Indexed files are UTF-8 text at most 1 MiB. The walk skips `.ai` and `NOISY_DIRS`, and skips protected names via `isProtectedFileName`. A file is omitted when it is larger than 1 MiB, its first 8192 bytes contain a NUL, or it is not fatal UTF-8. Symbols are extracted for `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.py`, `.go`, and `.rs`. Other indexed files have empty `symbols` and `imports`. One symbol per line; an `export` or `pub` form wins. Relative JS/TS imports are resolved as written, then `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, and `/index.js`. Python `from .name` / `from ..name` imports become `name.py`. Go and Rust imports stay empty.

`loadProjectMap` returns the same RAM object while the map file's modification time still matches. A missing file, invalid JSON, or `version !== 1` rebuilds only when `rebuild` is true; otherwise it returns `null`. `ensureProjectMap` rebuilds and returns `{ error }` if that throws. `updateProjectMapPath` reindexes or deletes one forward-slash path and installs a new RAM entry. `searchMapped` and `countProjectMap` are implemented. `index.js` exports `loadProjectMap`. `src/agent/paths.js` exports `isProtectedFileName` without changing the secret-name regex.

`search_files` and the team run are not wired.

## What you tested and test results

Command: `node --test --test-timeout=60000 test/map.test.js`

The three required subtests pass. Node counts the parent as well, so the summary is 4 passed, 0 failed. After the timestamp fix below, 20 consecutive runs passed (`failed=0`).

A separate scratch script (not committed) also checked Go/Rust/Python symbols, Python relative imports, `export { first }` keeping only the first name, `./util` resolving to `util/index.js`, skipping `.env`, invalid UTF-8, and a file larger than 1 MiB, path/symbol search without `readText`, content search, `scope: all` limiting content to paths that already matched, truncation text, empty-query and bad-scope errors, deleting one path, two roots not sharing a cache, `version !== 1` returning `null`, and `ensureProjectMap` rebuilding. Those checks passed. LRU eviction past 32 MiB was not executed.

## TDD evidence

### RED

Command: `node --test --test-timeout=60000 test/map.test.js`

Failing output (module not written yet):

```
node:internal/modules/esm/resolve:272
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Projects\Universal-AI\src\agent\map.js' imported from C:\Projects\Universal-AI\test\map.test.js
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
  url: 'file:///C:/Projects/Universal-AI/src/agent/map.js'
}

Node.js v26.5.0
✖ test\map.test.js (41.7015ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 46.9342

✖ failing tests:

test at test\map.test.js:1:1
✖ test\map.test.js (41.7015ms)
  'test failed'
```

### GREEN

Command: `node --test --test-timeout=60000 test/map.test.js`

Passing output:

```
▶ project map
  ✔ build indexes source symbols and imports, and skips binary files and node_modules (17.7574ms)
  ✔ a second load with the same modification time does not observe a rewritten map file (1.5611ms)
  ✔ updateProjectMapPath replaces one file and keeps the others (2.0153ms)
✔ project map (25.9661ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 78.4052
```

The first implementation compared `mtimeMs` with `Math.trunc`. On Windows that is flaky: `Stats.mtime` rounds, and `utimes(Date)` writes the rounded millisecond back. Example: stored `1791982963071.9453`, restored `1791982963072` (`Math.round` matches, `Math.trunc` does not). The cache now treats that restored clock time as the same file. After that change, 20/20 runs passed.

## Files changed

Commit `6262c5f` `feat: index project files and symbols in .ai/map.json`

- `src/agent/map.js` (new)
- `src/agent/paths.js` (`isProtectedFileName`)
- `test/map.test.js` (new)
- `index.js` (`loadProjectMap` export)

Pre-existing edits (README, CLI, config, other tests) were not staged. Not pushed.

## Self-review findings

- The task test's second case returns the identical object, so a rewritten map with the old modification time is not read.
- `updateProjectMapPath` clones the cached map, replaces one key, and installs a new entry. `widget.py` stays; `hello` is replaced by `goodbye`.
- `isProtectedFileName` uses the existing `PROTECTED_FILES` regex unchanged.
- JS/TS import resolution keeps every candidate that is already a map key, then sorts and uniques them.
- `searchMapped` does not call `readText` for `path` or `symbol`. `all` reads content only for paths that already produced a path or symbol line, unless neither did.
- Directory walk order uses `localeCompare`. JSON keys are sorted by code unit afterward, so the stored file order does not depend on the walk.
- `.gitignore` does not yet ignore `.ai/`. That is a later task in the plan, not this file list.

## Concerns

- Map cache identity is exact `mtimeMs` or `stat.mtime.getTime() === Math.round(storedMtimeMs)`. That is what makes `utimes(Date)` count as unchanged on Windows. A real rewrite whose rounded millisecond equals `Math.round` of the stored stamp can also be treated as unchanged.
- If `.ai/map.json` exists but is invalid JSON or `version !== 1`, `updateProjectMapPath` returns without writing. The brief only says to return immediately when the file is missing. Rebuilding on that path would index on every write, which the plan forbids.
- Symbol forms not listed in the brief are not indexed: `export async function`, `export default function`, `async def`, `pub(crate) fn`.
- The 32 MiB LRU eviction path is implemented and not covered by a test.

## Review fixes

Commit `cb6541f` `fix: keep map imports valid and skip unreadable files`

1. One-path updates re-resolve every file's imports against the current `files` keys. Raw import specifiers stay on the RAM entry, not in the JSON. If a loaded map has no specifiers yet, JavaScript, TypeScript, and Python files are re-read. After a delete, `lib.js` no longer lists `util/text.js`. Adding a path creates edges from files that already import it.
2. `searchMapped` stats a content file before reading it. A missing file, a file larger than 1 MiB, or a `readText` failure is skipped. Path and symbol lines already collected stay in the result.
3. `isForbiddenDirName` exports the existing forbidden-directory check without changing its regex. The walk skips `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, and `.docker` along with `.ai` and `NOISY_DIRS`.

Command: `node --test --test-timeout=60000 test/map.test.js`

```
▶ project map
  ✔ build indexes source symbols and imports, and skips binary files and node_modules (15.5746ms)
  ✔ a second load with the same modification time does not observe a rewritten map file (1.4656ms)
  ✔ updateProjectMapPath replaces one file and keeps the others (2.2483ms)
  ✔ deleting an imported file removes it from other files' imports (2.617ms)
  ✔ a content search skips a map path whose file is gone and still returns other hits (1.805ms)
  ✔ a file under .ssh is not indexed (2.4766ms)
✔ project map (31.3867ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 83.3828
```

Five more runs of the same command also passed.
