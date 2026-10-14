import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, readFile, writeFile, readdir, open, stat, rename, appendFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { timestampSlug } from '../util/text.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2));
  await rename(temp, file);
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/**
 * Local background jobs: a detached copy of the CLI running with --json, whose event stream,
 * live status and final result are stored under <home>/jobs/<id>/.
 *
 *   meta.json    — static description + lifecycle (pid, status, timestamps)
 *   status.json  — live status written by the child (phase, tokens, cost, last action)
 *   events.jsonl — every event (the child's --json stdout)
 *   stderr.log   — the child's stderr
 *   result.json  — final result (text, files, images, usage)
 */
export function createJobManager({ home }) {
  const root = path.join(home, 'jobs');
  const dirOf = (id) => path.join(root, id);

  async function resolveId(prefix) {
    if (!prefix) throw new Error('Укажите идентификатор задачи.');
    const ids = await readdir(root).catch(() => []);
    if (ids.includes(prefix)) return prefix;
    const matches = ids.filter((id) => id.startsWith(prefix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Неоднозначный идентификатор ${prefix}: ${matches.join(', ')}`);
    throw new Error(`Задача не найдена: ${prefix}`);
  }

  async function create({ title, argv, cwd }) {
    const id = `${timestampSlug()}-${randomBytes(2).toString('hex')}`;
    const dir = dirOf(id);
    await mkdir(dir, { recursive: true });
    const meta = { id, title, argv, cwd, createdAt: new Date().toISOString(), status: 'created', pid: null, startedAt: null, finishedAt: null, exitCode: null };
    await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    return { id, dir, meta };
  }

  /** Spawn `node <script> ...argv --json --job <id>` detached from this terminal. */
  async function spawnDetached({ id, script, argv, cwd }) {
    const dir = dirOf(id);
    const meta = await readJson(path.join(dir, 'meta.json'));
    if (!meta) throw new Error(`Задача ${id} не найдена.`);
    const outFd = openSync(path.join(dir, 'events.jsonl'), 'a');
    const errFd = openSync(path.join(dir, 'stderr.log'), 'a');
    try {
      const child = spawn(process.execPath, [script, ...argv, '--json', '--job', id], {
        cwd, detached: true, stdio: ['ignore', outFd, errFd], windowsHide: true,
        env: { ...process.env, AI_AGENT_JOB: id },
      });
      child.unref();
      meta.pid = child.pid; meta.status = 'running'; meta.startedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      return child.pid;
    } finally {
      closeSync(outFd); closeSync(errFd);
    }
  }

  async function get(prefix) {
    const id = await resolveId(prefix);
    const dir = dirOf(id);
    const meta = await readJson(path.join(dir, 'meta.json'), { id, status: 'unknown' });
    const status = await readJson(path.join(dir, 'status.json'), null);
    const result = await readJson(path.join(dir, 'result.json'), null);
    if (meta.status === 'running' && !isProcessAlive(meta.pid)) {
      meta.status = result ? result.status === 'completed' ? 'completed' : 'failed' : 'failed';
      meta.finishedAt ??= new Date().toISOString();
      meta.note = result ? undefined : 'процесс завершился без результата';
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta).catch(() => {});
    }
    return { id, dir, meta, status, result };
  }

  async function list() {
    const ids = (await readdir(root).catch(() => [])).sort().reverse();
    const jobs = [];
    for (const id of ids) {
      try { jobs.push(await get(id)); } catch { /* skip broken dirs */ }
    }
    return jobs;
  }

  async function cancel(prefix) {
    const job = await get(prefix);
    const { meta } = job;
    if (TERMINAL.has(meta.status)) return { ...job, alreadyFinished: true };
    if (isProcessAlive(meta.pid)) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/pid', String(meta.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.once('close', resolve); killer.once('error', resolve);
        });
      } else {
        try { process.kill(meta.pid, 'SIGTERM'); } catch { /* already gone */ }
        for (let i = 0; i < 20 && isProcessAlive(meta.pid); i++) await sleep(250);
        if (isProcessAlive(meta.pid)) { try { process.kill(meta.pid, 'SIGKILL'); } catch { /* ignore */ } }
      }
    }
    meta.status = 'cancelled'; meta.finishedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(job.dir, 'meta.json'), meta);
    return { ...job, meta };
  }

  async function remove(prefix) {
    const job = await get(prefix);
    if (job.meta.status === 'running') throw new Error('Сначала остановите задачу (jobs cancel).');
    await rm(job.dir, { recursive: true, force: true });
    return job.id;
  }

  /** Async iterator over events.jsonl lines; with follow=true keeps tailing until the job ends. */
  async function* tail(prefix, { follow = false, signal, pollMs = 500 } = {}) {
    const job = await get(prefix);
    const file = path.join(job.dir, 'events.jsonl');
    let offset = 0;
    let rest = '';
    for (;;) {
      signal?.throwIfAborted();
      const info = await stat(file).catch(() => null);
      if (info && info.size > offset) {
        const handle = await open(file, 'r');
        try {
          const buffer = Buffer.alloc(info.size - offset);
          await handle.read(buffer, 0, buffer.length, offset);
          offset = info.size;
          const chunk = rest + buffer.toString('utf8');
          const lines = chunk.split('\n');
          rest = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) yield line;
        } finally { await handle.close(); }
      }
      if (!follow) break;
      const current = await get(job.id);
      if (TERMINAL.has(current.meta.status)) {
        // One last read to flush whatever was written right before exit.
        const final = await stat(file).catch(() => null);
        if (!final || final.size <= offset) break;
        continue;
      }
      await sleep(pollMs, undefined, { signal });
    }
    if (rest.trim()) yield rest;
  }

  async function wait(prefix, { signal, pollMs = 1000 } = {}) {
    for (;;) {
      const job = await get(prefix);
      if (TERMINAL.has(job.meta.status)) return job;
      await sleep(pollMs, undefined, { signal });
    }
  }

  /**
   * Child-side reporter: call from the CLI when running with --job <id>.
   * Writes status.json (throttled), result.json and the final meta status.
   */
  function reporter(id) {
    const dir = dirOf(id);
    let pending = null;
    let lastWrite = 0;
    const live = { phase: '', detail: '', updatedAt: null, ledger: null, turn: null, lastAction: null };
    async function flush() {
      pending = null; lastWrite = Date.now();
      live.updatedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(dir, 'status.json'), live).catch(() => {});
    }
    function schedule() {
      if (pending) return;
      const delay = Math.max(0, 500 - (Date.now() - lastWrite));
      pending = setTimeout(flush, delay);
      pending.unref?.();
    }
    return {
      status({ phase, detail }) { live.phase = phase; live.detail = detail; schedule(); },
      event(event) {
        if (event.type === 'response.done') live.ledger = event.ledger ?? live.ledger;
        if (event.type === 'turn.start') live.turn = `${event.turn}/${event.maxTurns}`;
        if (event.type === 'tool.exec.start') live.lastAction = `${event.name}`;
        if (event.type === 'image.saved') live.lastAction = `image → ${event.path}`;
        schedule();
      },
      async finish(result, exitCode) {
        if (pending) clearTimeout(pending);
        await flush();
        await writeJsonAtomic(path.join(dir, 'result.json'), result).catch(() => {});
        const meta = await readJson(path.join(dir, 'meta.json'), { id });
        meta.status = result?.status === 'completed' ? 'completed' : result?.status === 'cancelled' ? 'cancelled' : 'failed';
        meta.finishedAt = new Date().toISOString();
        meta.exitCode = exitCode;
        await writeJsonAtomic(path.join(dir, 'meta.json'), meta).catch(() => {});
      },
      async note(text) { await appendFile(path.join(dir, 'stderr.log'), `${new Date().toISOString()} ${text}\n`).catch(() => {}); },
    };
  }

  return { root, create, spawnDetached, get, list, cancel, remove, tail, wait, reporter, resolveId };
}
