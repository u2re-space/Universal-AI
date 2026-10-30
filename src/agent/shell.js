/**
 * @file src/agent/shell.js
 * @module agent/shell
 * @purpose Spawn a shell command with a timeout, capped output, and a secret-stripped environment.
 * @depends node:child_process
 * @usedBy agent/tools, interact/filesystem
 * @exports SHELLS, childEnvironment, runCommand, runProgram, scriptLaunch, sshPlan
 * @ai.tags shell, process, ssh
 * @ai.hint io
 * @changed 2026-10-15 Script files and SSH plans beside the shell command.
 * @changed 2026-10-30 `pipe` echoes a long command's output live on stderr.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

/** Shells an agent may name on a single call. Empty means the configured default. */
export const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'];

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Child processes inherit the environment minus anything that looks like a secret. */
export function childEnvironment(env = process.env) {
    const result = {};
    for (const [key, value] of Object.entries(env)) {
        if (SECRET_ENV.test(key)) continue;
        result[key] = value;
    }
    result.CI = result.CI ?? '1';
    result.NO_COLOR = '1';
    return result;
}

/**
 * Choose the executable and arguments for `command`.
 * `runCommand` passes the result to `spawn`.
 * @param {string} command
 * @param {string | null} shell powershell, pwsh, cmd, bash, sh, zsh, or null for the platform default.
 * @returns {{ file: string, args: string[], verbatim?: boolean }}
 * @ai.hint pure
 */
function shellCommand(command, shell) {
    const win = process.platform === 'win32';
    switch (shell) {
        case 'powershell':
        case 'pwsh':
            return { file: shell === 'pwsh' ? 'pwsh' : 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
        case 'cmd':
            // Same quoting Node uses for shell:true on Windows: /s strips the outer quotes we add.
            return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
        case 'bash':
        case 'sh':
        case 'zsh':
            return { file: shell, args: ['-c', command] };
        default:
            return win ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true }
                : { file: '/bin/sh', args: ['-c', command] };
    }
}

/**
 * Kill `child` and the processes it started.
 * `runCommand` calls this on timeout and on abort.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {void}
 * @ai.hint io
 */
function killTree(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        // taskkill must see the parent alive to enumerate its tree: kill the shell itself only afterwards.
        const fallback = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
        try {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            killer.once('error', fallback);
            killer.once('close', fallback);
        } catch { fallback(); }
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }
}

/**
 * Interpreter for a script file. `.ps1` → PowerShell, `.cmd`/`.bat` → cmd, `.sh`/`.bash` → bash.
 * An explicit shell overrides the extension. Arguments are argv, not a shell string.
 * @param {string} absPath Absolute path of the script.
 * @param {{ shell?: string|null, args?: string[] }} [options]
 * @returns {{ file: string, args: string[] }}
 * @exports
 * @ai.hint pure
 */
