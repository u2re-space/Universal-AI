import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createClient } from '../src/openai/client.js';
import { createSession } from '../src/core/session.js';
import { createLedger } from '../src/core/usage.js';
import { defaults } from '../src/core/config.js';
import { buildUserMessage } from '../src/core/attachments.js';
import { createToolset, enabledToolNames } from '../src/agent/tools.js';
import { runTurn, buildRequestBody, builtinTools } from '../src/agent/loop.js';
import { startMockServer, TINY_PNG } from './helpers/mock-server.js';

let server;
let script = () => ({ text: 'ok' });
let root;
before(async () => {
  server = await startMockServer({ script: (body, index) => script(body, index) });
  root = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-loop-'));
});
beforeEach(() => server.reset());
after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

const config = () => structuredClone({ ...defaults, model: 'mock-model', home: root, baseURL: server.baseURL, image: { ...defaults.image, outputDir: root } });
const client = () => createClient({ apiKey: 'sk-test', baseURL: server.baseURL });

function setup({ approvalLevel = 'all', prompt = 'do it', cfg = config() } = {}) {
  const session = createSession({ store: false, model: 'mock-model' });
  session.addUserMessage(buildUserMessage({ text: prompt }));
  const ledger = createLedger({ prices: { 'mock-model': { input: 1, cachedInput: 0.5, output: 10 }, 'gpt-5.5': { input: 1, cachedInput: 0.5, output: 10 } } });
  const toolset = createToolset({ root, config: cfg, names: enabledToolNames(cfg.tools), approvalLevel, signal: undefined });
  const events = [];
  return { session, ledger, toolset, events, emit: (e) => events.push(e), cfg };
}

test('tool loop: write_file → read_file → final answer; history stays replayable', async () => {
  script = (body, index) => {
    if (index === 0) return { calls: [{ name: 'write_file', arguments: { path: 'notes/hello.txt', content: 'hello world\n', overwrite: true } }], reasoning: 'need to write' };
    if (index === 1) {
      const outputs = body.input.filter((i) => i.type === 'function_call_output');
      assert.equal(outputs.length, 1);
      assert.match(outputs[0].output, /Создан notes\/hello.txt/);
      return { calls: [{ name: 'read_file', arguments: { path: 'notes/hello.txt', start_line: null, end_line: null } }] };
    }
    const lastOutput = body.input.filter((i) => i.type === 'function_call_output').at(-1).output;
    assert.match(lastOutput, /1\| hello world/);
    assert.ok(body.input.some((i) => i.type === 'reasoning' && i.encrypted_content), 'encrypted reasoning is replayed');
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    return { text: 'Файл создан и проверен.' };
  };
  const { session, ledger, toolset, events, emit, cfg } = setup({ cfg: { ...config(), model: 'gpt-5.5' } });
  const result = await runTurn({ client: client(), config: cfg, session, ledger, toolset, emit });
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.turns, 3);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.text, 'Файл создан и проверен.');
  assert.equal(await readFile(path.join(root, 'notes/hello.txt'), 'utf8'), 'hello world\n');
  assert.equal(ledger.snapshot().requests, 3);
  assert.ok(ledger.snapshot().costUsd > 0);
  assert.ok(events.some((e) => e.type === 'tool.exec.done' && e.name === 'write_file' && e.ok));
  assert.deepEqual(toolset.stats().changes.map((c) => c.path), ['notes/hello.txt']);
});

test('read-only policy denies writes and tells the model why', async () => {
  let denied = null;
  script = (body, index) => {
    if (index === 0) return { calls: [{ name: 'write_file', arguments: { path: 'blocked.txt', content: 'x', overwrite: true } }] };
    denied = body.input.filter((i) => i.type === 'function_call_output').at(-1).output;
    return { text: 'cannot write' };
  };
  const { session, ledger, toolset, emit, cfg } = setup({ approvalLevel: 'read' });
  const result = await runTurn({ client: client(), config: cfg, session, ledger, toolset, emit });
  assert.equal(result.status, 'completed');
  assert.match(denied, /отклонена/);
  assert.equal(await stat(path.join(root, 'blocked.txt')).catch(() => null), null);
  assert.equal(toolset.stats().denied, 1);
});

