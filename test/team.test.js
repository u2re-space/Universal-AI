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
import { CLASSIFIER_SCHEMA } from '../src/agent/schemas.js';
import { runTeam, toolNamesForRole } from '../src/agent/team.js';
import { enabledToolNames } from '../src/agent/tool-specs.js';
import { diffHunk, describeChangeSet } from '../src/agent/diff.js';
import { overridesFrom } from '../src/commands/shared.js';
import { startMockServer, TINY_PNG } from './helpers/mock-server.js';
import { encodeArtifacts } from '../src/encode/encode.ts';

let server;
let script = () => ({ text: 'ok' });
let extractScript = null;
let extractModel = null;
let decision = null;
let detectCoder = false;
let root;
before(async () => {
    server = await startMockServer({
        script: (body, index) => {
            if (roleOf(body) === 'extractor') {
                extractModel = body.model;
                if (extractScript) return extractScript(body, index);
                const text = JSON.stringify(body.input);
                const source = /\[artifact (a\d+)\]/.exec(text)?.[1] ?? 'a001';
                return { text: JSON.stringify({ summary: 'clean', files: [{ source, path: '', language: 'js', content: '', removeLines: [] }] }) };
            }
            return script(body, index);
        },
        decisions: () => decision,
    });
    root = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-team-'));
});
beforeEach(() => { server.reset(); decision = null; extractScript = null; extractModel = null; detectCoder = false; });
after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

const baseConfig = () => structuredClone({
    ...defaults, model: 'gpt-6.1-sol', home: root, baseURL: server.baseURL,
    pace: { ...defaults.pace, quality: 20 },
    agent: { ...defaults.agent, architect: 'off' },
    roles: { ...defaults.roles, worker: { ...defaults.roles.worker, model: 'gpt-6-luna' }, orchestrator: { ...defaults.roles.orchestrator, model: 'gpt-6-luna' },
        vision: { ...defaults.roles.vision, model: 'gpt-6-luna-vision' }, summarizer: { ...defaults.roles.summarizer, model: 'gpt-6-luna-nano' } },
    memory: { ...defaults.memory, dbFile: ':memory:' },
});
const client = () => createClient({ apiKey: 'sk-test', baseURL: server.baseURL });

/** Decide the scenario from the request: role is recognisable by the strict schema name / tools. */
function roleOf(body) {
    const format = body.text?.format?.name;
    if (format === 'plan') return 'planner';
    if (format === 'architecture') return 'architect';
    if (format === 'file_commands') return 'encoder';
    if (format === 'context_report') return 'collector';
    if (format === 'review') return 'reviewer';
    if (format === 'coordination') return 'coordinator';
    if (format === 'memory_update') return 'summarizer';
    if (format === 'task_label') return 'classifier';
    if (format === 'extraction') return 'extractor';
    if (format === 'measure') return 'measurer';
    if (format === 'image_assets') return 'image-processor';
    if (detectCoder && typeof body.instructions === 'string' && body.instructions.includes('You are the coder.')) return 'coder';
    if (typeof body.instructions === 'string' && body.instructions.includes('route: encode')) return 'answer';
    if (body.input.some((i) => i.type === 'message' && i.content?.some?.((c) => c.type === 'input_image'))) return 'vision';
    if (body.model === 'gpt-6-luna-nano') return 'summarizer-file';
    return 'worker';
}

test('image processor only sees enabled image, asset, and documentation-fetch tools', () => {
    const enabled = ['list_files', 'write_file', 'run_command', 'fetch_url', 'view_image', 'crop_image', 'split_image', 'generate_image', 'edit_image', 'vectorize_image', 'generate_svg', 'download_font', 'download_icons', 'image_generation'];
    assert.deepEqual(toolNamesForRole(enabled, 'image-processor'), ['fetch_url', 'view_image', 'crop_image', 'split_image', 'generate_image', 'edit_image', 'vectorize_image', 'generate_svg', 'download_font', 'download_icons']);
    const api = enabledToolNames({ ...defaults.tools, images: true, fetch: true }, { imageApi: true });
    assert.deepEqual(toolNamesForRole(api, 'image-processor'), ['view_image', 'fetch_url', 'generate_image', 'edit_image', 'vectorize_image', 'split_image', 'crop_image', 'generate_svg', 'download_font', 'download_icons']);
    const noFetch = enabledToolNames({ ...defaults.tools, images: true, fetch: false }, { imageApi: false });
    assert.deepEqual(toolNamesForRole(noFetch, 'image-processor'), ['view_image', 'split_image', 'crop_image', 'generate_svg']);
    const noImages = enabledToolNames({ ...defaults.tools, images: false, fetch: false }, { imageApi: false });
    assert.deepEqual(toolNamesForRole(noImages, 'image-processor'), ['view_image']);
});

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
    assert.deepEqual(overridesFrom({ role: ['image-processor=gpt-6-luna:medium'] }).roles, { 'image-processor': { model: 'gpt-6-luna', effort: 'medium' } });
    assert.equal(Object.keys(overridesFrom({ role: ['all=cheap'] }).roles).length, 19);
    assert.equal(overridesFrom({ extract: 'always' }).agent.extract, 'always');
    assert.equal(overridesFrom({ 'no-extract': true }).agent.extract, 'off');
    assert.throws(() => overridesFrom({ extract: 'nope' }), /--extract/);
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

