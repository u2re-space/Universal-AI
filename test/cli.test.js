import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMockServer, TINY_PNG } from './helpers/mock-server.js';
import { createJobManager } from '../src/jobs/manager.js';
import { stripDetach } from '../src/cli.js';

const bin = fileURLToPath(new URL('../bin/ai.js', import.meta.url));
let server;
let script = () => ({ text: 'ok' });
let home;
let work;

before(async () => {
  server = await startMockServer({ script: (body, index) => script(body, index) });
  home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-home-'));
  work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-work-'));
});
beforeEach(() => server.reset());
after(async () => { await server.close(); await rm(home, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); });

function runCli(args, { input = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: work, env: { ...process.env, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: server.baseURL, AI_AGENT_HOME: home, AI_MODEL: 'mock-model', NO_COLOR: '1', ...env },
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== null) { child.stdin.end(input); }
  });
}
const jsonLines = (stdout) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('ask: prints the answer, logs usage, exits 0', async () => {
  script = () => ({ text: 'Ответ модели', reasoning: 'коротко подумал' });
  const { code, stdout, stderr } = await runCli(['ask', 'привет']);
  assert.equal(code, 0);
  assert.match(stdout, /Ответ модели/);
  assert.match(stderr, /коротко подумал/);
  assert.match(stderr, /↑ 100/);
  assert.match(stderr, /статус: завершено/);
});

test('ask with --json emits events and a final result object', async () => {
  script = (body) => {
    assert.equal(body.input.at(-1).content[0].text, 'json please');
    return { text: 'structured' };
  };
  const { code, stdout } = await runCli(['json please', '--json']);
  assert.equal(code, 0);
  const lines = jsonLines(stdout);
  const result = lines.find((l) => l.type === 'result');
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'structured');
  assert.equal(result.usage.requests, 1);
  assert.ok(lines.some((l) => l.type === 'text.delta'));
});

test('stdin is attached as context and --out saves the answer; --image sends input_image', async () => {
  await writeFile(path.join(work, 'pic.png'), Buffer.from(TINY_PNG, 'base64'));
  let seenBody = null;
  script = (body) => { seenBody = body; return { text: 'saved answer' }; };
  const { code } = await runCli(['опиши', '--image', 'pic.png', '--detail', 'low', '--out', 'out/answer.md', '--quiet'], { input: 'piped context' });
  assert.equal(code, 0);
  const content = seenBody.input.at(-1).content;
  assert.deepEqual(content.map((c) => c.type), ['input_text', 'input_image', 'input_text']);
  assert.match(content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(content[1].detail, 'low');
  assert.match(content[2].text, /piped context/);
  assert.equal(await readFile(path.join(work, 'out/answer.md'), 'utf8'), 'saved answer\n');
});

test('run: agent edits a file through tools with --approve write and reports changes', async () => {
  script = (body, index) => {
    if (index === 0) {
      assert.ok(body.tools.some((t) => t.type === 'function' && t.name === 'write_file' && t.strict === true));
      assert.match(body.instructions, /autonomous/);
      return { calls: [{ name: 'write_file', arguments: { path: 'hello.js', content: 'console.log(1)\n', overwrite: true } }] };
    }
    return { text: 'Готово: создан hello.js' };
  };
  const { code, stdout, stderr } = await runCli(['run', 'создай hello.js', '--approve', 'write', '--single']);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Готово/);
  assert.match(stderr, /write_file hello\.js/);
  assert.match(stderr, /изменения: \+ hello\.js/);
  assert.equal(await readFile(path.join(work, 'hello.js'), 'utf8'), 'console.log(1)\n');
});

test('run without approval in non-interactive mode is read-only', async () => {
  script = (body, index) => (index === 0
    ? { calls: [{ name: 'write_file', arguments: { path: 'nope.txt', content: 'x', overwrite: true } }] }
    : { text: body.input.at(-1).output });
  const { code, stdout, stderr } = await runCli(['run', 'write something', '--single']);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /отклонена/);
  assert.match(stderr, /только читать/);
});

test('image: forces the image_generation tool and saves files to --out', async () => {
  script = (body) => {
    assert.deepEqual(body.tool_choice, { type: 'image_generation' });
    assert.ok(body.tools.some((t) => t.type === 'image_generation' && t.output_format === 'png'));
    return { images: [{ b64: TINY_PNG }], text: 'Кот нарисован.' };
  };
  const { code, stdout, stderr } = await runCli(['image', 'кот', '--out', 'pics/cat.png', '--json']);
  assert.equal(code, 0, stderr);
  const result = jsonLines(stdout).find((l) => l.type === 'result');
  assert.equal(result.images.length, 1);
  assert.equal(path.basename(result.images[0]), 'cat.png');
  const png = await readFile(result.images[0]);
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
});

test('--schema sends a strict json_schema text format', async () => {
  await writeFile(path.join(work, 'schema.json'), JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }));
  script = (body) => {
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, 'schema');
    return { text: '{"ok":true}' };
  };
  const { code, stdout } = await runCli(['верни json', '--schema', 'schema.json', '--quiet']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).ok, true);
});

test('--background waits for a queued response (non-stream) and resume prints a finished one', async () => {
  script = () => ({ text: 'фоновый результат' });
  const { code, stdout } = await runCli(['фон', '--background', '--no-stream', '--json'], { env: { AI_POLL_MS: '10' } });
  assert.equal(code, 0);
  const result = jsonLines(stdout).find((l) => l.type === 'result');
  assert.equal(result.text, 'фоновый результат');
  const resumed = await runCli(['resume', result.responseId, '--quiet']);
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, /фоновый результат/);
});

