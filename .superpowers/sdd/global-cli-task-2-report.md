# Task 2: Launchers — Report

## Status

DONE

## What was implemented

- **`bin/ai.cmd`**: Runs `node` on `ai.js` beside the wrapper via `%~dp0`, forwards args, preserves exit code with `exit /b %ERRORLEVEL%`.
- **`bin/ai.sh`**: Resolves script directory with `CDPATH=`/`pwd`, `exec node "$dir/ai.js" "$@"`.
- **`bin/ai.ps1`**: Invokes `node` with `Join-Path $PSScriptRoot 'ai.js'` and `@args`, exits with `$LASTEXITCODE`.
- **`test/cli.test.js`**: Appended `runLauncher` helper (no `OPENAI_API_KEY`, no `process.execPath`; absolute launcher path, `cwd` = `os.tmpdir()`) and test `launchers print version from outside the repository` (Windows: `ai.cmd` + `ai.ps1`; else `ai.sh`).
- **`README.md`**: Replaced install fenced block under `## Установка` per brief (`npm install -g .`, publish comment, launcher paths comment).

Did not edit `bin/ai.js`. Did not run `npm install -g`.

## TDD evidence

### RED (step 2)

Command:

```text
node --test --test-timeout=60000 --test-name-pattern "launchers print version from outside the repository" test/cli.test.js
```

First run (wrappers missing): spawn/`cmd` failure — file not recognized (exit 1, not stdout assertion). Created empty wrapper files to match brief expectation (“wrappers are empty”).

Second run (empty wrappers):

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ ''
- 'universal-ai 1.0.0\n'
```

### GREEN (step 4)

Same focused command:

```text
✔ launchers print version from outside the repository (1103.2161ms)
ℹ pass 1, fail 0
```

### Full suite (step 6)

Command: `npm test`

```text
ℹ tests 69
ℹ pass 69
ℹ fail 0
```

Includes `package manifest name is universal-ai` and `launchers print version from outside the repository`.

## Files changed

| File | Change |
|------|--------|
| `bin/ai.cmd` | Created (wrapper) |
| `bin/ai.sh` | Created (wrapper) |
| `bin/ai.ps1` | Created (wrapper) |
| `test/cli.test.js` | Appended helper + launcher test |
| `README.md` | Install block updated |

## Commit

- `9500835` — feat: launch ai from the directory that holds the scripts

## Self-review

- [x] Wrappers match brief verbatim (bat/sh/ps1 content).
- [x] Test uses absolute paths under repo `bin/`, `cwd` outside repo (`os.tmpdir()`), asserts `assert.notEqual` on resolved paths.
- [x] Helper does not set `OPENAI_API_KEY` or pass `process.execPath`.
- [x] README install block matches brief; `## Установка` heading and following paragraph unchanged.
- [x] `bin/ai.js` untouched.
- [x] Staged only the five files named in the brief; no `package-lock.json`.

## Concerns

- **`test/cli.test.js` size**: File is ~293 lines after append; still manageable, but growing — consider splitting CLI integration tests in a future task if more launcher/CLI cases are added.
- **RED note**: Initial RED required creating zero-byte wrapper files because they were absent from the worktree (not only empty); behavior under test is empty/non-functional wrappers → wrong stdout.