test('decisions accept replaces the reviewer pass', async () => {
    decision = {
        meets_task: { type: 'noul', noul: 0.95 },
        complete: { type: 'noul', noul: 0.9 },
        verified: { type: 'noul', noul: 0.8 },
        verdict: { type: 'choice', choice: 'accept', confidence: 0.9 },
    };
    let reviews = 0;
    script = (body) => {
        const role = roleOf(body);
        if (role === 'planner') {
            return { text: JSON.stringify({
                summary: 's', complexity: 'normal',
                steps: [{ goal: 'сделать', details: '', verify: '', complexity: 'normal' }],
                filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: ['ok'],
                needsReview: true, imageNotes: null, risks: [],
            }) };
        }
        if (role === 'reviewer') { reviews++; return { text: JSON.stringify({ verdict: 'accept', summary: 'ok', issues: [], unverified: [] }) }; }
        return { text: 'done' };
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decisions-'));
    try {
        const config = baseConfig();
        config.pace.quality = 80;
        const result = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'сделай', root: dir, approvalLevel: 'read', emit() {},
        });
        assert.equal(result.review.verdict, 'accept');
        assert.equal(result.reviewRounds, 0);
        assert.equal(reviews, 0);
        assert.ok(server.requests.some((request) => request.path === '/v1/decisions'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
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

test('role runner adds web conventions and configured documentation to coding roles', async () => {
    script = (body) => {
        assert.match(body.instructions, /ECMAScript 2025/);
        assert.match(body.instructions, /@container/);
        assert.match(body.instructions, /calc-size\(\)/);
        assert.match(body.instructions, /stylelint/);
        assert.match(body.instructions, /teamCss: https:\/\/example\.com\/css/);
        assert.match(body.instructions, /mdnCss: https:\/\/example\.com\/mdn/);
        assert.doesNotMatch(body.instructions, /developer\.mozilla\.org\/en-US\/docs\/Web\/CSS/);
        return { text: 'done' };
    };
    const config = baseConfig();
    config.documentation.sources.mdnCss = 'https://example.com/mdn';
    config.documentation.sources.teamCss = 'https://example.com/css';
    config.documentation.roles.coder.push('teamCss');
    const roles = createRoleRunner({ client: client(), config, ledger: createLedger() });
    const result = await roles.run('coder', { text: 'update styles' });
    assert.equal(result.status, 'completed', result.error?.message);
});

test('role runner parses a fenced JSON reply without a retry', async () => {
    let calls = 0;
    script = () => { calls++; return { text: '```json\n{"label":"complex"}\n```' }; };
    const roles = createRoleRunner({ client: client(), config: baseConfig(), ledger: createLedger() });
    const result = await roles.run('classifier', { text: 'label it', schema: CLASSIFIER_SCHEMA, schemaName: 'task_label' });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.deepEqual(result.data, { label: 'complex' });
    assert.equal(calls, 1);
});

test('role runner parses JSON wrapped in prose from a fallback model', async () => {
    script = () => ({ text: 'The answer is {"label":"normal"} for this task.' });
    const roles = createRoleRunner({ client: client(), config: baseConfig(), ledger: createLedger() });
    const result = await roles.run('classifier', { text: 'label it', schema: CLASSIFIER_SCHEMA, schemaName: 'task_label' });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.deepEqual(result.data, { label: 'normal' });
});

test('role runner asks once for valid JSON when the reply is prose', async () => {
    const events = [];
    script = (body, index) => (index === 0 ? { text: 'I cannot structure this task.' } : { text: '{"label":"normal"}' });
    const roles = createRoleRunner({ client: client(), config: baseConfig(), ledger: createLedger(), emit: (event) => events.push(event) });
    const result = await roles.run('classifier', { text: 'label it', schema: CLASSIFIER_SCHEMA, schemaName: 'task_label' });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.deepEqual(result.data, { label: 'normal' });
    assert.equal(result.turns, 2);
    assert.match(events.filter((e) => e.type === 'warning').map((e) => e.message).join(' '), /не в JSON/);
    const retry = server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/responses').at(-1);
    assert.match(JSON.stringify(retry.body.input.at(-1)), /not valid JSON/);
});

test('role runner fails when the restated reply is not JSON either', async () => {
    script = () => ({ text: 'still prose' });
    const roles = createRoleRunner({ client: client(), config: baseConfig(), ledger: createLedger() });
    const result = await roles.run('classifier', { text: 'label it', schema: CLASSIFIER_SCHEMA, schemaName: 'task_label' });
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /некорректный JSON/);
    assert.equal(result.turns, 2);
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

test('the extractor writes clean tmp files and the encoder copies them into the workspace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-extract-team-'));
    extractScript = (body) => {
        assert.match(JSON.stringify(body.input), /\[artifact a001\]/);
        return { text: JSON.stringify({ summary: 'clean module', files: [{
            source: 'a001', path: 'src/app.js', language: 'js',
            content: "export const app = 'clean';\n", removeLines: [],
        }] }) };
    };
    let encoderText = '';
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: "Here is the module.\n\n```js\nexport const app = 'dirty';\n```\nroute: encode" };
        if (role === 'encoder') {
            encoderText = JSON.stringify(body.input);
            const source = /(\.tmp\/[0-9a-f]{8}\/extracted\/src\/app\.js)/.exec(encoderText)?.[1];
            assert.ok(source, 'the encoder sees the extracted source');
            return { text: JSON.stringify({ summary: 'clean file', commands: [{
                command: 'fs:write', path: 'src/app.js', cwd: '.', type: 'code', language: 'js',
                content: null, lines: null, source, start: null, end: null,
            }] }) };
        }
        return { text: 'unexpected' };
    };
    try {
        const events = [];
        const result = await runTeam({
            client: client(), config: { ...baseConfig(), memory: { ...defaults.memory, enabled: false } },
            ledger: createLedger(), task: 'запиши модуль', root: dir, approvalLevel: 'all', emit: (event) => events.push(event),
        });
        assert.equal(result.status, 'completed', result.error?.message);
        assert.equal(await readFile(path.join(dir, 'src', 'app.js'), 'utf8'), "export const app = 'clean';\n");
        assert.match(encoderText, /# Extracted files/);
        assert.match(encoderText, /extracted/);
        assert.equal(extractModel, 'gpt-6-luna');
        assert.ok(events.some((event) => event.type === 'stage.start' && event.stage === 'extract' && event.role === 'extractor'));
        const { readdir } = await import('node:fs/promises');
        const id = (await readdir(path.join(dir, '.tmp'))).find((name) => /^[0-9a-f]{8}$/.test(name));
        assert.ok(id);
        assert.equal(await readFile(path.join(dir, '.tmp', id, 'extracted', 'src', 'app.js'), 'utf8'), "export const app = 'clean';\n");
        assert.match(await readFile(path.join(dir, '.tmp', id, 'answer.md'), 'utf8'), /dirty/);
        const handoff = JSON.parse(await readFile(path.join(dir, '.tmp', id, 'handoff.json'), 'utf8'));
        assert.equal(handoff.raw, `.tmp/${id}/answer.md`);
        assert.equal(handoff.artifacts.some((item) => item.extracted && item.hintPath === 'src/app.js'), true);
        assert.equal(handoff.artifacts.find((item) => item.id === 'a001').supersededBy, 'a002');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
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

test('delegated measurer gets web search only when tools.web is enabled', async () => {
    for (const web of [true, false]) {
        const seen = [];
        script = (body) => {
            const role = roleOf(body);
            seen.push({ role, body });
            if (role === 'planner') return { text: JSON.stringify({
                summary: 'замер типографики', complexity: 'normal',
                steps: [{ goal: 'Собрать стили', details: '', verify: 'прочитать стили' }],
                filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
                needsReview: false, imageNotes: null, risks: [], imageTasks: [],
            }) };
            if (role === 'measurer') {
                assert.equal(body.tools.some((tool) => tool.type === 'web_search'), web);
                assert.ok(body.tools.some((tool) => tool.name === 'fetch_url'));
                assert.ok(body.tools.some((tool) => tool.name === 'crop_image'), 'the measurer can crop even when image generation is off');
                return { text: JSON.stringify({
                    summary: 'замеров нет', source: 'text-only task', unit: 'px',
                    canvas: { x: 0, y: 0, width: 1, height: 1 }, elements: [], regions: [], rules: [], notes: '',
                }) };
            }
            if (role === 'worker') {
                const outputs = body.input.filter((item) => item.type === 'function_call_output');
                if (!outputs.length) return { calls: [{ name: 'delegate_role', arguments: { role: 'measurer', task: 'measure the typography' } }] };
                assert.match(outputs[0].output, /замеров нет/);
                return { text: 'Стили собраны' };
            }
            return { text: 'ok' };
        };
        const config = baseConfig();
        config.tools = { ...config.tools, desktop: true, web };
        config.memory = { ...defaults.memory, enabled: false };
        const result = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'замерь типографику', root,
            approvalLevel: 'read', emit() {},
        });
        assert.equal(result.status, 'completed', result.error?.message);
        assert.ok(seen.some((item) => item.role === 'measurer'));
    }
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

test('each step takes the model for its own complexity, not the plan complexity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-step-models-'));
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        if (role === 'classifier') return { text: JSON.stringify({ label: 'complex' }) };
        if (role === 'planner') {
            return { text: JSON.stringify({
                summary: 'смешанный план', complexity: 'complex',
                steps: [
                    { goal: 'Создать src/app.tsx', details: 'export const App = () => null;', verify: 'прочитать', complexity: 'complex' },
                    { goal: 'Создать README.md', details: 'короткая заметка', verify: 'прочитать', complexity: 'trivial' },
                ],
                filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
                needsReview: false, imageNotes: null, risks: [],
            }) };
        }
        if (role === 'worker') {
            const text = body.input[0]?.content?.[0]?.text ?? '';
            const match = /# Your step (\d+) of (\d+)/.exec(text);
            seen.push({ step: match ? Number(match[1]) : 0, model: body.model });
            return { text: 'готово' };
        }
        return { text: 'ok' };
    };
    const config = {
        ...baseConfig(),
        roles: structuredClone(defaults.roles),
        pace: { ...defaults.pace, speed: 10, quality: 80, mode: 'b' },
        agent: { ...baseConfig().agent, chain: false, resume: false },
        memory: { ...defaults.memory, enabled: false },
    };
    try {
        const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'смешанный план', root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(result.status, 'completed', result.error?.message);
        const first = seen.filter((item) => item.step === 1);
        const second = seen.filter((item) => item.step === 2);
        assert.ok(first.length >= 1, JSON.stringify(seen));
        assert.ok(first.every((item) => item.model === 'gpt-6.1-sol'), JSON.stringify(seen));
        assert.ok(second.length >= 1, JSON.stringify(seen));
        assert.ok(second.every((item) => item.model === 'gpt-6-luna'), JSON.stringify(seen));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a generation step that runs out of turns gets one cheap verification pass', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-verify-pass-'));
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        if (role === 'classifier') return { text: JSON.stringify({ label: 'complex' }) };
        if (role === 'planner') {
            return { text: JSON.stringify({
                summary: 'сложная страница', complexity: 'complex',
                steps: [{ goal: 'Создать src/app.tsx', details: 'export const App = () => null;', verify: 'npm run build', complexity: 'complex' }],
                filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
                needsReview: false, imageNotes: null, risks: [],
            }) };
        }
        if (role === 'worker') {
            const text = body.input[0]?.content?.[0]?.text ?? '';
            const verify = /— verify/.test(text);
            seen.push({ verify, model: body.model });
            if (verify) return { text: 'сборка проходит' };
            const outputs = body.input.filter((item) => item.type === 'function_call_output');
            if (!outputs.length) return { calls: [{ name: 'write_file', arguments: { path: 'src/app.tsx', content: 'export const App = () => null;\n', overwrite: true } }] };
            return { calls: [{ name: 'list_files', arguments: { path: '.', depth: 1, include_hidden: false } }] };
        }
        return { text: 'ok' };
    };
    const config = {
        ...baseConfig(),
        roles: structuredClone(defaults.roles),
        pace: { ...defaults.pace, speed: 10, quality: 80, mode: 'b' },
        agent: { ...baseConfig().agent, chain: false, resume: false, workerMaxTurnsPerStep: 2 },
        memory: { ...defaults.memory, enabled: false },
    };
    try {
        const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'сгенерировать страницу', root: dir, approvalLevel: 'all', generation: true, emit() {} });
        assert.equal(result.status, 'completed', result.error?.message);
        assert.equal(result.steps[0].status, 'completed');
        const first = seen.filter((item) => !item.verify);
        const verify = seen.filter((item) => item.verify);
        assert.ok(first.length >= 1, JSON.stringify(seen));
        assert.ok(first.every((item) => item.model === 'gpt-6.1-sol'), JSON.stringify(seen));
        assert.equal(verify.length, 1, JSON.stringify(seen));
        assert.equal(verify[0].model, 'gpt-6-luna');
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

