# Global CLI launch

The `ai` command runs from any working directory. The launchers find the package next to themselves. The agent still uses the directory from which the command was started. The package name is `universal-ai`, so `npm install -g universal-ai` installs the command `ai` once the package is published. From a clone, `npm install -g .` installs that same command.

Node.js built-in modules only. No new dependencies.

## Non-goals

- Publishing the package to the npm registry.
- Running `npm install -g` inside the test suite.
- Renaming the command from `ai` to `universal-ai`.
- Changing where the agent reads and writes project files. That stays the caller's working directory, or `--cwd`.
- Changing `User-Agent` strings that still say `ai-agent-cli`.
- Resolving symlinks. Each wrapper uses the path of the script file that was invoked.

## Launchers

`bin/ai.js` stays the npm bin target and is unchanged. It already imports `../src/cli.js`, and `src/cli.js` already loads `package.json` and respawns `bin/ai.js` through `import.meta.url`. Those paths follow the installed files, not the working directory.

`bin/ai.cmd`:

```bat
@echo off
setlocal
set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo ai: node.exe not found on PATH 1>&2
  exit /b 9009
)
endlocal & "%NODE_EXE%" "%~dp0ai.js" %*
exit /b %ERRORLEVEL%
```

`bin/ai.sh`:

```sh
#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$dir/ai.js" "$@"
```

`bin/ai.ps1`:

```powershell
$ai = Join-Path $PSScriptRoot 'ai.js'
try {
  if ($MyInvocation.ExpectingInput) { $input | & node $ai @args } else { & node $ai @args }
} catch {
  Write-Error $_
  exit 1
}
exit $LASTEXITCODE
```

Each wrapper passes the arguments through and leaves the process working directory unchanged. The process exit code is the exit code of `node`. `bin/ai.sh` is executable (`100755`).

`ai.cmd` resolves `node.exe` from `PATH` and does not search the caller's directory. A `node.cmd`, `node.exe`, or `node.js` sitting in the caller's directory does not run. If `node.exe` is not on `PATH`, the wrapper writes an error to stderr and exits 9009.

`ai.ps1` forwards pipeline input to `node` and exits 1 when `node` cannot be started.

## Package

`package.json` `name` becomes `universal-ai`. `bin` stays `{ "ai": "./bin/ai.js" }`. `files` already lists `bin`, `src`, `index.js`, and `README.md`. `engines` stays `node >= 26`.

`ai --version` prints `universal-ai 1.0.0` because it prints `name` and `version` from `package.json`. It does this before the API-key check and before the Node version check.

## Docs

The install block in `README.md` becomes:

```bash
# Node.js ≥ 26, внешних зависимостей нет
npm install -g .       # из клона: команда `ai` в PATH
# npm install -g universal-ai   # то же после публикации пакета
# либо из любого каталога: bin/ai.cmd, bin/ai.sh, bin/ai.ps1, или node <путь>/bin/ai.js
export OPENAI_API_KEY=sk-...   # PowerShell: $env:OPENAI_API_KEY = "sk-..."
ai config init         # создаст ~/.ai-agent/config.json
```

## Tests

`test/cli.test.js` checks the package manifest and the launchers.

The package manifest check reads `package.json` and expects `name` to be `universal-ai` and `bin.ai` to be `./bin/ai.js`.

The launcher check starts the wrapper with a working directory outside the repository and the argument `--version`. On Windows it runs `bin/ai.cmd` and `bin/ai.ps1`. On other platforms it runs `bin/ai.sh`. The script path passed to the shell is absolute. Expected result: exit code 0 and stdout `universal-ai 1.0.0\n`. The test does not set `OPENAI_API_KEY` for this run. `node` is resolved from `PATH` by the wrapper, not by passing `process.execPath`.

The spaced-path check junctions the repository root to a temp directory named `ua review space` and runs `bin/ai.cmd --version` through that junction. Expected result: exit code 0 and stdout `universal-ai 1.0.0\n`.

The planted `node.cmd` check writes `node.cmd` containing `@echo PLANTED& exit /b 42` in a fresh temp directory and runs `bin/ai.cmd --version` with that directory as the working directory. Expected result: exit code 0, stdout `universal-ai 1.0.0\n`, and no `PLANTED` in stdout or stderr.

The map check, for each launcher the version check runs, creates a fresh temp directory containing `a.js` with `export function hello() {}\n`, sets `AI_AGENT_HOME` to another fresh temp directory and `OPENAI_API_KEY` to empty, and runs `map`. Expected result: exit code 0 and `.ai/map.json` inside that directory. It then runs `map nope` and expects exit code 2.

The missing-`node` check runs absolute `bin/ai.ps1 --version` with `PATH` pointing at a directory that does not contain `node.exe`. Expected result: a non-zero exit code.

The pipeline check starts a mock Responses server that records the request body and returns `{ text: 'ok' }`. It runs a real PowerShell pipeline, not stdin of `powershell -File`:

```text
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { 'hello from pipe' | & '<absolute ai.ps1>' ask 'two words' }"
```

The child receives `OPENAI_API_KEY=sk-test`, `OPENAI_BASE_URL` set to the mock `baseURL`, `AI_MODEL=mock-model`, `AI_AGENT_HOME` set to a fresh temp directory, and `NO_COLOR=1`. Expected result: the recorded body contains `hello from pipe`, the process exits 0, and stdout contains `ok`.
