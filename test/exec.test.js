import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { scriptLaunch, sshPlan, runCommand } from '../src/agent/shell.js';
import { createToolset, enabledToolNames } from '../src/agent/tools.js';
import { toolNamesForRole } from '../src/agent/team.js';
import { defaults } from '../src/core/config.js';

test('scriptLaunch picks the interpreter from the extension and keeps arguments as argv', () => {
    const ps1 = scriptLaunch('C:\\work\\note.ps1', { args: ['one'] });
    assert.equal(ps1.file, 'powershell');
    assert.deepEqual(ps1.args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\work\\note.ps1']);
    assert.equal(ps1.args.at(-1), 'one');
    const sh = scriptLaunch('/work/run.sh');
    assert.equal(sh.file, 'bash');
    assert.deepEqual(sh.args, ['/work/run.sh']);
    const cmd = scriptLaunch('C:\\work\\go.cmd', { shell: 'cmd', args: ['a b'] });
    assert.match(cmd.file, /cmd/i);
    assert.equal(cmd.args.at(-1), 'a b');
    assert.throws(() => scriptLaunch('/work/notes.txt'), /shell/);
});

test('sshPlan builds ssh and scp argv and rejects a hostile host', () => {
    const exec = sshPlan({ mode: 'exec', host: 'user@example.com', command: 'uname -a', port: 2222, identity: 'C:\\keys\\id' });
    assert.equal(exec.file, 'ssh');
    assert.equal(exec.sendFile, false);
    assert.ok(exec.args.includes('BatchMode=yes'));
    assert.ok(exec.args.includes('-p'));
    assert.equal(exec.args.at(-2), 'user@example.com');
    assert.equal(exec.args.at(-1), 'uname -a');
    assert.equal(exec.args.includes('-o') && exec.args.some((part) => part.startsWith('Proxy')), false);
    const put = sshPlan({ mode: 'put', host: 'example.com', localPath: 'C:\\work\\a.txt', remotePath: '/tmp/a.txt' });
    assert.equal(put.file, 'scp');
    assert.equal(put.args.at(-2), 'C:\\work\\a.txt');
    assert.equal(put.args.at(-1), 'example.com:/tmp/a.txt');
    assert.equal(put.args.includes('-P'), false);
    const script = sshPlan({ mode: 'exec', host: 'example.com', localPath: 'C:\\work\\task.ps1' });
    assert.equal(script.sendFile, true);
    assert.match(script.args.at(-1), /powershell/);
    assert.throws(() => sshPlan({ mode: 'exec', host: '-oProxyCommand=calc', command: 'id' }), /Адрес SSH/);
    assert.throws(() => sshPlan({ mode: 'exec', host: 'example.com', localPath: 'C:\\work\\go.cmd' }), /cmd/);
});

test('shell tools are enabled together and the reviewer may run them', () => {
    const names = enabledToolNames({ ...defaults.tools, shell: true, fs: false, fetch: false, desktop: false });
    for (const name of ['run_command', 'run_script', 'ssh']) assert.equal(names.includes(name), true);
    const reviewer = toolNamesForRole([...names, 'write_file'], 'reviewer');
    assert.equal(reviewer.includes('ssh'), true);
    assert.equal(reviewer.includes('write_file'), false);
    assert.equal(toolNamesForRole(names, 'collector').includes('run_script'), false);
});

test('run_command can target cmd and powershell, and run_script runs a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-exec-'));
    const toolset = createToolset({
        root, config: defaults, names: ['run_command', 'run_script', 'ssh'], approvalLevel: 'all', approve: async () => 'no',
    });
    try {
        const win = process.platform === 'win32';
        const cmd = await toolset.execute({
            name: 'run_command',
            arguments: JSON.stringify({
                command: win ? 'echo cmd-ok' : 'echo sh-ok', shell: win ? 'cmd' : 'sh', cwd: null, timeout_seconds: 20, reason: 'check',
            }),
        });
        assert.match(cmd.output, win ? /cmd-ok/ : /sh-ok/);
        assert.equal(cmd.ok, true);
        if (win) {
            const ps = await toolset.execute({
                name: 'run_command',
                arguments: JSON.stringify({ command: 'Write-Output ps-ok', shell: 'powershell', cwd: null, timeout_seconds: 30, reason: 'check' }),
            });
            assert.match(ps.output, /ps-ok/);
            await writeFile(path.join(root, 'hello.ps1'), 'Write-Output script-ok\n', 'utf8');
        } else {
            await writeFile(path.join(root, 'hello.sh'), 'echo script-ok\n', 'utf8');
        }
        const script = await toolset.execute({
            name: 'run_script',
            arguments: JSON.stringify({ path: win ? 'hello.ps1' : 'hello.sh', args: [], shell: '', cwd: null, timeout_seconds: 30, reason: 'check' }),
        });
        assert.match(script.output, /script-ok/);
        const denied = await toolset.execute({
            name: 'ssh',
            arguments: JSON.stringify({
                host: '-oProxyCommand=calc', command: 'id', mode: 'exec', local_path: '', remote_path: '',
                shell: '', port: null, identity: '', timeout_seconds: 5, reason: 'no',
            }),
        });
        assert.match(denied.output, /Адрес SSH/);
        assert.equal(denied.ok, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('runCommand still captures output when a shell is named', async () => {
    const echo = await runCommand({
        command: 'echo named-ok', shell: process.platform === 'win32' ? 'cmd' : 'sh', cwd: process.cwd(), timeoutMs: 15_000,
    });
    assert.match(echo.stdout, /named-ok/);
    assert.equal(echo.exitCode, 0);
});