test('encode host writes the hinted file and does not call the encoder model', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'encoder') throw new Error('encoder model');
        if (role === 'answer') return { text: 'encode-host.js\n\n```js\nexport const a = 1;\n```\nroute: encode' };
        throw new Error(`unexpected ${role}`);
    };
    const events = [];
    const result = await runTeam({
        client: client(), config: { ...baseConfig(), memory: { ...defaults.memory, enabled: false } },
        ledger: createLedger(), task: 'запиши модуль', root, approvalLevel: 'all', emit: (event) => events.push(event),
        encodeHost: {
            encode: (input) => encodeArtifacts({
                ...input,
                writeFile: async (file, content) => writeFile(path.join(root, file), content),
            }),
        },
    });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(await readFile(path.join(root, 'encode-host.js'), 'utf8'), 'export const a = 1;');
    assert.ok(events.some((event) => event.type === 'stage.start' && event.stage === 'encode' && event.role === 'encoder'));
    assert.match(result.text, /encode-host\.js/);
});

test('encode host failure does not call the encoder model', async () => {
    script = (body) => {
        const role = roleOf(body);
        if (role === 'encoder') throw new Error('encoder model');
        if (role === 'answer') return { text: 'encode-host.js\n\n```js\nexport const a = 1;\n```\nroute: encode' };
        throw new Error(`unexpected ${role}`);
    };
    const result = await runTeam({
        client: client(), config: { ...baseConfig(), memory: { ...defaults.memory, enabled: false } },
        ledger: createLedger(), task: 'запиши модуль', root, approvalLevel: 'all',
        encodeHost: { encode: async () => { throw new Error('encode failed'); } },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /encode failed/);
});

test('orchestrator revises the plan after a step and guides the next worker turn', async () => {
    let coordinatorCalls = 0;
    const workerTexts = [];
    script = (body) => {
        const role = roleOf(body);
        if (role === 'planner') return { text: JSON.stringify({ summary: 'два модуля', complexity: 'normal', steps: [
            { goal: 'Создать a.js', details: 'export const a = 1', verify: 'прочитать a.js', complexity: 'normal' },
        ], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: ['a.js и b.js согласованы'], needsReview: false, imageNotes: null, risks: [] }) };
        if (role === 'coordinator') {
            coordinatorCalls++;
            if (coordinatorCalls === 1) {
                assert.match(body.input[0].content[0].text, /Plan/);
                return { text: JSON.stringify({ summary: 'План верный', nextStep: 'Сначала a.js', planUpdate: { note: '', addSteps: [], revise: [] }, risks: [] }) };
            }
            if (coordinatorCalls === 2) {
                assert.match(body.input[0].content[0].text, /Recent changes/);
                return { text: JSON.stringify({ summary: 'a.js готов, нужен b.js', nextStep: 'create b.js that imports a.js', planUpdate: { note: 'нужен второй модуль', addSteps: [
                    { goal: 'Создать b.js', details: 'export const b = a', verify: 'прочитать b.js' },
                ], revise: [] }, risks: ['b.js отсутствует'] }) };
            }
            return { text: JSON.stringify({ summary: 'Готово', nextStep: '', planUpdate: { note: '', addSteps: [], revise: [] }, risks: [] }) };
        }
        if (role === 'worker') {
            const lastUser = [...body.input].reverse().find((item) => item.type === 'message' && item.role === 'user').content[0].text;
            workerTexts.push(lastUser);
            return { text: /Your step 1/.test(lastUser) ? 'a.js готов' : 'b.js готов' };
        }
        return { text: 'unexpected' };
    };
    const config = baseConfig();
    config.agent = {
        ...defaults.agent, chain: false, resume: false, architect: 'off',
        orchestrator: { ...defaults.agent.orchestrator, enabled: true, after: ['plan', 'work'], maxContextBytes: 2 * 1024 * 1024 },
    };
    config.memory = { ...defaults.memory, enabled: false };
    const events = [];
    const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'два модуля', root, approvalLevel: 'read', emit: (event) => events.push(event) });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(coordinatorCalls, 3);
    assert.deepEqual(result.plan.steps.map((step) => step.goal), ['Создать a.js', 'Создать b.js']);
    assert.deepEqual(result.steps.map((step) => step.goal), ['Создать a.js', 'Создать b.js']);
    const secondStepTurn = workerTexts.find((text) => /Your step 2/.test(text));
    assert.ok(secondStepTurn, 'the worker received the added step');
    assert.match(secondStepTurn, /Orchestrator guidance/);
    assert.match(secondStepTurn, /create b\.js that imports a\.js/);
    assert.equal(events.filter((event) => event.type === 'stage.start' && event.stage === 'orchestrate').length, 3);
    assert.ok(events.some((event) => event.type === 'plan.updated' && event.steps === 2));
    assert.ok(events.some((event) => event.type === 'orchestrator.done' && event.risks.includes('b.js отсутствует')));
    const progress = JSON.parse(await readFile(path.join(root, '.tmp', result.workId, 'progress.json'), 'utf8'));
    assert.equal(progress.notes.filter((note) => note.kind === 'orchestrator').length, 3);
});

