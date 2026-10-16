import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function minimalEnvironment() {
  const env = { LANG: 'C.UTF-8', TZ: 'UTC' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Deliberately no OPENAI_API_KEY, HOME, NODE_OPTIONS, npm config or inherited app secrets.
  return env;
}

function killGroup(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch {} } }
  } else { try { child.kill('SIGKILL'); } catch {} }
}

async function removeContainer(executable, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['rm', '--force', name], {
      shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: minimalEnvironment(),
      detached: process.platform !== 'win32', windowsHide: true,
    });
    let finished = false, stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
    const finish = (error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      killGroup(child);
      finish(new Error(`Не удалось подтвердить остановку контейнера ${name}. Проверьте Docker вручную.`));
    }, 5000);
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      // --rm may have removed it already. Any other cleanup failure is NOT success.
      if (code === 0 || /No such container/i.test(stderr)) finish();
      else finish(new Error(`Docker не подтвердил удаление контейнера ${name}; код ${code}.`));
    });
  });
}

async function execute(executable, args, {
  cwd, signal, timeoutMs, outputLimit, onOutput = () => {}, cleanup = async () => {},
}) {
  signal?.throwIfAborted();
  const started = Date.now();
  const env = minimalEnvironment();
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
    const output = { stdout: [], stderr: [] };
    let captured = 0, truncated = false, timedOut = false, cancelled = false;
    let spawnError = null, completed = false, closing = false, forceTimer;
    let cleanupPromise;
    const beginCleanup = () => cleanupPromise ??= Promise.resolve().then(cleanup);
    const consume = (stream, chunk) => {
      const available = Math.max(0, outputLimit - captured);
      const selected = chunk.subarray(0, available);
      if (selected.length) {
        output[stream].push(selected); captured += selected.length;
        onOutput({ stream, bytes: selected.length });
      }
      if (selected.length < chunk.length) truncated = true;
    };
    child.stdout.on('data', (data) => consume('stdout', data));
    child.stderr.on('data', (data) => consume('stderr', data));
    const finish = async (code, terminationSignal) => {
      if (closing) return;
      closing = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      // Also terminate lingering descendants after the parent exits.
      killGroup(child);
      let cleanupError = null;
      try { await beginCleanup(); } catch (error) { cleanupError = error.message; }
      if (completed) return;
      completed = true;
      child.stdout.destroy(); child.stderr.destroy();
      resolve({
        status: spawnError ? 'error' : cancelled ? 'cancelled' : timedOut ? 'timeout' :
          code === 0 && !terminationSignal && !cleanupError ? 'passed' : 'failed',
        exitCode: code, signal: terminationSignal, durationMs: Date.now() - started,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
        outputTruncated: truncated, error: spawnError?.message ?? cleanupError,
      });
    };
    const stop = () => {
      killGroup(child);
      void beginCleanup().catch(() => {});
      // Do not wait forever for inherited pipes or an unresponsive runtime.
      forceTimer ??= setTimeout(() => { void finish(null, 'SIGKILL'); }, 6000);
    };
    const onAbort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once('error', (error) => { spawnError = error; void finish(null, null); });
    child.once('exit', (code, sig) => {
      // A background child can keep stdout open after its parent exits.
      killGroup(child);
      forceTimer ??= setTimeout(() => { void finish(code, sig); }, 1000);
    });
    child.once('close', (code, sig) => { void finish(code, sig); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function requiredCheckIds(config) {
  return Object.entries(config.checks).filter(([, check]) => check.required).map(([id]) => id);
}

export function validateCheckIds(ids, config) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !Object.hasOwn(config.checks, id))) {
    throw new Error('Модель запросила неизвестную проверку. Разрешены только идентификаторы из доверенной конфигурации.');
  }
  return [...new Set(ids)];
}

export function checksPassed(results, config) {
  return requiredCheckIds(config).every((id) => results.some((r) => r.id === id && r.status === 'passed')) &&
    results.every((r) => r.status === 'passed');
}

export async function runChecks({ workspace, config, ids = [], signal, emit = () => {}, phase = 'attempt' }) {
  const selected = [...new Set([...requiredCheckIds(config), ...validateCheckIds(ids, config)])];
  const results = [];
  for (const id of selected) {
    signal?.throwIfAborted();
    const check = config.checks[id];
    emit({ type: 'check.started', id, phase, mode: config.execution.mode });
    if (config.execution.mode === 'none') {
      const result = { id, phase, status: 'skipped', exitCode: null, signal: null, durationMs: 0,
        stdout: '', stderr: '', outputTruncated: false, error: 'Исполнение отключено; результат не проверен.' };
      results.push(result); emit({ type: 'check.completed', ...result }); continue;
    }
    let executable, args, cleanup = async () => {};
    if (config.execution.mode === 'docker') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
      const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
      if (uid === 0) throw new Error('Docker runner требует запуска CLI от непривилегированного пользователя: uid=0 запрещён.');
      if (/[\r\n,]/.test(workspace.root)) throw new Error('Путь workspace несовместим с безопасным Docker mount.');
      const name = `code-agent-${randomUUID()}`;
      executable = config.execution.dockerExecutable;
      cleanup = () => removeContainer(executable, name);
      const workMiB = Math.ceil(config.limits.maxSnapshotBytes / (1024 * 1024)) + 64;
      args = [
        'run', '--rm', '--pull', 'never', '--name', name,
        '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true',
        '--user', `${uid}:${gid}`, '--memory', config.execution.memory,
        '--memory-swap', config.execution.memory, '--cpus', String(config.execution.cpus),
        '--pids-limit', String(config.execution.pids),
        '--ulimit', 'nofile=1024:1024',
        '--mount', `type=bind,src=${workspace.root},dst=/source,readonly,bind-propagation=rprivate`,
        '--tmpfs', `/work:rw,nosuid,nodev,size=${workMiB}m,uid=${uid},gid=${gid},mode=0700`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
        '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'CI=1',
        '--env', 'NODE_OPTIONS=', '--env', 'OPENAI_API_KEY=',
        '--env', 'LANG=C.UTF-8', '--env', 'TZ=UTC',
        '--entrypoint', '/bin/sh', config.execution.image,
        // This is a fixed, trusted wrapper; no model-provided string is interpolated.
        '-c', 'cp -a /source/. /work/ && cd /work && exec "$@"',
        'agent-check', check.containerExecutable, ...check.args,
      ];
    } else {
      if (!config.execution.allowLocal || process.platform === 'win32') throw new Error('Локальное исполнение не разрешено.');
      executable = check.executable; args = [...check.args];
    }
    const before = await workspace.fingerprint();
    let result = await execute(executable, args, {
      cwd: workspace.root, signal, timeoutMs: config.limits.checkTimeoutMs,
      outputLimit: config.limits.maxCheckOutputBytes, cleanup,
      onOutput: (event) => emit({ type: 'check.output', id, phase, ...event }),
    });
    // Docker executes a disposable copy; local mode is unsafe and may mutate the tree.
    // Any mutation invalidates this run, even if the test exited with code zero.
    if (!signal?.aborted) {
      const after = await workspace.fingerprint();
      if (before !== after) {
        result = { ...result, status: 'error', error: 'Проверка изменила рабочую копию. Сессия остановлена.' };
        emit({ type: 'check.completed', id, phase, ...result });
        throw new Error(result.error);
      }
    }
    results.push({ id, phase, ...result });
    emit({ type: 'check.completed', id, phase, ...result });
    signal?.throwIfAborted();
    if (result.status === 'error') break;
  }
  return results;
}
