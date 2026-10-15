# Fix brief: global CLI review findings

The human chose the review over the plan text. Replace the Windows launchers, the cmd test quoting, the missing regression tests, and the spec/plan snippets. Do not edit `bin/ai.js` or `bin/ai.sh` source text. Do not add the optional README `npm link` note, the Ctrl+C batch trick, or a spawn `error` listener.

Work from: `C:\Projects\Universal-AI\.worktrees\feat-global-cli`
Branch: `feat/global-cli`. Base commit before this fix: `95008354d02418eb04c198a1b3885f40c5065f4a`.

## 1. `bin/ai.cmd`

Replace the file with exactly:

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

`%%~$PATH:I` searches `PATH` only. A `node.cmd`, `node.exe`, or `node.js` in the caller's directory must not run.

## 2. `bin/ai.ps1`

Replace the file with exactly:

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

A PowerShell pipeline must reach `node`. If `node` cannot be started, the script exits non-zero.

## 3. `bin/ai.sh` mode

Do not change its text. Before committing, run from the worktree:

```
git update-index --chmod=+x bin/ai.sh
```

The index mode must be `100755`. `bin/ai.js` stays `100644`.

## 4. Tests in `test/cli.test.js`

Write these tests first and run them before changing the wrappers. On this Windows machine the planted-`node.cmd` test, the missing-`node` test, the pipeline test, and the spaced-path test must fail on the current code. The `map` working-directory test may already pass. Keep the existing `--version` test.

Extend `runLauncher` so it accepts an options object `{ env = {}, input = null }` as the fourth argument. Merge `env` over `process.env`. If `input` is not null, stdin is a pipe and is ended with that string. Existing callers that pass three arguments stay valid.

For `.cmd`, quote the launcher and each argument inside one `/s /c` string so a space in the launcher path survives:

```javascript
const quotedArgs = args.map((arg) => `"${arg.replaceAll('"', '')}"`).join(' ');
commandArgs = ['/d', '/s', '/c', `""${launcher}" ${quotedArgs}"`];
windowsVerbatimArguments = true;
```

Add these tests. Skip a test body that needs Windows when `process.platform !== 'win32'`.

**Spaced path.** Create `path.join(os.tmpdir(), 'ua review space')`, junction the repository root into it with `symlink(root, link, 'junction')`, and run `bin/ai.cmd` from that junction with `--version`. Expect exit 0 and stdout `universal-ai 1.0.0\n`. Remove the temp directory afterwards.

**Caller's `node.cmd` is ignored.** In a fresh temp directory, write `node.cmd` containing `@echo PLANTED& exit /b 42`. Run `bin/ai.cmd --version` with that directory as cwd. Expect exit 0, stdout `universal-ai 1.0.0\n`, and no `PLANTED` in stdout or stderr.

**Working directory and exit code.** For each launcher the existing `--version` test runs (`ai.cmd` and `ai.ps1` on Windows, `ai.sh` elsewhere): create a fresh temp directory, write `a.js` with `export function hello() {}\n`, set `AI_AGENT_HOME` to another fresh temp directory and `OPENAI_API_KEY` to empty, run `['map']`. Expect exit 0 and `.ai/map.json` inside that fresh directory. Then run `['map', 'nope']` and expect exit 2. Do not assert that the repository root has no `.ai` directory.

**`ai.ps1` without `node`.** Spawn `powershell.exe` by its full path if needed, with `PATH` set to a directory that does not contain `node.exe`, and `-File` the absolute `bin/ai.ps1` with `--version`. Expect a non-zero exit code.

**`ai.ps1` pipeline.** From PowerShell, pipe text into the script: `'hello from pipe' | & '<absolute ai.ps1>' run`, with `OPENAI_API_KEY` empty. Expect stderr to match `OPENAI_API_KEY` and not `Укажите задачу`. Exit code 2 is correct for the missing key.

Covering file: `test/cli.test.js`. Focused command:

```
node --test --test-timeout=60000 --test-name-pattern "launcher" test/cli.test.js
```

Use a pattern that matches every new test name you add, and include `launchers print version`. After the wrappers and helper are fixed, that command passes. Then run `npm test` once. Output must be pristine.

## 5. Spec and plan

Update both copies so the code blocks match the files above:

- `C:\Projects\Universal-AI\docs\superpowers\specs\2026-10-15-global-cli-design.md`
- `C:\Projects\Universal-AI\docs\superpowers\plans\2026-10-15-global-cli.md`
- The same two paths inside the worktree, so the commit can include them. Create the directories there. Do not copy the other docs.

In the spec, replace the `ai.cmd` and `ai.ps1` blocks with the new file contents. State that `ai.cmd` resolves `node.exe` from `PATH` and does not search the caller's directory, that `ai.ps1` forwards pipeline input to `node` and exits 1 when `node` cannot be started, and that `bin/ai.sh` is executable (`100755`). Extend the Tests section with the spaced path, the planted `node.cmd`, the `map` directory and exit 2, the missing `node`, and the pipeline check.

In the plan, replace the Task 2 wrapper blocks and the `.cmd` line of `runLauncher` so they match. Leave the completed checkbox history as it is; only the code blocks change.

## 6. Commit

Shell is PowerShell. Do not update git config. Do not skip hooks. Do not commit `package-lock.json`.

Stage only: `bin/ai.cmd`, `bin/ai.ps1`, `bin/ai.sh`, `test/cli.test.js`, `docs/superpowers/specs/2026-10-15-global-cli-design.md`, `docs/superpowers/plans/2026-10-15-global-cli.md`.

`git update-index --chmod=+x bin/ai.sh` after `git add`.

Commit message exactly:

```
fix: take node from PATH and forward launcher input
```

## Report

Append the full report to `C:\Projects\Universal-AI\.superpowers\sdd\global-cli-fix-report.md`.

Include TDD evidence: the RED command and the failing assertions before the wrapper edits, then the GREEN command and passing output, then `npm test` with the pass count. Include `git ls-files -s bin/ai.sh` showing `100755`.

Return only: status, commit SHA and subject, one-line test summary, concerns, report path.