test('image processing runs before implementation and passes prepared assets in shared context', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-processor-'));
    const events = [];
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push({ role, body });
        if (role === 'answer') return { text: 'Подготовь иллюстрацию и страницу.\nroute: plan' };
        if (role === 'planner') return { text: JSON.stringify({
            summary: 'страница с иллюстрацией', complexity: 'normal',
            steps: [{ goal: 'Создать страницу', details: 'Подключить assets/cover.png', verify: 'прочитать src/index.html' }],
            filesOfInterest: ['src/index.html'], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
            needsReview: false, imageNotes: null, imageTasks: [{ goal: 'Нарисовать обложку', details: 'Пастельная геометрическая иллюстрация, PNG, assets/cover.png' }], risks: [],
        }) };
        if (role === 'image-processor') {
            assert.equal((body.tools ?? []).some((tool) => tool.type === 'web_search'), config.tools.web);
            return { text: JSON.stringify({
                summary: 'Обложка создана.',
                assets: [{ path: 'assets/cover.png', format: 'png', use: 'Hero background image.' }],
                typography: [
                    { family: 'DM Sans', role: 'body', cssFamily: '\"DM Sans\", sans-serif', cssUrl: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap', weights: ['400', '700'], rationale: 'Readable neutral body face.', source: 'https://fonts.google.com/specimen/DM+Sans', localPath: null },
                    { family: 'Manrope', role: 'heading', cssFamily: '\"Manrope\", sans-serif', cssUrl: 'https://fonts.googleapis.com/css2?family=Manrope:wght@600;700&display=swap', weights: ['600', '700'], rationale: 'Pairs with the restrained body family while giving headings distinction.', source: 'https://fonts.google.com/specimen/Manrope', localPath: null },
                ],
                notes: [],
            }) };
        }
        if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [], conventions: [], notes: '' }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'готово', memories: [] }) };
        return { text: 'worker done' };
    };
    const config = baseConfig();
    config.agent = { ...config.agent, chain: false, resume: false };
    config.tools.images = true;
    config.image.transport = 'images';
    config.memory = { ...defaults.memory, enabled: false };
    const result = await runTeam({
        client: client(), config, ledger: createLedger(), task: 'страница и изображение', root: dir,
        approvalLevel: 'read', emit: (event) => events.push(event),
    });
    try {
        assert.equal(result.status, 'completed', result.error?.message);
        const roles = seen.map((item) => item.role);
        assert.ok(roles.indexOf('collector') < roles.indexOf('image-processor'));
        assert.ok(roles.indexOf('image-processor') < roles.lastIndexOf('worker'));
        const processor = seen.find((item) => item.role === 'image-processor').body;
        const toolNames = processor.tools.map((tool) => tool.name);
        assert.ok(processor.tools.some((tool) => tool.name === 'fetch_url'));
        assert.ok(processor.tools.some((tool) => tool.name === 'download_font'));
        assert.ok(processor.tools.some((tool) => tool.type === 'web_search'));
        assert.deepEqual(toolNames.filter(Boolean), ['view_image', 'fetch_url', 'generate_image', 'edit_image', 'vectorize_image', 'split_image', 'crop_image', 'generate_svg', 'download_font', 'download_icons']);
        assert.equal(toolNames.some((name) => ['write_file', 'replace_text', 'run_command'].includes(name)), false);
        const worker = seen.find((item) => item.role === 'worker').body;
        assert.match(worker.input[0].content[0].text, /Prepared images and visual assets/);
        assert.match(worker.input[0].content[0].text, /assets\/cover\.png/);
        assert.match(worker.input[0].content[0].text, /Typography recommendations/);
        assert.match(worker.input[0].content[0].text, /DM Sans/);
        assert.match(worker.input[0].content[0].text, /Manrope/);
        assert.match(worker.input[0].content[0].text, /400, 700/);
        assert.match(worker.input[0].content[0].text, /https:\/\/fonts\.googleapis\.com\/css2\?family=DM\+Sans:wght@400;700&display=swap/);
        assert.match(worker.input[0].content[0].text, /https:\/\/fonts\.googleapis\.com\/css2\?family=Manrope:wght@600;700&display=swap/);
        assert.match(worker.input[0].content[0].text, /load this verified stylesheet/);
        assert.ok(events.some((event) => event.type === 'stage.start' && event.stage === 'image-processing' && event.role === 'image-processor'));
        assert.ok(events.some((event) => event.type === 'stage.done' && event.stage === 'image-processing' && event.status === 'completed'));
        assert.equal(result.stats['image-processor'].calls, 0);
        const saved = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'progress.json'), 'utf8'));
        assert.equal(saved.imageProcessing.status, 'completed');
        assert.match(saved.imageProcessing.report, /assets\/cover\.png/);
        assert.match(saved.imageProcessing.report, /DM Sans/);
        assert.match(saved.imageProcessing.report, /Manrope/);
        assert.match(await readFile(path.join(dir, '.tmp', result.workId, 'image-assets.json'), 'utf8'), /Typography recommendations/);
        assert.match(await readFile(path.join(dir, '.tmp', result.workId, 'image-assets.json'), 'utf8'), /assets\/cover\.png/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('image processor and measurer omit web search when tools.web is disabled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-font-web-off-'));
    const seen = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push({ role, body });
        if (role === 'answer') return { text: 'Страница с типографикой и обложкой.\nroute: plan' };
        if (role === 'planner') return { text: JSON.stringify({
            summary: 'Страница по референсу с обложкой', complexity: 'normal',
            steps: [{ goal: 'Создать страницу', details: 'Использовать замеры и выбранную типографику', verify: 'прочитать страницу' }],
            filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false,
            imageNotes: null, imageTasks: [{ goal: 'Подобрать шрифт для страницы и подготовить обложку', details: 'Заголовок и основной текст, локальные файлы не нужны; создать PNG assets/cover.png' }], risks: [],
        }) };
        if (role === 'measurer') return { text: JSON.stringify({
            summary: 'Текст и карточка', source: 'mockup.png', unit: 'px', canvas: { x: 0, y: 0, width: 400, height: 300 },
            elements: [{
                name: 'Headline', box: { x: 24, y: 20, width: 300, height: 42 }, rotation: 0, borders: '', radius: null,
                padding: { top: null, right: null, bottom: null, left: null }, margin: { top: null, right: null, bottom: null, left: null }, gap: null,
                spacing: '', placement: 'top aligned', typography: { role: 'heading', family: '', familyConfidence: 'unknown', fontSize: 28, weight: 600, lineHeight: 34, letterSpacing: 0, style: '' }, crop: null,
            }], regions: [], rules: [], notes: '',
        }) };
        if (role === 'image-processor') return { text: JSON.stringify({ summary: 'Обложка готова.', assets: [], typography: [], notes: [] }) };
        if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [], conventions: [], notes: '' }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'готово', memories: [] }) };
        return { text: 'worker done' };
    };
    const config = baseConfig();
    config.tools = { ...config.tools, web: false };
    config.image.transport = 'images';
    config.memory = { ...defaults.memory, enabled: false };
    try {
        const result = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'Страница по макету', root: dir,
            approvalLevel: 'read', parts: [{ type: 'input_image', image: { path: 'mockup.png' } }], emit() {},
        });
        assert.equal(result.status, 'completed', result.error?.message);
        for (const role of ['measurer', 'image-processor']) {
            const request = seen.find((item) => item.role === role).body;
            assert.equal(request.tools.some((tool) => tool.type === 'web_search'), false, `${role} must respect tools.web=false`);
        }
        const measurer = seen.find((item) => item.role === 'measurer').body;
        assert.equal(measurer.tools.some((tool) => tool.name === 'fetch_url'), true);
        const processor = seen.find((item) => item.role === 'image-processor').body;
        assert.equal(processor.tools.some((tool) => tool.name === 'fetch_url'), true);
        assert.match(JSON.stringify(seen.find((item) => item.role === 'worker').body.input), /Typography workflow/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('image processing stage is skipped when the plan has no image tasks', async () => {
    const seen = [];
    const events = [];
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'planner') return { text: JSON.stringify({
            summary: 'текстовая правка', complexity: 'trivial',
            steps: [{ goal: 'Обновить note.txt', details: '', verify: 'прочитать файл' }],
            filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
            needsReview: false, imageNotes: null, imageTasks: [], risks: [],
        }) };
        return { text: 'готово' };
    };
    const config = baseConfig();
    config.agent = { ...config.agent, chain: false, resume: false };
    config.memory = { ...defaults.memory, enabled: false };
    const result = await runTeam({ client: client(), config, ledger: createLedger(), task: 'обновить заметку', root, emit: (event) => events.push(event) });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(seen.includes('image-processor'), false);
    assert.equal(events.some((event) => event.stage === 'image-processing'), false);
});