test('API errors produce exit code 1 with a readable message; usage errors exit 2', async () => {
  script = () => ({ httpStatus: 401, httpBody: { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } } });
  const failed = await runCli(['test']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Incorrect API key/);
  const usage = await runCli(['--effort', 'bogus', 'x']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--effort/);
  const nokey = await runCli(['x'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(nokey.code, 2);
  assert.match(nokey.stderr, /OPENAI_API_KEY/);
});

test('--detach starts a job that can be inspected with jobs status/result', async () => {
  script = () => ({ text: 'результат фоновой задачи' });
  const started = await runCli(['run', 'фоновая задача', '--detach', '--approve', 'all', '--json', '--single', '--no-memory']);
  assert.equal(started.code, 0, started.stderr);
  const { id } = jsonLines(started.stdout).find((l) => l.type === 'job.started');
  const manager = createJobManager({ home });
  const job = await manager.wait(id, { pollMs: 100 });
  assert.equal(job.meta.status, 'completed', JSON.stringify(job.meta));
  assert.equal(job.result.text, 'результат фоновой задачи');
  assert.ok(job.status?.ledger?.input >= 100);
  const status = await runCli(['jobs', 'status', id.slice(0, 12)]);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /статус: завершена/);
  const result = await runCli(['jobs', 'result', id]);
  assert.match(result.stdout, /результат фоновой задачи/);
  const list = await runCli(['jobs', 'list']);
  assert.match(list.stdout, new RegExp(id));
  const log = await runCli(['jobs', 'log', id]);
  assert.match(log.stdout, /результат: completed/);
});

test('run (team mode): roles use their own models; memory command sees what was saved', async () => {
  const roleOf = (body) => body.text?.format?.name ?? (body.model === 'gpt-6-luna-nano' ? 'summarizer-file' : 'worker');
  const models = {};
  script = (body) => {
    const role = roleOf(body);
    models[role] = body.model;
    if (role === 'plan') return { text: JSON.stringify({ summary: 'Создать файл заметки', complexity: 'trivial', steps: [{ goal: 'Создать note.txt', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
    if (role === 'memory_update') return { text: JSON.stringify({ taskSummary: 'Создан note.txt', memories: [{ scope: 'project', kind: 'convention', content: 'Заметки хранятся в note.txt в корне', tags: ['notes'] }] }) };
    const outputs = body.input.filter((i) => i.type === 'function_call_output');
    if (!outputs.length) return { calls: [{ name: 'write_file', arguments: { path: 'note.txt', content: 'привет\n', overwrite: true } }] };
    return { text: 'Файл note.txt создан.' };
  };
  const { code, stdout, stderr } = await runCli(['run', 'создай note.txt', '--approve', 'write', '--role', 'planner=gpt-6.1-sol:high', '--role', 'worker=gpt-6-luna', '--role', 'summarizer=gpt-6-luna-nano']);
  assert.equal(code, 0, stderr);
  assert.equal(models.plan, 'gpt-6.1-sol');
  assert.equal(models.worker, 'gpt-6-luna');
  assert.equal(models.memory_update, 'gpt-6-luna-nano');
  assert.match(stdout, /note\.txt создан/);
  assert.match(stderr, /этап «план» — planner · gpt-6\.1-sol/);
  assert.match(stderr, /шаг 1\/1/);
  assert.match(stderr, /память: сохранено 1/);
  assert.match(stderr, /по ролям/);
  assert.equal(await readFile(path.join(work, 'note.txt'), 'utf8'), 'привет\n');

  const list = await runCli(['memory', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /Заметки хранятся в note\.txt/);
  const search = await runCli(['memory', 'search', 'заметки', '--json']);
  assert.equal(jsonLines(search.stdout).find((l) => l.type === 'memories').items.length, 1);
  const added = await runCli(['memory', 'add', 'Пользователь любит короткие ответы', '--global', '--kind', 'preference', '--json']);
  const { item } = jsonLines(added.stdout).find((l) => l.type === 'memory.saved');
  assert.equal(item.scope, 'global');
  const tasks = await runCli(['memory', 'tasks']);
  assert.match(tasks.stdout, /создай note\.txt/);
  const forgotten = await runCli(['memory', 'forget', String(item.id)]);
  assert.equal(forgotten.code, 0);
  const stats = await runCli(['memory', 'stats', '--json']);
  assert.equal(jsonLines(stats.stdout).find((l) => l.type === 'memory.stats').memories, 1);
});

test('models and config commands work', async () => {
  const models = await runCli(['models', 'gpt']);
  assert.equal(models.code, 0);
  assert.match(models.stdout, /gpt-6\.1-sol/);
  const config = await runCli(['config', 'show', '--json']);
  const data = jsonLines(config.stdout).find((l) => l.type === 'config');
  assert.equal(data.config.model, 'mock-model');
  assert.match(data.config.apiKey, /…/);
});

test('stripDetach removes the flag from raw argv including short groups', () => {
  assert.deepEqual(stripDetach(['run', 'x', '--detach', '-dv', '-d', '--yes']), ['run', 'x', '-v', '--yes']);
});

test('map writes .ai/map.json without an API key', async () => {
  for (const name of await readdir(work)) await rm(path.join(work, name), { recursive: true, force: true });
  await writeFile(path.join(work, 'a.js'), 'export function hello() {}\n');
  const built = await runCli(['map'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(built.code, 0, built.stderr);
  const shown = await runCli(['map', 'path'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /\.ai[/\\]map\.json/);
  assert.match(shown.stdout, /файлов: 1/);
  const unknown = await runCli(['map', 'nope'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(unknown.code, 2);
});

test('package manifest name is universal-ai', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'universal-ai');
  assert.equal(pkg.bin.ai, './bin/ai.js');
});
