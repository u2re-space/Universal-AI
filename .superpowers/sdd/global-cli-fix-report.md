# Global CLI fix — report

## Status

DONE

## What changed

- `bin/ai.cmd` resolves `node.exe` with `%%~$PATH:I` and does not search the caller's directory.
- `bin/ai.ps1` forwards PowerShell pipeline input to `node` and exits 1 when `node` cannot be started.
- `bin/ai.sh` text is unchanged. Index mode is `100755`. `bin/ai.js` stays `100644`.
- `test/cli.test.js` quotes `.cmd` arguments inside one `/s /c` string and adds the spaced-path, planted `node.cmd`, map directory, missing-`node`, and mock pipeline checks.
- Spec and plan code blocks match those wrappers in the main checkout and in the worktree. Plan checkboxes were left as they were.

`bin/ai.js` was not edited. No README note, no Ctrl+C batch trick, and no spawn `error` listener.

## RED

Command, before any edit to `bin/ai.cmd` or `bin/ai.ps1`. The new `runLauncher` quoting was already in place.

```text
node --test --test-timeout=60000 --test-name-pattern "launcher" test/cli.test.js
```

```text
✔ launchers print version from outside the repository (972.431ms)
✔ launcher spaced path prints version (103.2237ms)
✖ launcher ignores caller node.cmd (27.1003ms)
✔ launchers map the caller directory and reject an unknown target (1861.8329ms)
✖ launcher exits non-zero when node is missing from PATH (1611.4199ms)
✖ launcher forwards a PowerShell pipeline (967.8605ms)
ℹ tests 6
ℹ suites 0
ℹ pass 3
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5665.7135
```

Planted `node.cmd`:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
42 !== 0
```

Missing `node` (`ai.ps1 --version`, `PATH` set to an empty directory):

```text
AssertionError [ERR_ASSERTION]: The term 'node' is not recognized...
actual: 0
expected: 0
operator: 'notStrictEqual'
```

Mock pipeline (`'hello from pipe' | & ai.ps1 ask 'two words'`). The recorded body was only `two words`:

```text
AssertionError [ERR_ASSERTION]: ...
actual: '[{"model":"mock-model","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"two words"}]}], ...}]'
expected: /hello from pipe/
operator: 'match'
```

The spaced-path test passed on this run. That is expected: the space bug was in the test helper, and the current `ai.cmd` already handles a spaced path. The map working-directory test also passed.

## GREEN

Same focused command, after the wrapper replacements:

```text
✔ launchers print version from outside the repository (954.8126ms)
✔ launcher spaced path prints version (100.6316ms)
✔ launcher ignores caller node.cmd (102.5747ms)
✔ launchers map the caller directory and reject an unknown target (1906.0661ms)
✔ launcher exits non-zero when node is missing from PATH (1692.4037ms)
✔ launcher forwards a PowerShell pipeline (968.4386ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5853.2278
```

## npm test

```text
> universal-ai@1.0.0 test
> node --test --test-timeout=60000 "test/*.test.js"

ℹ tests 74
ℹ suites 0
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8885.056
```

## Executable bit

```text
git ls-files -s -- bin/ai.sh bin/ai.js
100644 a56bbb97c45972a6ec8e36dfb2606f854ab0a84a 0	bin/ai.js
100755 365bafb726f320a80248cd53cfcefd6c754deb00 0	bin/ai.sh
```

The `bin/ai.sh` blob hash is unchanged from `9500835`. Only the mode changed (`100644` → `100755`).

## Commit

`a9cd010` — fix: take node from PATH and forward launcher input

Staged only `bin/ai.cmd`, `bin/ai.ps1`, `bin/ai.sh`, `test/cli.test.js`, `docs/superpowers/specs/2026-10-15-global-cli-design.md`, and `docs/superpowers/plans/2026-10-15-global-cli.md`. Working tree clean after the commit.

## Self-review

- Wrapper text matches the brief.
- Pipeline test uses `startMockServer`, the specified child environment, and a real `powershell.exe -Command` pipeline. It does not call the live API.
- The three required RED failures were the planted `node.cmd` (exit 42), missing `node` (exit 0), and the mock body lacking `hello from pipe`.
- Spec states PATH-only `node.exe` lookup, pipeline forwarding, exit 1 when `node` cannot start, and `100755` for `bin/ai.sh`. Plan checkbox history was not edited.