export function scriptLaunch(absPath, { shell = null, args = [] } = {}) {
    const ext = path.extname(absPath).toLowerCase();
    const chosen = shell || (ext === '.ps1' ? 'powershell' : ext === '.cmd' || ext === '.bat' ? 'cmd' : ext === '.sh' || ext === '.bash' ? 'bash' : null);
    if (!SHELLS.includes(chosen)) throw new Error('Укажите shell: powershell, pwsh, cmd, bash, sh или zsh.');
    const extra = args.map((item) => String(item));
    if (chosen === 'powershell' || chosen === 'pwsh') {
        return { file: chosen === 'pwsh' ? 'pwsh' : 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', absPath, ...extra] };
    }
    if (chosen === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', absPath, ...extra] };
    return { file: chosen, args: [absPath, ...extra] };
}

const SSH_HOST = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Argv for the system `ssh` or `scp` client. No local shell and no extra ssh options.
 * `exec` runs `command`, or sends a local script on stdin when `command` is empty.
 * `put` and `get` copy one file. BatchMode refuses a password prompt.
 * @param {{ mode: string, host: string, command?: string, port?: number|null, identity?: string|null, localPath?: string|null, remotePath?: string, shell?: string|null }} options
 * @returns {{ file: string, args: string[], sendFile: boolean }}
 * @exports
 * @ai.hint pure
 */
export function sshPlan({ mode, host, command = '', port = null, identity = null, localPath = null, remotePath = '', shell = null }) {
    if (typeof host !== 'string' || !SSH_HOST.test(host)) throw new Error('Адрес SSH: host или user@host, без пробелов и без дефиса в начале.');
    if (typeof remotePath !== 'string' || /[\r\n]/.test(remotePath)) throw new Error('Некорректный удалённый путь.');
    const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
    if (identity) common.push('-i', identity);
    if (mode === 'put' || mode === 'get') {
        if (!localPath || !remotePath.trim()) throw new Error('Для копирования файла нужны local_path и remote_path.');
        const remote = `${host}:${remotePath}`;
        const args = [...common];
        if (port) args.push('-P', String(port));
        if (mode === 'put') args.push(localPath, remote);
        else args.push(remote, localPath);
        return { file: 'scp', args, sendFile: false };
    }
    if (mode !== 'exec') throw new Error('mode: exec, put или get.');
    const args = [...common];
    if (port) args.push('-p', String(port));
    args.push(host);
    const text = typeof command === 'string' ? command.trim() : '';
    if (text) {
        args.push(text);
        return { file: 'ssh', args, sendFile: false };
    }
    if (!localPath) throw new Error('Для exec нужна command или local_path со скриптом.');
    const ext = path.extname(localPath).toLowerCase();
    const chosen = shell || (ext === '.ps1' ? 'powershell' : ext === '.sh' || ext === '.bash' ? 'bash' : null);
    if (chosen === 'powershell' || chosen === 'pwsh') {
        args.push(`${chosen} -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`);
        return { file: 'ssh', args, sendFile: true };
    }
    if (chosen === 'bash' || chosen === 'sh' || chosen === 'zsh') {
        args.push(`${chosen} -s`);
        return { file: 'ssh', args, sendFile: true };
    }
    throw new Error('Удалённо из файла запускаются .ps1, .sh и .bash. Файл .cmd/.bat скопируйте (put) и вызовите command.');
}

/**
 * Run a shell command with a timeout, bounded output capture and process-tree termination.
 * Resolves (never rejects) with { exitCode, signal, stdout, stderr, timedOut, cancelled, durationMs, truncated }.
 * @param {{ command: string, cwd?: string, timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal, shell?: string|null, onOutput?: Function, pipe?: boolean }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export function runCommand({ command, cwd, timeoutMs = 180_000, maxOutputBytes = 64 * 1024, signal, shell = null, onOutput, pipe = false }) {
    const launched = shellCommand(command, shell);
    return runProgram({ ...launched, cwd, timeoutMs, maxOutputBytes, signal, onOutput, pipe });
}

/**
 * Spawn an executable with an argv list. `input` is written to stdin when present.
 * Same timeout, output cap, and result shape as `runCommand`.
 * `pipe` echoes the child output live on stderr, so a long silent command does not look frozen.
 * @param {{ file: string, args?: string[], cwd?: string, input?: Buffer|string|null, timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal, onOutput?: Function, verbatim?: boolean, pipe?: boolean }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export function runProgram({ file, args = [], cwd, input = null, timeoutMs = 180_000, maxOutputBytes = 64 * 1024, signal, onOutput, verbatim = false, pipe = false }) {
    const started = Date.now();
    return new Promise((resolve) => {
        let child;
        const output = { stdout: [], stderr: [] };
        let captured = 0, truncated = false, timedOut = false, cancelled = false, finished = false;
        let spawnError = null;
        /** Keep stdout or stderr until `maxOutputBytes`, then set `truncated`. */
        const consume = (stream, chunk) => {
            const room = Math.max(0, maxOutputBytes - captured);
            const slice = chunk.subarray(0, room);
            if (slice.length) { output[stream].push(slice); captured += slice.length; onOutput?.({ stream, bytes: slice.length }); }
            if (slice.length < chunk.length) truncated = true;
            // Live echo goes to stderr only: stdout carries the JSON payload in --json mode.
            if (pipe) { try { process.stderr.write(chunk); } catch { /* stderr closed or redirected */ } }
        };
        /** Resolve once with the captured output and the timeout, cancel, and error flags. */
        const finish = (code, sig) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // A surviving grandchild must not keep our pipes (and event loop) alive.
            child?.stdout?.destroy(); child?.stderr?.destroy();
            resolve({
                exitCode: code, signal: sig ?? null, timedOut, cancelled, durationMs: Date.now() - started, truncated,
                stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'),
                error: spawnError?.message ?? null,
            });
        };
        const stop = () => { if (child) killTree(child); setTimeout(() => finish(null, 'SIGKILL'), 1500).unref(); };
        const onAbort = () => { cancelled = true; stop(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        try {
            child = spawn(file, args, {
                cwd, env: childEnvironment(), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true,
                windowsVerbatimArguments: Boolean(verbatim), detached: process.platform !== 'win32',
            });
            if (input != null) {
                child.stdin.on('error', () => { });
                child.stdin.end(input);
            }
        } catch (error) {
            spawnError = error;
            return finish(null, null);
        }
        child.stdout.on('data', (chunk) => consume('stdout', chunk));
        child.stderr.on('data', (chunk) => consume('stderr', chunk));
        child.once('error', (error) => { spawnError = error; finish(null, null); });
        child.once('close', (code, sig) => finish(code, sig));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}
