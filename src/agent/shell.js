import { spawn } from 'node:child_process';

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
 * Run a shell command with a timeout, bounded output capture and process-tree termination.
 * Resolves (never rejects) with { exitCode, signal, stdout, stderr, timedOut, cancelled, durationMs, truncated }.
 */
export function runCommand({ command, cwd, timeoutMs = 180_000, maxOutputBytes = 64 * 1024, signal, shell = null, onOutput }) {
    const started = Date.now();
    const { file, args, verbatim } = shellCommand(command, shell);
    return new Promise((resolve) => {
        let child;
        const output = { stdout: [], stderr: [] };
        let captured = 0, truncated = false, timedOut = false, cancelled = false, finished = false;
        let spawnError = null;
        const consume = (stream, chunk) => {
            const room = Math.max(0, maxOutputBytes - captured);
            const slice = chunk.subarray(0, room);
            if (slice.length) { output[stream].push(slice); captured += slice.length; onOutput?.({ stream, bytes: slice.length }); }
            if (slice.length < chunk.length) truncated = true;
        };
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
                cwd, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
                windowsVerbatimArguments: Boolean(verbatim), detached: process.platform !== 'win32',
            });
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