test('path escapes and protected files are refused by tools', async () => {
  const outputs = [];
  script = (body, index) => {
    if (index === 0) return { calls: [
      { name: 'read_file', arguments: { path: '../../outside.txt', start_line: null, end_line: null } },
      { name: 'write_file', arguments: { path: '.env', content: 'SECRET=1', overwrite: true } },
      { name: 'write_file', arguments: { path: 'node_modules/x.js', content: '1', overwrite: true } },
    ] };
    outputs.push(...body.input.filter((i) => i.type === 'function_call_output').map((i) => i.output));
    return { text: 'done' };
  };
  const { session, ledger, toolset, emit, cfg } = setup();
  await runTurn({ client: client(), config: cfg, session, ledger, toolset, emit });
  assert.match(outputs[0], /вне рабочего каталога/);
  assert.match(outputs[1], /секрет/);
  assert.match(outputs[2], /node_modules/);
});

test('max turns limit stops an endless tool loop and settles pending calls', async () => {
  script = () => ({ calls: [{ name: 'list_files', arguments: { path: '.', depth: 1, include_hidden: false } }] });
  const { session, ledger, toolset, emit, cfg } = setup();
  const result = await runTurn({ client: client(), config: cfg, session, ledger, toolset, emit, maxTurns: 2 });
  assert.equal(result.status, 'max_turns');
  assert.equal(result.turns, 2);
  const calls = session.items.filter((i) => i.type === 'function_call').length;
  const outs = session.items.filter((i) => i.type === 'function_call_output').length;
  assert.equal(calls, outs, 'every function_call has an output');
});

test('token budget stops before the next request', async () => {
  script = () => ({ calls: [{ name: 'list_files', arguments: { path: '.', depth: 1, include_hidden: false } }] });
  const { session, toolset, emit, cfg } = setup();
  const ledger = createLedger({ budgetTokens: 150 });
  const result = await runTurn({ client: client(), config: cfg, session, ledger, toolset, emit });
  assert.equal(result.status, 'budget');
  assert.equal(ledger.snapshot().requests, 1);
});

test('generated images are saved to files and summarized in the history', async () => {
  script = () => ({ images: [{ b64: TINY_PNG, partials: [TINY_PNG] }], text: 'Вот картинка.' });
  const { session, ledger, events, emit, cfg } = setup();
  const result = await runTurn({ client: client(), config: cfg, session, ledger, builtin: builtinTools(cfg, { images: true }), emit, imageTarget: path.join(root, 'img') });
  assert.equal(result.status, 'completed');
  assert.equal(result.images.length, 1);
  assert.match(result.images[0], /ai-image-.*-1\.png$/);
  const file = await readFile(result.images[0]);
  assert.equal(file.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(events.some((e) => e.type === 'image.progress'));
  assert.ok(events.some((e) => e.type === 'image.saved'));
  assert.ok(session.items.some((i) => i.type === 'message' && i.content[0].text.includes('сохранено')), 'image call replaced by a note');
  assert.ok(!session.items.some((i) => i.type === 'image_generation_call'));
});

test('failed and incomplete responses are reported', async () => {
  script = () => ({ status: 'failed', streamError: { type: 'server_error', code: 'boom', message: 'exploded' }, error: { code: 'boom', message: 'exploded' } });
  let ctx = setup();
  let result = await runTurn({ client: client(), config: ctx.cfg, session: ctx.session, ledger: ctx.ledger, emit: ctx.emit });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /exploded/);

  script = () => ({ status: 'incomplete', text: 'partial…', reason: 'max_output_tokens' });
  ctx = setup();
  result = await runTurn({ client: client(), config: ctx.cfg, session: ctx.session, ledger: ctx.ledger, emit: ctx.emit });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.text, 'partial…');
  assert.ok(ctx.events.some((e) => e.type === 'warning' && /max_output_tokens/.test(e.message)));
});

