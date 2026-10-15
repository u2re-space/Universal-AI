### Task 2: Launchers

**Files:**
- Modify: `bin/ai.cmd`
- Modify: `bin/ai.sh`
- Modify: `bin/ai.ps1`
- Modify: `test/cli.test.js` (append the helper and the test)
- Modify: `README.md` (fenced install block under `## Установка`, lines 27–32)

**Interfaces:**
- Consumes: Task 1's package name. `ai --version` writes `universal-ai 1.0.0\n` and returns 0 before any API-key check.
- Produces: `bin/ai.cmd`, `bin/ai.sh`, and `bin/ai.ps1`. Each runs `node` on `ai.js` in the same directory as the wrapper. Later callers invoke those files by absolute path; the working directory of the process is the caller's directory.

- [ ] **Step 1: Write the failing test**

Append this helper and test to `test/cli.test.js`. `spawn`, `path`, `os`, and `fileURLToPath` are already imported.

```javascript
function runLauncher(launcher, args, cwd) {
  const ext = path.extname(launcher).toLowerCase();
  let command;
  let commandArgs;
  let windowsVerbatimArguments = false;
  if (ext === '.cmd') {
    command = process.env.ComSpec || 'cmd.exe';
    commandArgs = ['/d', '/s', '/c', `"${launcher}"`, ...args];
    windowsVerbatimArguments = true;
  } else if (ext === '.ps1') {
    command = 'powershell.exe';
    commandArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args];
  } else {
    command = 'sh';
    commandArgs = [launcher, ...args];
  }
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd, windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('launchers print version from outside the repository', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cwd = os.tmpdir();
  assert.notEqual(path.resolve(cwd), path.resolve(root));
  const launchers = process.platform === 'win32'
    ? [path.join(root, 'bin', 'ai.cmd'), path.join(root, 'bin', 'ai.ps1')]
    : [path.join(root, 'bin', 'ai.sh')];
  for (const launcher of launchers) {
    const { code, stdout, stderr } = await runLauncher(launcher, ['--version'], cwd);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, 'universal-ai 1.0.0\n');
  }
});
```

The helper does not set `OPENAI_API_KEY`. It does not pass `process.execPath`. The launcher path is absolute, and `cwd` is the OS temp directory.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-timeout=60000 --test-name-pattern "launchers print version from outside the repository" test/cli.test.js
```

Expected: FAIL because stdout is not `universal-ai 1.0.0\n`. The wrappers are empty, so this is the missing behavior. If the process fails to spawn, fix only the helper's spawn arguments until the failure is that assertion, then re-run.

- [ ] **Step 3: Write the three wrappers**

Replace `bin/ai.cmd` with:

```bat
@echo off
node "%~dp0ai.js" %*
exit /b %ERRORLEVEL%
```

Replace `bin/ai.sh` with:

```sh
#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$dir/ai.js" "$@"
```

Replace `bin/ai.ps1` with:

```powershell
& node (Join-Path $PSScriptRoot 'ai.js') @args
exit $LASTEXITCODE
```

Do not edit `bin/ai.js`.

- [ ] **Step 4: Run the launcher test to verify it passes**

Run:

```bash
node --test --test-timeout=60000 --test-name-pattern "launchers print version from outside the repository" test/cli.test.js
```

Expected: PASS. On Windows both `ai.cmd` and `ai.ps1` pass. On other platforms `ai.sh` passes.

- [ ] **Step 5: Update the install block**

In `README.md`, replace the install block with:

```bash
# Node.js ≥ 26, внешних зависимостей нет
npm install -g .       # из клона: команда `ai` в PATH
# npm install -g universal-ai   # то же после публикации пакета
# либо из любого каталога: bin/ai.cmd, bin/ai.sh, bin/ai.ps1, или node <путь>/bin/ai.js
export OPENAI_API_KEY=sk-...   # PowerShell: $env:OPENAI_API_KEY = "sk-..."
ai config init         # создаст ~/.ai-agent/config.json
```

Leave the surrounding `## Установка` heading and the following paragraph in place.

- [ ] **Step 6: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS, including `package manifest name is universal-ai` and `launchers print version from outside the repository`.

- [ ] **Step 7: Commit**

```bash
git add bin/ai.cmd bin/ai.sh bin/ai.ps1 test/cli.test.js README.md
git commit -m "$(cat <<'EOF'
feat: launch ai from the directory that holds the scripts

EOF
)"
```
