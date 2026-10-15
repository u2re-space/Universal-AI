import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createClient } from '../src/openai/client.js';
import { createLedger } from '../src/core/usage.js';
import { defaults, resolveRole } from '../src/core/config.js';
import { openMemory, projectKey } from '../src/core/memory.js';
import { createSharedContext } from '../src/core/context.js';
import { createRoleRunner } from '../src/agent/roles.js';
import { runTeam } from '../src/agent/team.js';
import { diffHunk, describeChangeSet } from '../src/agent/diff.js';
import { overridesFrom } from '../src/commands/shared.js';
import { startMockServer, TINY_PNG } from './helpers/mock-server.js';

let server;
let script = () => ({ text: 'ok' });
let root;
before(async () => {
  server = await startMockServer({ script: (body, index) => script(body, index) });
  root = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-team-'));
});
beforeEach(() => server.reset());
after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

const baseConfig = () => structuredClone({
  ...defaults, model: 'gpt-6.1-sol', home: root, baseURL: server.baseURL,
  roles: { ...defaults.roles, worker: { ...defaults.roles.worker, model: 'gpt-6-luna' }, collector: { ...defaults.roles.collector, model: 'gpt-6-luna' },
    vision: { ...defaults.roles.vision, model: 'gpt-6-luna-vision' }, summarizer: { ...defaults.roles.summarizer, model: 'gpt-6-luna-nano' } },
  memory: { ...defaults.memory, dbFile: ':memory:' },
});
const client = () => createClient({ apiKey: 'sk-test', baseURL: server.baseURL });

/** Decide the scenario from the request: role is recognisable by the strict schema name / tools. */
function roleOf(body) {
  const format = body.text?.format?.name;
  if (format === 'plan') return 'planner';
  if (format === 'context_report') return 'collector';
  if (format === 'review') return 'reviewer';
  if (format === 'memory_update') return 'summarizer';
  if (body.input.some((i) => i.type === 'message' && i.content?.some?.((c) => c.type === 'input_image'))) return 'vision';
  if (body.model === 'gpt-6-luna-nano') return 'summarizer-file';
  return 'worker';
}

test('resolveRole merges role, default role and top-level settings; --role flags parse', () => {
  const cfg = { ...baseConfig(), reasoning: { effort: 'medium', summary: 'auto' } };
  cfg.roles.default = { ...cfg.roles.default, model: 'default-model' };
  assert.equal(resolveRole(cfg, 'planner').model, 'default-model');
  assert.equal(resolveRole(cfg, 'planner').effort, 'high');
  assert.equal(resolveRole(cfg, 'worker').model, 'gpt-6-luna');
  assert.equal(resolveRole(cfg, 'default').config.model, 'default-model');
  assert.equal(resolveRole(cfg, 'summarizer').config.reasoning.summary, 'none');
  const overrides = overridesFrom({ role: ['planner=gpt-6.1-sol:high', 'worker=gpt-6-luna'], single: true, memory: false });
  assert.deepEqual(overrides.roles, { planner: { model: 'gpt-6.1-sol', effort: 'high' }, worker: { model: 'gpt-6-luna' } });
  assert.deepEqual(overrides.agent, { mode: 'single' });
  assert.deepEqual(overrides.memory, { enabled: false });
  assert.throws(() => overridesFrom({ role: ['nobody=x'] }), /неизвестная роль/);
  assert.equal(Object.keys(overridesFrom({ role: ['all=cheap'] }).roles).length, 13);
});

test('memory store: remember / recall (FTS) / list / forget / tasks / file summaries', () => {
  const memory = openMemory({ file: ':memory:' });
  const project = projectKey(root);
  const a = memory.remember({ scope: 'project', project, projectName: 'demo', kind: 'convention', content: 'Тесты запускаются через vitest, не jest', tags: ['tests'] });
  memory.remember({ scope: 'global', kind: 'preference', content: 'Пользователь предпочитает ответы на русском языке' });
  memory.remember({ scope: 'project', project: 'other', kind: 'fact', content: 'vitest в другом проекте' });
  const hits = memory.recall('как запускать тесты vitest?', { project, limit: 5 });
  assert.ok(hits.some((h) => h.id === a.id), 'project memory found');
  assert.ok(!hits.some((h) => h.project === 'other'), 'other projects are not visible');
  assert.ok(memory.recall('русском', { project }).length === 1, 'global memory visible from any project');
  assert.equal(memory.list({ project }).length, 2);
  // duplicate content updates instead of duplicating
  memory.remember({ scope: 'project', project, kind: 'fact', content: 'Тесты запускаются через vitest, не jest' });
  assert.equal(memory.list({ project }).length, 2);
  assert.ok(memory.forget(a.id));
  assert.equal(memory.list({ project }).length, 1);
  memory.putFileSummary(project, 'src/a.js', 'sha1', 'summary text', 'gpt-6-luna');
  assert.equal(memory.getFileSummary(project, 'src/a.js', 'sha1').summary, 'summary text');
  assert.equal(memory.getFileSummary(project, 'src/a.js', 'sha2'), null, 'stale hash misses');
  memory.recordTask({ project, projectName: 'demo', task: 'do x', status: 'completed', summary: 'done', changes: ['a.js'] });
  assert.equal(memory.listTasks({ project }).length, 1);
  assert.equal(memory.stats().memories, 2);
  memory.close();
});