test('background mode without streaming polls until completion', async () => {
  script = () => ({ text: 'background done' });
  const ctx = setup({ cfg: { ...config(), stream: false, limits: { ...defaults.limits, pollIntervalMs: 10 } } });
  const result = await runTurn({ client: client(), config: ctx.cfg, session: ctx.session, ledger: ctx.ledger, emit: ctx.emit, background: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'background done');
  const statuses = ctx.events.filter((e) => e.type === 'response.status').map((e) => e.status);
  assert.ok(statuses.includes('queued') || statuses.includes('in_progress'));
  assert.equal(server.requests.find((r) => r.method === 'POST' && r.path === '/v1/responses' && r.body.background).body.store, true);
});

test('buildRequestBody respects model capabilities and configuration', () => {
  const cfg = { ...config(), temperature: 0.3, verbosity: 'low', reasoning: { effort: 'high', summary: 'detailed' }, maxOutputTokens: 500, serviceTier: 'flex' };
  const reasoning = buildRequestBody({ config: cfg, model: 'gpt-5.5', input: [], tools: [{ type: 'web_search' }] });
  assert.deepEqual(reasoning.reasoning, { effort: 'high', summary: 'detailed' });
  assert.equal(reasoning.temperature, undefined);
  assert.deepEqual(reasoning.text, { verbosity: 'low' });
  assert.deepEqual(reasoning.include, ['reasoning.encrypted_content']);
  assert.equal(reasoning.parallel_tool_calls, true);
  assert.equal(reasoning.max_output_tokens, 500);
  assert.equal(reasoning.service_tier, 'flex');
  const classic = buildRequestBody({ config: cfg, model: 'gpt-4.1', input: [] });
  assert.equal(classic.reasoning, undefined);
  assert.equal(classic.temperature, 0.3);
  assert.equal(classic.text, undefined);
  const stored = buildRequestBody({ config: { ...cfg, store: true }, model: 'gpt-5.5', input: [], previousResponseId: 'resp_1' });
  assert.equal(stored.previous_response_id, 'resp_1');
  assert.equal(stored.include, undefined);
});

test('session store mode sends only new items with previous_response_id', async () => {
  const seen = [];
  script = (body) => { seen.push(body); return { text: `answer ${seen.length}` }; };
  const cfg = { ...config(), store: true };
  const session = createSession({ store: true, model: 'mock-model' });
  const ledger = createLedger();
  session.addUserMessage(buildUserMessage({ text: 'first' }));
  await runTurn({ client: client(), config: cfg, session, ledger });
  session.addUserMessage(buildUserMessage({ text: 'second' }));
  await runTurn({ client: client(), config: cfg, session, ledger });
  assert.equal(seen[0].previous_response_id, undefined);
  assert.match(seen[1].previous_response_id, /^resp_/);
  assert.equal(seen[1].input.length, 1, 'only the new user message is sent');
  assert.equal(seen[1].input[0].content[0].text, 'second');
  assert.equal(seen[1].store, true);
});

test('writeFile tool keeps backups when overwriting', async () => {
  await writeFile(path.join(root, 'keep.txt'), 'old');
  script = (body, index) => (index === 0
    ? { calls: [{ name: 'replace_text', arguments: { path: 'keep.txt', search: 'old', replacement: 'new', all: false } }] }
    : { text: 'edited' });
  const cfg = config();
  const session = createSession({ store: false, model: 'mock-model' });
  session.addUserMessage(buildUserMessage({ text: 'edit' }));
  const backupDir = path.join(root, 'backups');
  const toolset = createToolset({ root, config: cfg, names: ['replace_text'], approvalLevel: 'write', backupDir });
  await runTurn({ client: client(), config: cfg, session, ledger: createLedger(), toolset });
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(backupDir, 'keep.txt'), 'utf8'), 'old');
});