test('a completed image stage is not repeated when the run resumes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-resume-'));
    const seen = [];
    const workerBodies = [];
    let interruptWorker = true;
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'answer') return { text: 'Страница с обложкой.\nroute: plan' };
        if (role === 'planner') return { text: JSON.stringify({
            summary: 'страница с обложкой', complexity: 'normal',
            steps: [{ goal: 'Создать страницу', details: 'Подключить assets/cover.png', verify: 'прочитать src/index.html' }],
            filesOfInterest: ['src/index.html'], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
            needsReview: false, imageNotes: null, imageTasks: [{ goal: 'Нарисовать обложку', details: 'PNG, assets/cover.png' }], risks: [],
        }) };
        if (role === 'image-processor') return { text: JSON.stringify({
            summary: 'Обложка создана.', assets: [{ path: 'assets/cover.png', format: 'png', use: 'Hero background image.' }], typography: [], notes: [],
        }) };
        if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [], conventions: [], notes: '' }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'готово', memories: [] }) };
        workerBodies.push(body);
        const workerText = [...body.input].reverse().find((item) => item.type === 'message' && item.role === 'user')?.content?.[0]?.text ?? '';
        if (interruptWorker && /Your step 1/.test(workerText)) {
            interruptWorker = false;
            return { status: 'incomplete', text: 'обрыв шага', reason: 'max_output_tokens' };
        }
        return { text: 'страница готова' };
    };
    const config = baseConfig();
    config.agent = { ...config.agent, chain: false, resume: false };
    config.memory = { ...defaults.memory, enabled: false };
    try {
        const first = await runTeam({ client: client(), config, ledger: createLedger(), task: 'страница и обложка', root: dir, approvalLevel: 'read', emit() {} });
        assert.equal(first.status, 'incomplete', JSON.stringify(first));
        assert.equal(seen.filter((role) => role === 'image-processor').length, 1);
        const events = [];
        seen.length = 0;
        workerBodies.length = 0;
        const second = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'страница и обложка', root: dir,
            approvalLevel: 'read', resumeId: first.workId, emit: (event) => events.push(event),
        });
        assert.equal(second.status, 'completed', second.error?.message);
        assert.equal(seen.includes('image-processor'), false, 'prepared assets are reused on resume');
        assert.equal(seen.includes('planner'), false, 'resume keeps the saved plan');
        assert.equal(events.some((event) => event.stage === 'image-processing'), false);
        assert.match(JSON.stringify(workerBodies[0]), /Prepared images and visual assets/);
        assert.match(JSON.stringify(workerBodies[0]), /assets\/cover\.png/);
        assert.match(second.text, /страница готова/);
        const saved = JSON.parse(await readFile(path.join(dir, '.tmp', second.workId, 'progress.json'), 'utf8'));
        assert.equal(saved.imageProcessing.status, 'completed');
        assert.deepEqual(saved.imageProcessing.assets.map((asset) => asset.path), ['assets/cover.png']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('an interrupted image stage resumes before implementation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-interrupt-'));
    const seen = [];
    let interruptImageStage = true;
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'planner') return { text: JSON.stringify({
            summary: 'страница с обложкой', complexity: 'normal',
            steps: [{ goal: 'Создать страницу', details: 'Подключить assets/cover.png', verify: 'прочитать страницу' }],
            filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
            needsReview: false, imageNotes: null, imageTasks: [{ goal: 'Нарисовать обложку', details: 'PNG, assets/cover.png' }], risks: [],
        }) };
        if (role === 'image-processor' && interruptImageStage) {
            interruptImageStage = false;
            return { status: 'incomplete', text: '', reason: 'max_output_tokens' };
        }
        if (role === 'image-processor') return { text: JSON.stringify({
            summary: 'Обложка создана.', assets: [{ path: 'assets/cover.png', format: 'png', use: 'Hero background image.' }], typography: [], notes: [],
        }) };
        return { text: 'страница готова' };
    };
    const config = baseConfig();
    config.agent = { ...config.agent, chain: false, resume: false };
    config.memory = { ...defaults.memory, enabled: false };
    try {
        const first = await runTeam({ client: client(), config, ledger: createLedger(), task: 'страница и обложка', root: dir, emit() {} });
        assert.equal(first.status, 'incomplete');
        assert.equal(seen.filter((role) => role === 'image-processor').length, 1);
        seen.length = 0;
        const second = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'страница и обложка', root: dir,
            resumeId: first.workId, emit() {},
        });
        assert.equal(second.status, 'completed', second.error?.message);
        assert.equal(seen.includes('planner'), false);
        assert.equal(seen.filter((role) => role === 'image-processor').length, 1, 'the unfinished stage is retried');
        assert.ok(seen.indexOf('image-processor') < seen.lastIndexOf('worker'));
        assert.match(second.text, /страница готова/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('measurer stage runs before collector and gives CSS-ready values to the coder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-'));
    const events = [];
    const seen = [];
    const measureBodies = [];
    const coderBodies = [];
    detectCoder = true;
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'answer') return { text: 'Нужен план.\nroute: plan' };
        if (role === 'classifier') return { text: JSON.stringify({ label: 'normal' }) };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 'стили по референсу', complexity: 'normal', steps: [{ goal: 'Создать styles.scss', details: 'Собрать grid по измеренному макету', verify: 'прочитать styles.scss' }], filesOfInterest: [], searchQueries: [], questionsForCollector: ['Какой стиль?'], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        if (role === 'measurer') {
            measureBodies.push(body);
            assert.equal(body.model, 'gpt-6.1-sol');
            assert.equal(body.reasoning?.effort, 'high');
            assert.ok((body.tools ?? []).some((tool) => tool.name === 'fetch_url'), 'the measurer can open its documentation links');
            assert.equal((body.tools ?? []).some((tool) => tool.type === 'web_search'), config.tools.web);
            return { text: JSON.stringify({
                summary: 'Карточка в двухколоночной сетке', source: 'mockup.png', unit: 'px',
                units: { source: 'px', rootFontSize: 16, scale: null, preferred: ['rem'], notes: '1rem = 16px.' },
                confidence: 'high', assumptions: [],
                canvas: { x: 0, y: 0, width: 400, height: 300 },
                elements: [{
                    name: 'Hero card', kind: 'card', box: { x: 50, y: 60, width: 200, height: 160 }, rotation: 0,
                    borders: '1 px solid', radius: 8,
                    padding: { top: 16, right: 20, bottom: 16, left: 20 },
                    margin: { top: null, right: null, bottom: 24, left: null }, gap: 8,
                    spacing: '', placement: 'two-column grid, centered in the canvas',
                    css: 'width: 12.5rem; padding: 1rem 1.25rem;', use: 'card reference',
                    typography: { role: 'heading', family: '', familyConfidence: 'unknown', fontSize: 28, weight: 600, lineHeight: 34, letterSpacing: 0, style: '' },
                    confidence: 'high', notes: '', crop: null,
                }],
                regions: [], rules: [{ name: 'spacing', value: 8, unit: 'px', css: '--space-1: 0.5rem', from: 'card items' }], notes: '',
            }) };
        }
        if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [{ question: 'Какой стиль?', answer: 'минимализм' }], conventions: [], notes: '' }) };
        if (role === 'coder') {
            coderBodies.push(body);
            const prompt = JSON.stringify(body.input);
            assert.match(prompt, /Reference measurements/);
            assert.match(prompt, /left 12\.5%; top 20%; width 50%; height 53\.33%/);
            assert.match(prompt, /padding: top 16 px, right 20 px, bottom 16 px, left 20 px/);
            assert.match(prompt, /margin: bottom 24 px/);
            assert.match(prompt, /gap: 8 px/);
            assert.match(prompt, /spacing: 8 px/);
            assert.match(prompt, /typography: heading, size 28 px, weight 600, line-height 34 px, letter-spacing 0 px/);
            assert.match(body.instructions, /canvas-relative percentages/);
            assert.match(body.instructions, /selected family, CSS stack, role, weights/);
            return { text: 'styles.scss построен по sheet' };
        }
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
        return { text: 'ok' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    config.roles = { ...config.roles, measurer: { ...config.roles.measurer, model: 'gpt-6.1-sol' } };
    const result = await runTeam({
        client: client(), config, ledger: createLedger(), task: 'стили по референсу',
        root: dir, approvalLevel: 'read', parts: [{ type: 'input_image', image: { path: 'mockup.png' } }],
        emit: (event) => events.push(event),
    });
    assert.equal(result.status, 'completed', result.error?.message);
    const stages = events.filter((e) => e.type === 'stage.start').map((e) => e.stage);
    assert.ok(stages.includes('measure'), 'measure stage present: ' + stages.join(', '));
    const measureIdx = stages.indexOf('measure');
    const collectIdx = stages.indexOf('collect');
    assert.ok(measureIdx >= 0 && collectIdx > measureIdx, `measure(${measureIdx}) should run before collect(${collectIdx}), stages: ${stages.join(', ')}`);
    assert.ok(events.some((e) => e.type === 'stage.start' && e.stage === 'measure' && e.role === 'measurer'));
    assert.equal(measureBodies.length, 2, 'the whole reference is measured before fragments');
    assert.equal((measureBodies[0].tools ?? []).some((tool) => tool.name === 'crop_image'), false, 'the overview pass does not start from a crop');
    assert.equal((measureBodies[1].tools ?? []).some((tool) => tool.name === 'crop_image'), true, 'the fragment pass may cut more crops');
    assert.match(JSON.stringify(measureBodies[1].input), /Measurement pass 2/);
    assert.match(JSON.stringify(measureBodies[1].input), /Overview sheet \(JSON\)/);
    assert.ok(events.some((e) => e.type === 'measure.pass' && e.pass === 1 && e.phase === 'overview'));
    assert.ok(events.some((e) => e.type === 'measure.pass' && e.pass === 2 && e.phase === 'fragments'));
    assert.ok(events.some((e) => e.type === 'measure.conclusion' && e.elements === 1));
    assert.ok(coderBodies.length > 0, 'the SCSS step is assigned to coder');
    const savedSheet = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.json'), 'utf8'));
    assert.equal(savedSheet.elements[0].box.width, 200);
    assert.equal(savedSheet.units.rootFontSize, 16);
    const savedConclusion = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.conclusion.json'), 'utf8'));
    assert.equal(savedConclusion.counts.elements, 1);
    assert.match(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.toon'), 'utf8'), /elements\[1\]/);
    assert.match(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.conclusion.toon'), 'utf8'), /counts/);
    await rm(dir, { recursive: true, force: true });
});

test('the fragment pass replaces the overview sheet and reuses its crops', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-passes-'));
    const events = [];
    const measureBodies = [];
    let measureCalls = 0;
    await writeFile(path.join(dir, 'mockup.png'), Buffer.from(TINY_PNG, 'base64'));
    const sheet = (summary, elements, regions) => ({
        summary, source: 'mockup.png', unit: 'px',
        units: { source: 'px', rootFontSize: 16, scale: null, preferred: ['rem'], notes: '1rem = 16px.' },
        confidence: summary === 'overview' ? 'low' : 'high', assumptions: [],
        canvas: { x: 0, y: 0, width: 1, height: 1 },
        elements, regions, rules: [], notes: '',
    });
    const element = (name) => ({
        name, kind: 'card', box: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0,
        borders: '', radius: null, padding: { top: null, right: null, bottom: null, left: null },
        margin: { top: null, right: null, bottom: null, left: null }, gap: null,
        spacing: '', placement: 'single anchor', css: 'width: 1px; height: 1px;', use: 'card reference',
        typography: null, confidence: 'high', notes: '', crop: null,
    });
    const region = (name) => ({
        name, kind: 'card', box: { x: 0, y: 0, width: 1, height: 1 },
        how: 'the whole tile', use: 'card reference', crop: null,
    });
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Нужен план.\nroute: plan' };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 'замер', complexity: 'normal', steps: [{ goal: 'Создать страницу', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        if (role === 'measurer') {
            measureBodies.push(body);
            measureCalls += 1;
            return { text: JSON.stringify(measureCalls === 1
                ? sheet('overview', [element('Card')], [region('Card region')])
                : sheet('fragments', [element('Card'), element('Badge')], [region('Card region')])) };
        }
        if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [], conventions: [], notes: '' }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'готово', memories: [] }) };
        return { text: 'worker done' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    config.agent = { ...config.agent, measurerPasses: 2, measurerMaxTurns: 6 };
    try {
        const result = await runTeam({
            client: client(), config, ledger: createLedger(), task: 'страница по макету',
            root: dir, approvalLevel: 'read', parts: [{ type: 'input_image', image: { path: 'mockup.png' } }],
            emit: (event) => events.push(event),
        });
        assert.equal(result.status, 'completed', result.error?.message);
        assert.equal(measureCalls, 2);
        assert.match(JSON.stringify(measureBodies[1].input), /# Staged fragments/);
        assert.match(JSON.stringify(measureBodies[1].input), /\.tmp\/[^/]+\/crops\/01-region-card-region\.png/);
        const saved = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.json'), 'utf8'));
        assert.equal(saved.summary, 'fragments');
        assert.equal(saved.elements.length, 2);
        assert.equal(saved.elements[0].crop, saved.elements[1].crop, 'the shared box reuses one crop');
        assert.equal(saved.regions[0].crop, saved.elements[0].crop);
        const conclusion = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.conclusion.json'), 'utf8'));
        assert.equal(conclusion.counts.crops, 1);
        assert.match(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.toon'), 'utf8'), /summary: fragments/);
        assert.ok(events.some((event) => event.type === 'measure.crops' && event.count === 1));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('architect runs after the measurements and gives the structure to the orchestrator and the author', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-architect-'));
    const events = [];
    const seen = [];
    let architectBody = null;
    let collectBody = null;
    let coderBody = null;
    detectCoder = true;
    script = (body) => {
        const role = roleOf(body);
        seen.push(role);
        if (role === 'classifier') return { text: JSON.stringify({ label: 'normal' }) };
        if (role === 'planner') {
            return { text: JSON.stringify({
                summary: 'приложение с точкой входа', complexity: 'normal',
                steps: [{ goal: 'Создать src/app.js', details: 'Экспортировать start()', verify: 'прочитать src/app.js', complexity: 'normal' }],
                filesOfInterest: ['src/app.js'], searchQueries: [], questionsForCollector: [],
                acceptanceCriteria: ['start() экспортирован'], needsReview: false, imageNotes: null, risks: [],
                imageTasks: [], fileActions: [], taskMap: [],
            }) };
        }
        if (role === 'measurer') {
            return { text: JSON.stringify({
                summary: 'Макет с одной карточкой', source: 'mockup.png', unit: 'px',
                canvas: { x: 0, y: 0, width: 400, height: 300 }, elements: [], regions: [], rules: [], notes: '',
            }) };
        }
        if (role === 'architect') {
            architectBody = body;
            const prompt = JSON.stringify(body.input);
            assert.match(prompt, /s01/);
            assert.match(prompt, /Reference measurements/);
            return { text: JSON.stringify({
                summary: 'Один модуль src/app.js и стили рядом',
                structure: [{
                    path: 'src/app.js', kind: 'code', purpose: 'точка входа', responsibilities: 'запуск приложения',
                    dependsOn: [], notes: 'экспортировать start()',
                }],
                design: { layout: '', typography: '', color: '', motion: '', assets: '' },
                stepGuidance: [{ stepId: 's01', files: ['src/app.js'], guidance: 'Создать src/app.js и экспортировать start().' }],
                questionsForOrchestrator: ['Где находится точка входа?'],
                conventions: ['ES-модули'], risks: [],
            }) };
        }
        if (role === 'collector') {
            collectBody = body;
            return { text: JSON.stringify({
                findings: [], answers: [{ question: 'Где находится точка входа?', answer: 'src/app.js' }],
                conventions: [], notes: '',
            }) };
        }
        if (role === 'coder') {
            coderBody = body;
            return { text: 'src/app.js готов' };
        }
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
        return { text: 'ok' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    config.agent = { ...config.agent, architect: 'always', chain: false, resume: false };
    const result = await runTeam({
        client: client(), config, ledger: createLedger(), task: 'создай приложение', root: dir, approvalLevel: 'read',
        parts: [{ type: 'input_image', image: { path: 'mockup.png' } }],
        emit: (event) => events.push(event),
    });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.ok(architectBody, 'architect ran');
    const stages = events.filter((event) => event.type === 'stage.start').map((event) => event.stage);
    assert.ok(stages.indexOf('architect') > stages.indexOf('plan'), stages.join(', '));
    assert.ok(stages.indexOf('measure') < stages.indexOf('architect'), stages.join(', '));
    assert.ok(stages.indexOf('architect') < stages.indexOf('collect'), stages.join(', '));
    assert.match(JSON.stringify(collectBody.input), /Questions from the architect/);
    assert.match(JSON.stringify(collectBody.input), /Где находится точка входа\?/);
    assert.match(JSON.stringify(coderBody.input), /Architect guidance for this step/);
    assert.match(JSON.stringify(coderBody.input), /Создать src\/app\.js и экспортировать start\(\)\./);
    assert.equal(result.architecture.structure[0].path, 'src/app.js');
    const saved = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'architecture.json'), 'utf8'));
    assert.equal(saved.stepGuidance[0].stepId, 's01');
    assert.ok(seen.includes('architect'));
    await rm(dir, { recursive: true, force: true });
});

test('a spent measurement budget still returns the sheet for what the role already looked at', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-cap-'));
    const events = [];
    const measureBodies = [];
    script = (body) => {
        const role = roleOf(body);
        if (role === 'answer') return { text: 'Нужен план.\nroute: plan' };
        if (role === 'planner') {
            return { text: JSON.stringify({ summary: 'замер', complexity: 'normal', steps: [{ goal: 'Создать стили', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: ['Какой стиль?'], acceptanceCriteria: [], needsReview: false, imageNotes: null, risks: [] }) };
        }
        if (role === 'measurer') {
            measureBodies.push(body);
            if (measureBodies.length === 1) return { calls: [{ name: 'view_image', arguments: { path: 'missing.png', detail: 'auto', question: 'что на макете?' } }] };
            return { text: JSON.stringify({ summary: 'Замерено частично', source: 'mockup.png', unit: 'px', canvas: { width: 400, height: 300 }, elements: [], regions: [], rules: [], notes: 'Часть деталей не разглядена' }) };
        }
        if (role === 'collector') return { text: JSON.stringify({ findings: [], answers: [{ question: 'Какой стиль?', answer: 'минимализм' }], conventions: [], notes: '' }) };
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'x', memories: [] }) };
        return { text: 'ok' };
    };
    const config = baseConfig();
    config.memory = { ...defaults.memory, enabled: false };
    config.agent = { ...config.agent, chain: false, resume: false, measurerPasses: 1, measurerMaxTurns: 1 };
    const result = await runTeam({
        client: client(), config, ledger: createLedger(), task: 'замерь макет',
        root: dir, approvalLevel: 'read', parts: [{ type: 'input_image', image: { path: 'mockup.png' } }],
        emit: (event) => events.push(event),
    });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(measureBodies.length, 2, 'one capped pass plus one tool-less report pass');
    assert.equal(measureBodies[1].tools, undefined, 'the report pass has no tools left');
    assert.ok(events.some((event) => event.type === 'warning' && /отдаёт лист/.test(event.message)));
    const sheet = JSON.parse(await readFile(path.join(dir, '.tmp', result.workId, 'measurements.json'), 'utf8'));
    assert.equal(sheet.summary, 'Замерено частично');
    await rm(dir, { recursive: true, force: true });
});