test('shared context clips low-priority sections to fit the byte budget', () => {
  const ctx = createSharedContext({ task: 't', root: '/r' });
  ctx.set('tree', 'Tree', 'x'.repeat(5000), { priority: 1 });
  ctx.set('plan', 'Plan', 'important plan', { priority: 9 });
  ctx.append('progress', 'Progress', 'step 1 done');
  ctx.append('progress', 'Progress', 'step 2 done');
  const rendered = ctx.render({ maxBytes: 2000 });
  assert.ok(Buffer.byteLength(rendered) <= 2300);
  assert.match(rendered, /important plan/);
  assert.match(rendered, /step 1 done\n\nstep 2 done/);
  assert.match(rendered, /пропущено/);
});

test('diff helpers produce a hunk and a bounded change description', async () => {
  const hunk = diffHunk('a\nb\nc\n', 'a\nB\nc\n');
  assert.match(hunk, /-b\n\+B\n/);
  await writeFile(path.join(root, 'new.txt'), 'hello');
  const text = await describeChangeSet({ root, changes: [{ op: 'create', path: 'new.txt', backupPath: null }, { op: 'delete', path: 'gone.txt', backupPath: null }] });
  assert.match(text, /\+\+\+ new.txt \(new file/);
  assert.match(text, /gone.txt \(deleted\)/);
});

test('team run: planner → collector → worker steps → reviewer (revise → fix → accept) → memory', async () => {
  await writeFile(path.join(root, 'AGENTS.md'), 'Проект: демо. Тесты: node --test.');
  const seen = [];
  let reviews = 0;
  script = (body) => {
    const role = roleOf(body);
    seen.push({ role, model: body.model, effort: body.reasoning?.effort });
    switch (role) {
      case 'planner':
        assert.match(body.input[0].content[0].text, /Проект: демо/, 'project notes are in the shared context');
        assert.match(body.input[0].content[0].text, /Long-term memory/, 'recalled memories are in the shared context');
        return { text: JSON.stringify({ summary: 'Добавить функцию sum', complexity: 'normal', steps: [
          { goal: 'Создать src/sum.js', details: 'export const sum', verify: 'прочитать файл' },
          { goal: 'Создать тест', details: 'test/sum.test.js', verify: 'node --test' } ],
        filesOfInterest: ['package.json'], searchQueries: ['sum'], questionsForCollector: ['Какой test runner?'], acceptanceCriteria: ['sum(1,2)=3'],
        needsReview: true, imageNotes: null, risks: [] }) };
      case 'collector': {
        const outputs = body.input.filter((i) => i.type === 'function_call_output');
        if (!outputs.length) return { calls: [{ name: 'search_files', arguments: { query: 'sum', path: null, regex: false } }] };
        assert.ok(body.tools.every((t) => ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall'].includes(t.name)), 'collector is read-only');
        return { text: JSON.stringify({ findings: [{ path: 'package.json', purpose: 'манифест', relevant: 'нет зависимостей' }], answers: [{ question: 'Какой test runner?', answer: 'node --test' }], conventions: ['ESM'], notes: '' }) };
      }
      case 'worker': {
        const lastUser = [...body.input].reverse().find((i) => i.type === 'message' && i.role === 'user').content[0].text;
        const outputs = body.input.filter((i) => i.type === 'function_call_output');
        if (/step 1/.test(lastUser) && !outputs.length) {
          assert.match(lastUser, /Collected context/, 'worker sees collector findings');
          return { calls: [{ name: 'write_file', arguments: { path: 'src/sum.js', content: 'export const sum = (a, b) => a + b;\n', overwrite: true } }] };
        }
        if (/step 1/.test(lastUser)) return { text: 'Шаг 1: создан src/sum.js' };
        if (/step 2/.test(lastUser) && outputs.length < 2) return { calls: [{ name: 'write_file', arguments: { path: 'test/sum.test.js', content: 'test', overwrite: true } }] };
        if (/step 2/.test(lastUser)) return { text: 'Шаг 2: создан тест' };
        if (/Review round/.test(lastUser) && outputs.length < 3) return { calls: [{ name: 'replace_text', arguments: { path: 'src/sum.js', search: 'a + b', replacement: 'Number(a) + Number(b)', all: false } }] };
        return { text: 'Исправлено по замечаниям' };
      }
      case 'reviewer': {
        reviews++;
        const doc = body.input[0].content[0].text;
        assert.match(doc, /Changes made by the worker/, 'reviewer sees the diff');
        assert.match(doc, /\+\+\+ src\/sum.js \(new file/);
        if (reviews === 1) return { text: JSON.stringify({ verdict: 'revise', summary: 'Нет приведения типов', issues: [{ severity: 'medium', path: 'src/sum.js', message: 'строки конкатенируются', requestedChange: 'привести к Number' }], unverified: [] }) };
        assert.match(doc, /Number\(a\)/, 'second review sees the fix');
        return { text: JSON.stringify({ verdict: 'accept', summary: 'Готово', issues: [], unverified: [] }) };
      }
      case 'summarizer':
        return { text: JSON.stringify({ taskSummary: 'Добавлена функция sum с тестом.', memories: [
          { scope: 'project', kind: 'convention', content: 'Тесты в проекте запускаются через node --test', tags: ['tests'] },
          { scope: 'global', kind: 'preference', content: 'Пользователь просит отчёты по-русски', tags: [] } ] }) };
      default:
        return { text: 'unexpected' };
    }
  };
  const config = baseConfig();
  const memory = openMemory({ file: ':memory:' });
  const key = projectKey(root);
  memory.remember({ scope: 'project', project: key, kind: 'fact', content: 'Тесты в проекте пишутся на node:test; функции экспортируются как ESM', tags: ['esm'] });
  const ledger = createLedger({ prices: { 'gpt-6.1-sol': { input: 10, output: 30 }, 'gpt-6-luna': { input: 1, output: 2 }, 'gpt-6-luna-nano': { input: 0.1, output: 0.4 } } });
  const events = [];
  const result = await runTeam({ client: client(), config, ledger, task: 'Добавь функцию sum с тестом', root, approvalLevel: 'all', memory, projectKey: key,
    projectName: 'demo', emit: (e) => events.push(e) });
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.steps.length, 3, 'two steps + one fix round');
  assert.equal(result.review.verdict, 'accept');
  assert.equal(result.reviewRounds, 2);
  assert.equal(await readFile(path.join(root, 'src/sum.js'), 'utf8'), 'export const sum = (a, b) => Number(a) + Number(b);\n');
  assert.deepEqual(result.changes.map((c) => c.path), ['src/sum.js', 'test/sum.test.js', 'src/sum.js']);
  assert.equal(result.memoriesSaved.length, 2);
  assert.equal(memory.listTasks({ project: key }).length, 1);
  assert.equal(result.recalled.length, 1);
  // Every role used its own model and effort.
  const planner = seen.find((s) => s.role === 'planner');
  assert.equal(planner.model, 'gpt-6.1-sol');
  assert.equal(planner.effort, 'high');
  assert.ok(seen.filter((s) => s.role === 'worker').every((s) => s.model === 'gpt-6-luna' && s.effort === 'medium'));
  assert.equal(seen.find((s) => s.role === 'collector').model, 'gpt-6-luna');
  assert.equal(seen.find((s) => s.role === 'summarizer').model, 'gpt-6-luna-nano');
  const stages = events.filter((e) => e.type === 'stage.start').map((e) => e.stage);
  assert.deepEqual(stages, ['plan', 'collect', 'work', 'review', 'fix', 'review', 'memory']);
  assert.ok(events.some((e) => e.type === 'plan.ready' && e.steps.length === 2));
  assert.ok(events.some((e) => e.type === 'memory.saved' && e.count === 2));
  const byRole = Object.fromEntries(ledger.snapshot().byRole.map((r) => [r.role, r]));
  assert.ok(byRole.planner.requests === 1 && byRole.worker.requests >= 5 && byRole.reviewer.requests === 2 && byRole.summarizer.requests === 1);
  assert.ok(ledger.snapshot().costKnown);
  // Structured role outputs were not streamed as answer text.
  assert.ok(!events.some((e) => e.type === 'text.delta' && /"verdict"/.test(e.text)));
  memory.close();
});

test('team run: trivial plan skips collector and review; worker failure marks the run incomplete', async () => {
  script = (body) => {
    const role = roleOf(body);
    if (role === 'planner') return { text: JSON.stringify({ summary: 'мелочь', complexity: 'trivial', steps: [{ goal: 'сделать', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
    if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
    return { status: 'incomplete', text: 'oops', reason: 'max_output_tokens' };
  };
  const config = { ...baseConfig(), memory: { ...defaults.memory, enabled: false } };
  const events = [];
  const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'мелкая правка', root, approvalLevel: 'read', emit: (e) => events.push(e) });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(events.filter((e) => e.type === 'stage.start').map((e) => e.stage), ['plan', 'work']);
});

test('team run stops on budget and reports the stage', async () => {
  script = (body) => (roleOf(body) === 'planner'
    ? { text: JSON.stringify({ summary: 's', complexity: 'normal', steps: [{ goal: 'a', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: true, imageNotes: null, risks: [] }) }
    : { text: 'done' });
  const result = await runTeam({ client: client(), config: baseConfig(), ledger: createLedger({ budgetTokens: 150 }), task: 'x', root, approvalLevel: 'read' });
  assert.equal(result.status, 'budget');
  assert.match(result.error.message, /лимит токенов/i);
});

test('role runner: vision delegation and file summaries with cache', async () => {
  await writeFile(path.join(root, 'pic.png'), Buffer.from(TINY_PNG, 'base64'));
  await writeFile(path.join(root, 'big.js'), 'export function a() {}\n'.repeat(50));
  let visionCalls = 0, summaryCalls = 0;
  script = (body) => {
    const role = roleOf(body);
    if (role === 'vision') { visionCalls++; assert.equal(body.model, 'gpt-6-luna-vision'); return { text: 'Красная точка 1×1.' }; }
    if (role === 'summarizer-file') { summaryCalls++; return { text: 'Файл экспортирует функцию a.' }; }
    const outputs = body.input.filter((i) => i.type === 'function_call_output');
    if (outputs.length === 0) return { calls: [{ name: 'view_image', arguments: { path: 'pic.png', detail: 'auto', question: 'что на картинке?' } }, { name: 'summarize_file', arguments: { path: 'big.js', focus: null } }] };
    if (outputs.length === 2) {
      assert.match(outputs[0].output, /модель vision/);
      assert.match(outputs[0].output, /Красная точка/);
      assert.match(outputs[1].output, /экспортирует функцию a/);
      return { calls: [{ name: 'summarize_file', arguments: { path: 'big.js', focus: null } }] };
    }
    assert.match(outputs[2].output, /из кеша/);
    return { text: 'готово' };
  };
  const config = baseConfig();
  const ledger = createLedger();
  const memory = openMemory({ file: ':memory:' });
  const { createToolset } = await import('../src/agent/tools.js');
  const roles = createRoleRunner({ client: client(), config, ledger });
  assert.equal(roles.shouldDelegateVision('worker'), true);
  const toolset = createToolset({ root, config, names: ['view_image', 'summarize_file'], approvalLevel: 'read', memory, projectKey: projectKey(root),
    describeImage: roles.describeImage, summarizeFile: roles.summarizeFile });
  const result = await roles.run('worker', { text: 'посмотри картинку и файл', toolset, maxTurns: 5 });
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(visionCalls, 1);
  assert.equal(summaryCalls, 1, 'second summary served from cache');
  assert.equal(memory.stats().fileSummaries, 1);
  memory.close();
});

test('team run puts the confirmed read file in the collector brief', async () => {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'sum.js'), 'export function sum(a, b) { return a + b; }\n');
  const seen = [];
  script = (body) => {
    const role = roleOf(body);
    seen.push(body);
    if (role === 'planner') return { text: JSON.stringify({ summary: 's', complexity: 'normal', steps: [{ goal: 'прочитать', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [], taskMap: [{ path: 'src/sum.js', role: 'read', reason: 'функция sum' }, { path: 'missing.js', role: 'edit', reason: 'нет файла' }] }) };
    if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [], conventions: [], notes: '' }) };
    if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
    return { text: 'ok' };
  };
  const result = await runTeam({ client: client(), config: baseConfig(), ledger: createLedger(), task: 'sum', root, approvalLevel: 'read', emit() {} });
  assert.equal(result.status, 'completed', result.error?.message);
  const collector = seen.find((body) => roleOf(body) === 'collector');
  assert.match(collector.input[0].content[0].text, /src\/sum\.js/);
  assert.equal(/missing\.js/.test(collector.input[0].content[0].text), false);
});
