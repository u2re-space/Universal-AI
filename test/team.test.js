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
    pace: { ...defaults.pace, quality: 20 },
    roles: { ...defaults.roles, worker: { ...defaults.roles.worker, model: 'gpt-6-luna' }, collector: { ...defaults.roles.collector, model: 'gpt-6-luna' },
        vision: { ...defaults.roles.vision, model: 'gpt-6-luna-vision' }, summarizer: { ...defaults.roles.summarizer, model: 'gpt-6-luna-nano' } },
    memory: { ...defaults.memory, dbFile: ':memory:' },
});
const client = () => createClient({ apiKey: 'sk-test', baseURL: server.baseURL });

/** Decide the scenario from the request: role is recognisable by the strict schema name / tools. */
function roleOf(body) {
    const format = body.text?.format?.name;
    if (format === 'plan') return 'planner';
    if (format === 'file_commands') return 'encoder';
    if (format === 'context_report') return 'collector';
    if (format === 'review') return 'reviewer';
    if (format === 'memory_update') return 'summarizer';
    if (format === 'task_label') return 'classifier';
    if (typeof body.instructions === 'string' && body.instructions.includes('route: encode')) return 'answer';
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
    assert.equal(Object.keys(overridesFrom({ role: ['all=cheap'] }).roles).length, 16);
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
            case 'answer':
                return { text: 'Черновик без кода.\nroute: plan' };
            case 'classifier':
                return { text: JSON.stringify({ label: 'normal' }) };
            case 'planner':
                assert.match(body.input[0].content[0].text, /Проект: демо/, 'project notes are in the shared context');
                assert.match(body.input[0].content[0].text, /Long-term memory/, 'recalled memories are in the shared context');
                return { text: JSON.stringify({ summary: 'Добавить функцию sum', complexity: 'normal', steps: [
                    { goal: 'Создать src/sum.js', details: 'export const sum', verify: 'прочитать файл', complexity: 'normal' },
                    { goal: 'Создать тест', details: 'test/sum.test.js', verify: 'node --test', complexity: 'normal' } ],
                filesOfInterest: ['package.json'], searchQueries: ['sum'], questionsForCollector: ['Какой test runner?'], acceptanceCriteria: ['sum(1,2)=3'],
                needsReview: true, imageNotes: null, risks: [] }) };
            case 'collector': {
                const outputs = body.input.filter((i) => i.type === 'function_call_output');
                if (!outputs.length) return { calls: [{ name: 'search_files', arguments: { query: 'sum', path: null, regex: false } }] };
                assert.ok(body.tools.every((t) => ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall', 'list_backups'].includes(t.name)), 'collector is read-only');
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
    config.pace = { ...defaults.pace, quality: 80 };
    const memory = openMemory({ file: ':memory:' });
    const key = projectKey(root);
    memory.remember({ scope: 'project', project: key, kind: 'fact', content: 'Тесты в проекте пишутся на node:test; функции экспортируются как ESM', tags: ['esm'] });
    const ledger = createLedger({ prices: { 'gpt-6.1-sol': { input: 10, output: 30 }, 'gpt-6-luna': { input: 1, output: 2 }, 'gpt-6-luna-nano': { input: 0.1, output: 0.4 }, 'gpt-6-astra': { input: 20, output: 60 } } });
    const events = [];
    const result = await runTeam({ client: client(), config, ledger, task: 'Добавь функцию sum с тестом', root, approvalLevel: 'all', memory, projectKey: key,
        projectName: 'demo', emit: (e) => events.push(e) });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(result.plan.steps.length, 3);
    assert.equal(result.plan.steps.at(-1).kind, 'compat');
    assert.equal(result.steps.length, 4, 'two file steps + compatibility + one fix round');
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
    assert.deepEqual(stages, ['answer', 'plan', 'collect', 'work', 'review', 'fix', 'review', 'memory']);
    assert.ok(events.some((e) => e.type === 'plan.ready' && e.steps.length === 3));
    const { readdir } = await import('node:fs/promises');
    const progresses = [];
    for (const id of await readdir(path.join(root, '.tmp'))) {
        const file = path.join(root, '.tmp', id, 'progress.json');
        const saved = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
        if (saved?.task === 'Добавь функцию sum с тестом') progresses.push(saved);
    }
    assert.equal(progresses.at(-1)?.status, 'completed');
    assert.equal(progresses.at(-1).files.some((file) => file.path === 'src/sum.js'), true);
    assert.equal(progresses.at(-1).files.some((file) => file.path === 'test/sum.test.js'), true);
    assert.ok(events.some((e) => e.type === 'memory.saved' && e.count === 2));
    const byRole = Object.fromEntries(ledger.snapshot().byRole.map((r) => [r.role, r]));
    assert.ok(byRole.planner.requests === 1 && byRole.coder.requests >= 5 && byRole.reviewer.requests === 2 && byRole.summarizer.requests === 1);
    assert.ok(ledger.snapshot().costKnown);
    // Structured role outputs were not streamed as answer text.
    assert.ok(!events.some((e) => e.type === 'text.delta' && /"verdict"/.test(e.text)));
    memory.close();
});

test('team run: trivial plan skips collector and review; worker failure marks the run incomplete', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'ok\nroute: plan' };
        if (role === 'planner') return { text: JSON.stringify({ summary: 'мелочь', complexity: 'trivial', steps: [{ goal: 'сделать', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
        return { status: 'incomplete', text: 'oops', reason: 'max_output_tokens' };
    };
    const config = { ...baseConfig(), memory: { ...defaults.memory, enabled: false } };
    const events = [];
    const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'мелкая правка', root, approvalLevel: 'read', emit: (e) => events.push(e) });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(events.filter((e) => e.type === 'stage.start').map((e) => e.stage), ['answer', 'plan', 'work']);
});

test('team run stops on budget and reports the stage', async () => {
    script = (body) => (roleOf(body) === 'answer' ? { text: 'ok\nroute: plan' } : roleOf(body) === 'planner'
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

test('encode branch writes the file and does not call the planner', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: '```js\nexport const n = 1;\n```\nroute: encode' };
        if (role === 'encoder') {
            assert.match(JSON.stringify(body.input), /# Directory tree/);
            return { text: JSON.stringify({ summary: 'файл', commands: [{
                command: 'fs:write', path: 'out.js', cwd: '.', type: 'code', language: 'js',
                content: 'export const n = 1;\n', lines: null, source: null, start: null, end: null,
            }] }) };
        }
        return { text: 'planner' };
    };
    const result = await runTeam({ client: client(), config: baseConfig(), ledger: createLedger(), task: 'запиши модуль', root, approvalLevel: 'all', emit() {} });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(result.plan, null);
    assert.equal(await readFile(path.join(root, 'out.js'), 'utf8'), 'export const n = 1;\n');
});

test('a plan list stores a nested directory for the next role', async () => {
    await mkdir(path.join(root, 'src', 'util'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.js'), 'export {}\n');
    await writeFile(path.join(root, 'src', 'util', 'text.js'), 'export {}\n');
    let plannerSawTree = false;
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Нужен список.\nroute: plan' };
        if (role === 'planner') {
            plannerSawTree = JSON.stringify(body.input).includes('# Directory tree') && JSON.stringify(body.input).includes('src/');
            return { text: JSON.stringify({ summary: 's', complexity: 'trivial', steps: [{ goal: 'посмотреть', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [], fileActions: [{ action: 'list', source: null, path: 'src', cwd: '.', language: null, reason: 'дерево', start: null, end: null, depth: 3, mode: 'tree' }] }) };
        }
        return { text: 'ok' };
    };
    const result = await runTeam({ client: client(), config: { ...baseConfig(), memory: { ...defaults.memory, enabled: false } }, ledger: createLedger(), task: 'покажи дерево', root, approvalLevel: 'read', emit() {} });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(plannerSawTree, true);
    const { readdir } = await import('node:fs/promises');
    const docs = await Promise.all((await readdir(path.join(root, '.tmp'))).map(async (id) => JSON.parse(await readFile(path.join(root, '.tmp', id, 'handoff.json'), 'utf8'))));
    assert.equal(docs.some((handoff) => handoff.artifacts.some((item) => item.hintLanguage === 'tree' && item.entries?.some((entry) => entry.path === 'src/util/text.js'))), true);
});

test('a plan read attaches a line range before the collector', async () => {
    await writeFile(path.join(root, 'note.txt'), 'alpha\nbeta\ngamma\n');
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Нужен фрагмент.\nroute: plan' };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 's', complexity: 'trivial', steps: [{ goal: 'посмотреть', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [], fileActions: [{ action: 'read', source: null, path: 'note.txt', cwd: '.', language: 'text', reason: 'вторая строка', start: 2, end: 2 }] }) };
        }
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
        return { text: 'ok' };
    };
    const result = await runTeam({ client: client(), config: { ...baseConfig(), memory: { ...defaults.memory, enabled: false } }, ledger: createLedger(), task: 'прочитай строку', root, approvalLevel: 'read', emit() {} });
    assert.equal(result.status, 'completed', result.error?.message);
    const handoffDir = path.join(root, '.tmp');
    const { readdir } = await import('node:fs/promises');
    const docs = await Promise.all((await readdir(handoffDir)).map(async (id) => JSON.parse(await readFile(path.join(handoffDir, id, 'handoff.json'), 'utf8'))));
    assert.equal(docs.some((handoff) => handoff.artifacts.some((item) => item.origin === 'note.txt' && item.start === 2)), true);
});

test('--no-chain starts at the planner', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'planner') return { text: JSON.stringify({ summary: 'мелочь', complexity: 'trivial', steps: [{ goal: 'сделать', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        return { text: 'ok' };
    };
    const config = baseConfig();
    config.agent.chain = false;
    config.agent.resume = false;
    const events = [];
    const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'мелкая правка', root, approvalLevel: 'read', emit: (event) => events.push(event) });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.deepEqual(events.filter((event) => event.type === 'stage.start').map((event) => event.stage), ['plan', 'work']);
});

test('a node frontend workspace is scanned before the encoder', async () => {
    const dir = path.join(root, 'frontend-scan');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"widget","type":"module"}\n');
    await writeFile(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n');
    await writeFile(path.join(dir, 'index.html'), '<script type="module" src="./src/main.js"></script>\n');
    await writeFile(path.join(dir, 'src', 'app.js'), 'export const n = 1;\n');
    await writeFile(path.join(dir, 'src', 'main.js'), "import { n } from './app.js';\n");
    const events = [];
    let encoderText = '';
    let answerText = '';
    script = (body) => {
        const role = roleOf(body);
        const text = JSON.stringify(body.input);
        if (role === 'answer') {
            answerText = text;
            return { text: '```js\nexport const n = 2;\n```\nroute: encode' };
        }
        if (role === 'encoder') {
            encoderText = text;
            return { text: JSON.stringify({ summary: 'файл', commands: [{
                command: 'fs:write', path: 'src/app.js', cwd: '.', type: 'code', language: 'js',
                content: 'export const n = 2;\n', lines: null, source: null, start: null, end: null,
            }] }) };
        }
        return { text: 'planner should not run' };
    };
    const result = await runTeam({
        client: client(), config: baseConfig(), ledger: createLedger(),
        task: 'исправь @/app', root: dir, approvalLevel: 'all', emit: (event) => events.push(event),
    });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.match(answerText, /widget/);
    assert.match(answerText, /@\/\*/);
    assert.match(encoderText, /# Workspace scan/);
    assert.match(encoderText, /src\/app\.js/);
    assert.equal(events.filter((event) => event.type === 'stage.start').map((event) => event.stage)[0], 'scan');
    assert.deepEqual(events.find((event) => event.type === 'stage.done' && event.stage === 'scan').files.includes('src/app.js'), true);
    assert.equal(await readFile(path.join(dir, 'src', 'app.js'), 'utf8'), 'export const n = 2;\n');
});

test('a node frontend scan is in the planner draft before edits', async () => {
    const dir = path.join(root, 'frontend-plan');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"widget","type":"module"}\n');
    await writeFile(path.join(dir, 'jsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n');
    await writeFile(path.join(dir, 'src', 'app.js'), 'export const n = 1;\n');
    let plannerText = '';
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Нужен план.\nroute: plan' };
        if (role === 'planner') {
            plannerText = body.input[0].content[0].text;
            return { text: JSON.stringify({ summary: 'мелочь', complexity: 'trivial', steps: [{ goal: 'посмотреть', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        return { text: 'ok' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'исправь @/app', root: dir, approvalLevel: 'read', emit() {} });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.match(plannerText, /Workspace scan/);
    assert.match(plannerText, /jsconfig\.json/);
    assert.match(plannerText, /edit src\/app\.js/);
});

test('web_search is offered to the answer, the planner, and the worker', async () => {
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push({ role, tools: body.tools ?? [] });
        if (role === 'answer') return { text: 'Нужен план.\nroute: plan' };
        if (role === 'planner') return { text: JSON.stringify({ summary: 'мелочь', complexity: 'trivial', steps: [{ goal: 'посмотреть', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        return { text: 'ok' };
    };
    const config = baseConfig();
    config.tools = { ...config.tools, web: true };
    config.memory = { ...defaults.memory, enabled: false };
    const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'что нового', root, approvalLevel: 'read', emit() {} });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.deepEqual(seen.find((item) => item.role === 'answer').tools, [{ type: 'web_search' }]);
    assert.deepEqual(seen.find((item) => item.role === 'planner').tools, [{ type: 'web_search' }]);
    assert.equal(seen.find((item) => item.role === 'worker').tools.some((tool) => tool.type === 'web_search'), true);
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

test('an unfinished plan resumes from the next step without a new planner call', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-resume-'));
    let phase = 'first';
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'answer') return { text: 'нужен план\nroute: plan' };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 'два шага', complexity: 'trivial', steps: [
                { goal: 'первый', details: 'без файла', verify: 'да' },
                { goal: 'второй', details: 'тоже текст', verify: 'да' },
            ], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        const last = [...body.input].reverse().find((item) => item.role === 'user');
        const text = last?.content?.[0]?.text ?? '';
        const title = text.split('\n').find((line) => line.startsWith('# Your step')) ?? '';
        if (phase === 'first' && /step 2/.test(title)) return { status: 'incomplete', text: 'оборвалось', reason: 'max_output_tokens' };
        if (/step 1/.test(title)) return { text: 'шаг 1 готов' };
        return { text: 'шаг 2 готов' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    const task = 'возобнови два шага';
    try {
        const first = await runTeam({ client: client(), config, ledger: createLedger(), task, root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(first.status, 'incomplete', first.error?.message);
        assert.equal(first.steps.at(-1).status, 'incomplete');
        phase = 'second';
        seen.length = 0;
        const second = await runTeam({ client: client(), config, ledger: createLedger(), task, root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(second.status, 'completed', second.error?.message);
        assert.equal(seen.includes('planner'), false);
        assert.equal(seen.includes('classifier'), false);
        assert.equal(seen.includes('answer'), false);
        assert.equal(second.steps.map((step) => step.goal).join('\n').includes('второй'), true);
        const progress = JSON.parse(await readFile(path.join(dir, '.tmp', second.workId, 'progress.json'), 'utf8'));
        assert.equal(progress.status, 'completed');
        assert.equal(progress.cursor, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('an interrupted turn resumes in the saved session and finishes that step', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-resume-turn-'));
    let phase = 'first';
    const seen = [];
    let resumed = null;
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'answer') return { text: 'нужен план\nroute: plan' };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 'один шаг', complexity: 'trivial', steps: [
                { goal: 'дописать src/app.tsx', details: 'календарь', verify: 'файл есть' },
            ], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        if (phase === 'second') {
            resumed = body.input;
            return { text: 'доделано' };
        }
        return { calls: [{ name: 'list_files', arguments: { path: '.', depth: 1, include_hidden: false } }] };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    config.agent.workerMaxTurnsPerStep = 1;
    const task = 'продолжи незаконченный ход';
    try {
        const first = await runTeam({ client: client(), config, ledger: createLedger(), task, root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(first.status, 'incomplete', first.error?.message);
        assert.equal(first.steps[0].status, 'max_turns');
        const saved = JSON.parse(await readFile(path.join(dir, '.tmp', first.workId, 'progress.json'), 'utf8'));
        assert.equal(saved.steps[0].phase, 'body');
        assert.equal(saved.stage, 'work');
        phase = 'second';
        seen.length = 0;
        const second = await runTeam({ client: client(), config, ledger: createLedger(), task, root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(second.status, 'completed', second.error?.message);
        assert.equal(seen.includes('planner'), false);
        assert.equal(seen.includes('answer'), false);
        assert.equal(second.steps[0].status, 'completed');
        const text = JSON.stringify(resumed);
        assert.match(text, /interrupted turn/);
        assert.match(text, /list_files/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a revision continues the unfinished step and a finished plan accepts a revision without a new plan', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-resume-note-'));
    let mode = 'build';
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'answer') return { text: 'нужен план\nroute: plan' };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 'два', complexity: 'trivial', steps: [
                { goal: 'первый', details: '', verify: 'да' },
                { goal: 'второй', details: '', verify: 'да' },
            ], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        const last = [...body.input].reverse().find((item) => item.type === 'message' && item.role === 'user');
        const text = last?.content?.[0]?.text ?? '';
        if (mode === 'revise') {
            assert.match(text, /Operator revision/);
            assert.match(text, /подпись/);
            return { text: 'подпись добавлена' };
        }
        if (mode === 'interrupt' && /Your step 2/.test(text)) return { status: 'incomplete', text: 'обрыв второго', reason: 'max_output_tokens' };
        return { text: 'готово' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    const task = 'резюме с доработкой';
    try {
        mode = 'interrupt';
        const first = await runTeam({ client: client(), config, ledger: createLedger(), task, root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(first.status, 'incomplete', first.error?.message);
        mode = 'revise';
        seen.length = 0;
        const second = await runTeam({
            client: client(), config, ledger: createLedger(), task, root: dir, approvalLevel: 'read', emit() {},
            revision: 'добавь подпись', resumeId: first.workId,
        });
        assert.equal(second.status, 'completed', second.error?.message);
        assert.equal(seen.includes('planner'), false);
        assert.match(second.steps.map((step) => step.report).join('\n'), /подпись добавлена/);

        mode = 'build';
        seen.length = 0;
        const third = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'отдельная задача', root: dir, approvalLevel: 'read', emit() {},
            revision: 'добавь подпись к готовому', resumeId: second.workId,
        });
        assert.equal(third.status, 'completed', third.error?.message);
        assert.equal(seen.includes('planner'), false);
        assert.equal(third.steps.some((step) => step.goal === 'Доработка'), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a worker plan-update inserts the next step and that step runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-plan-update-'));
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'план\nroute: plan' };
        if (role === 'planner') return { text: JSON.stringify({ summary: 'один', complexity: 'trivial', steps: [
            { goal: 'первый', details: '', verify: '' },
        ], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        const last = [...body.input].reverse().find((item) => item.role === 'user');
        const text = last?.content?.[0]?.text ?? '';
        if (/Your step 1 /.test(text)) {
            return { text: 'готово первый\n```plan-update\n{"note":"добавлен шаг","addSteps":[{"goal":"второй","details":"без файла","verify":"да"}]}\n```' };
        }
        return { text: 'второй готов' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    try {
        const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'дополни план', root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(result.status, 'completed', result.error?.message);
        assert.deepEqual(result.plan.steps.map((step) => step.goal), ['первый', 'второй']);
        assert.deepEqual(result.steps.map((step) => step.goal), ['первый', 'второй']);
        const plan = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'plan.json'), 'utf8'));
        assert.equal(plan.steps[1].goal, 'второй');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('several encoded files get a compatibility pass and a progress file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-encode-compat-'));
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'answer') return { text: '```js\nexport const a = 1;\n```\n\n```js\nexport const b = 2;\n```\nroute: encode' };
        if (role === 'encoder') return { text: JSON.stringify({ summary: 'два', commands: [
            { command: 'fs:write', path: 'a.js', cwd: '.', type: 'code', language: 'js', content: 'export const a = 1;\n', lines: null, source: null, start: null, end: null },
            { command: 'fs:write', path: 'b.js', cwd: '.', type: 'code', language: 'js', content: 'export const b = a;\n', lines: null, source: null, start: null, end: null },
        ] }) };
        if (role === 'worker') {
            assert.match(JSON.stringify(body.input), /Compatibility pass/);
            return { text: 'импорты сходятся' };
        }
        return { text: `не ждали ${role}` };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    try {
        const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'два модуля', root: dir, approvalLevel: 'all', emit() {} });
        assert.equal(result.status, 'completed', result.error?.message);
        assert.equal(result.plan, null);
        assert.equal(seen.includes('planner'), false);
        assert.equal(seen.includes('worker'), true);
        assert.equal(await readFile(path.join(dir, 'a.js'), 'utf8'), 'export const a = 1;\n');
        assert.equal(await readFile(path.join(dir, 'b.js'), 'utf8'), 'export const b = a;\n');
        const progress = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'progress.json'), 'utf8'));
        assert.equal(progress.status, 'completed');
        assert.equal(progress.files.some((file) => file.path === 'a.js'), true);
        assert.equal(progress.files.some((file) => file.path === 'b.js'), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a generation step that hits the turn cap still runs the artwork step', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'planner') {
            return { text: JSON.stringify({
                summary: 'календарь', complexity: 'normal', needsReview: false, imageNotes: null,
                steps: [
                    { goal: 'Implement the calendar interface.', details: 'Primary file: src/app.tsx.', verify: 'сборка' },
                    { goal: 'Recreate the reference styling and generate all required artwork.', details: 'Primary file: src/app.scss. Fix the layout.', verify: 'картинки' },
                ],
                filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], risks: [],
            }) };
        }
        return { calls: [{ name: 'list_files', arguments: { path: '.', depth: 1, include_hidden: false } }] };
    };
    const config = baseConfig();
    config.agent.chain = false;
    config.agent.resume = false;
    config.agent.workerMaxTurnsPerStep = 2;
    config.memory = { ...defaults.memory, enabled: false };
    const events = [];
    const result = await runTeam({
        client: client(), config, ledger: createLedger(), task: 'сгенерировать календарь', root,
        approvalLevel: 'read', generation: true, memory: null, emit: (event) => events.push(event),
    });
    assert.equal(result.status, 'incomplete', result.error?.message);
    assert.deepEqual(result.steps.map((step) => step.status), ['max_turns', 'max_turns']);
    assert.match(result.steps[1].goal, /artwork/);
    assert.equal(events.some((event) => event.type === 'warning' && /следующий шаг/.test(event.message)), true);
});

test('trivial pace skips the reviewer', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Коротко.\nroute: plan' };
        if (role === 'classifier') return { text: JSON.stringify({ label: 'trivial' }) };
        if (role === 'planner') return { text: JSON.stringify({ summary: 'мелочь', complexity: 'trivial', steps: [{ goal: 'сделать', details: '', verify: '', complexity: 'trivial' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: true, imageNotes: null, risks: [], fileActions: [], taskMap: [] }) };
        if (role === 'reviewer') throw new Error('reviewer ran');
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'ok', memories: [] }) };
        return { text: 'готово' };
    };
    const result = await runTeam({ client: client(), config: { ...baseConfig(), pace: { ...defaults.pace, speed: 10, quality: 40 } }, ledger: createLedger(), task: 'Поправь опечатку', root, approvalLevel: 'all', emit: () => {} });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(result.review, null);
});

test('pace c does not call the planner', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Коротко.\nroute: plan' };
        if (role === 'classifier') return { text: JSON.stringify({ label: 'trivial' }) };
        if (role === 'planner') throw new Error('planner ran');
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'ok', memories: [] }) };
        return { text: 'готово' };
    };
    const result = await runTeam({ client: client(), config: { ...baseConfig(), pace: { ...defaults.pace, mode: 'c' }, agent: { ...baseConfig().agent, chain: false } }, ledger: createLedger(), task: 'Поправь опечатку', root, approvalLevel: 'all', emit: () => {} });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(result.plan.steps.length, 1);
});

test('a bad classifier label becomes normal and the run continues', async () => {
    const events = [];
    script = (body) => {
        const role = roleOf(body);
        if (role === 'classifier') return { text: 'не json' };
        if (role === 'planner') return { text: JSON.stringify({ summary: 's', complexity: 'normal', steps: [{ goal: 'сделать', details: '', verify: '', complexity: 'normal' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [], fileActions: [], taskMap: [] }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'ok', memories: [] }) };
        return { text: 'готово' };
    };
    const result = await runTeam({ client: client(), config: { ...baseConfig(), agent: { ...baseConfig().agent, chain: false } }, ledger: createLedger(), task: 'Сделай шаг', root, approvalLevel: 'all', emit: (event) => events.push(event) });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.ok(events.some((event) => event.type === 'warning' && event.message === 'Метка задачи не распознана, взята normal.'));
});

test('a strained budget tells the planner that balance is not promised', async () => {
    let planner = '';
    script = (body) => {
        const role = roleOf(body);
        if (role === 'classifier') return { text: JSON.stringify({ label: 'normal' }) };
        if (role === 'planner') {
            planner = body.instructions;
            return { text: JSON.stringify({ summary: 's', complexity: 'normal', steps: [{ goal: 'сделать', details: '', verify: '', complexity: 'normal' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: ['видно'], needsReview: false, imageNotes: null, risks: [], fileActions: [], taskMap: [] }) };
        }
        if (role === 'reviewer') return { text: JSON.stringify({ verdict: 'accept', summary: 'ok', issues: [], unverified: [] }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'ok', memories: [] }) };
        return { text: 'готово' };
    };
    const result = await runTeam({
        client: client(),
        config: { ...baseConfig(), pace: { ...defaults.pace, speed: 60, quality: 60 }, agent: { ...baseConfig().agent, chain: false }, memory: { ...defaults.memory, enabled: false } },
        ledger: createLedger(), task: 'Сделай шаг', root, approvalLevel: 'all', emit: () => {},
    });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.match(planner, /Balance is not promised/);
});
