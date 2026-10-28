import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
    EXECUTORS, EXECUTOR_NAMES, SLICES, NESTED_FORBIDDEN,
    executorNames, executorSpec, executorToolNames, isExecutor,
} from '../src/agent/role-registry.js';
import { SUBAGENT_NAMES, subagentToolNames } from '../src/agent/subagents.js';
import { TOOL_SPECS, toolDefinitions, createToolset } from '../src/agent/tools.js';
import { createDesktopHandlers } from '../src/agent/desktop.js';
import { defaults } from '../src/core/config.js';

const CALLER_TOOLS = [
    'list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall', 'list_backups',
    'run_command', 'run_script', 'ssh', 'screenshot', 'click', 'type', 'run_ahk',
    'write_file', 'fetch_url', 'crop_image', 'split_image', 'run_subagent', 'delegate_role', 'run_batch', 'ask_user',
];

const customConfig = () => ({
    ...defaults,
    roles: {
        ...defaults.roles,
        researcher: { ...defaults.roles.default, instructions: 'You research one question and cite sources.', tools: ['read_file', 'search_files'], turns: 9 },
    },
});

// ── registry ───────────────────────────────────────────────────────────────

test('the registry is the union of the old specialist and sub-agent lists', () => {
    // delegate_role had solver, clicker, typer, encoder, tester, measurer.
    // run_subagent had coder, worker, writer, reviewer, tester, vision, solver, image-processor.
    const union = ['coder', 'styler', 'iconifier', 'worker', 'writer', 'reviewer', 'tester', 'vision', 'solver', 'measurer', 'decorator', 'image-processor', 'clicker', 'typer', 'encoder'];
    assert.deepEqual(EXECUTOR_NAMES, union);
    assert.deepEqual(SUBAGENT_NAMES, union);
});

test('every slice is callable and returns a tool list', () => {
    for (const [name, slice] of Object.entries(SLICES)) {
        assert.equal(typeof slice, 'function', name);
        const names = slice(CALLER_TOOLS);
        assert.ok(Array.isArray(names), name);
    }
    assert.deepEqual(SLICES.all(CALLER_TOOLS), CALLER_TOOLS);
});

test('nested runs never receive a tool that starts another run', () => {
    for (const name of NESTED_FORBIDDEN) assert.ok(CALLER_TOOLS.includes(name), name);
});

test('executorNames adds user-defined roles after the built-ins', () => {
    const config = customConfig();
    const names = executorNames(config);
    assert.deepEqual(names.slice(0, EXECUTOR_NAMES.length), [...EXECUTOR_NAMES]);
    assert.ok(names.includes('researcher'));
    // A built-in pipeline role is not an executor: it has a pipeline job, not a free-form task.
    assert.ok(!names.includes('planner'));
});

test('executorNames without a config lists only the built-ins', () => {
    assert.deepEqual(executorNames(), [...EXECUTOR_NAMES]);
});

test('isExecutor answers for built-in and user-defined names', () => {
    const config = customConfig();
    assert.equal(isExecutor('coder', config), true);
    assert.equal(isExecutor('researcher', config), true);
    assert.equal(isExecutor('planner', config), false);
    assert.equal(isExecutor('ghost', config), false);
});

// ── specs ──────────────────────────────────────────────────────────────────

test('executorSpec returns the built-in entry unchanged', () => {
    assert.equal(executorSpec('coder'), EXECUTORS.coder);
    assert.equal(executorSpec('measurer').schema, 'measure');
    assert.equal(executorSpec('encoder').schema, 'batch');
});

test('executorSpec builds a spec for a user-defined role', () => {
    const spec = executorSpec('researcher', customConfig());
    assert.deepEqual(spec.tools, ['read_file', 'search_files']);
    assert.equal(spec.turns, 9);
    assert.equal(spec.schema, null);
    assert.match(spec.description, /You research one question/);
});

test('a user-defined role without tools gets the whole caller set', () => {
    const config = { ...defaults, roles: { ...defaults.roles, observer: { ...defaults.roles.default, instructions: 'Watch.' } } };
    const spec = executorSpec('observer', config);
    assert.equal(spec.tools, 'all');
    assert.equal(spec.turns, 20);
    assert.deepEqual(executorToolNames(spec, CALLER_TOOLS), CALLER_TOOLS.filter((name) => !NESTED_FORBIDDEN.includes(name)));
});

test('executorSpec returns null for an unknown role', () => {
    assert.equal(executorSpec('ghost'), null);
    assert.equal(executorSpec('planner'), null);
});

// ── tool names ─────────────────────────────────────────────────────────────

test('a slice spec resolves through the caller set', () => {
    const names = executorToolNames({ tools: 'read' }, CALLER_TOOLS);
    assert.ok(names.includes('read_file') && names.includes('fetch_url'));
    assert.ok(!names.includes('write_file'));
});

test('an explicit tool list is intersected with the caller set', () => {
    const names = executorToolNames({ tools: ['read_file', 'not_enabled'] }, CALLER_TOOLS);
    assert.deepEqual(names, ['read_file']);
});

test('nested=false keeps the delegation tools', () => {
    const names = executorToolNames({ tools: 'all' }, CALLER_TOOLS, { nested: false });
    assert.ok(names.includes('run_subagent') && names.includes('delegate_role'));
});

// ── tool schemas ───────────────────────────────────────────────────────────

test('delegate_role takes a role, a task, and a context flag', () => {
    const spec = TOOL_SPECS.delegate_role;
    assert.deepEqual(Object.keys(spec.parameters.properties).sort(), ['context', 'role', 'task']);
    assert.deepEqual(spec.parameters.required.slice().sort(), ['context', 'role', 'task']);
    assert.equal(spec.parameters.properties.context.type, 'boolean');
    assert.equal(spec.parameters.properties.role.type, 'string');
});

test('toolDefinitions narrows a field to the given values', () => {
    const [definition] = toolDefinitions(['delegate_role'], { delegate_role: { role: ['coder', 'researcher'] } });
    assert.deepEqual(definition.parameters.properties.role.enum, ['coder', 'researcher']);
    // The other fields keep their own shape.
    assert.equal(definition.parameters.properties.context.type, 'boolean');
});

test('toolDefinitions keeps the static enum without overrides', () => {
    const [definition] = toolDefinitions(['delegate_role']);
    assert.deepEqual(definition.parameters.properties.role.enum, ['solver', 'clicker', 'typer', 'encoder', 'tester', 'measurer', 'decorator', 'styler', 'iconifier']);
});

test('createToolset passes the dynamic enum into definitions', () => {
    const config = customConfig();
    const toolset = createToolset({
        root: process.cwd(), config, names: ['delegate_role'], approvalLevel: 'read',
        delegate: async () => ({ output: 'ok', summary: 'ok' }),
        toolEnums: { delegate_role: { role: executorNames(config) } },
    });
    const [definition] = toolset.definitions();
    assert.ok(definition.parameters.properties.role.enum.includes('researcher'));
    assert.ok(definition.parameters.properties.role.enum.includes('coder'));
});

// ── delegate_role handler ──────────────────────────────────────────────────

test('delegate_role forwards the role, the task, and the context flag', async () => {
    const calls = [];
    const handlers = createDesktopHandlers({
        root: process.cwd(), config: defaults,
        delegate: async (role, task, options) => {
            calls.push({ role, task, options });
            return { output: `${role} done`, summary: `${role} ok` };
        },
    });
    const result = await handlers.delegate_role({ role: 'researcher', task: 'find the spec', context: true });
    assert.equal(result.output, 'researcher done');
    assert.equal(result.summary, 'researcher ok');
    assert.deepEqual(calls, [{ role: 'researcher', task: 'find the spec', options: { context: true } }]);
});

test('delegate_role defaults context to false', async () => {
    const calls = [];
    const handlers = createDesktopHandlers({
        root: process.cwd(), config: defaults,
        delegate: async (role, task, options) => { calls.push(options); return { output: 'ok', summary: 'ok' }; },
    });
    await handlers.delegate_role({ role: 'solver', task: 'x' });
    assert.deepEqual(calls, [{ context: false }]);
});

test('delegate_role refuses to run without a delegate', async () => {
    const handlers = createDesktopHandlers({ root: process.cwd(), config: defaults });
    await assert.rejects(() => handlers.delegate_role({ role: 'solver', task: 'x' }), /delegate_role недоступен/);
});

test('the toolset exposes delegate_role without desktop tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-delegate-'));
    try {
        const toolset = createToolset({
            root, config: defaults, names: ['delegate_role', 'read_file'], approvalLevel: 'read',
            delegate: async () => ({ output: 'measured', summary: 'measurer ok' }),
        });
        assert.ok(toolset.names().includes('delegate_role'));
        const result = await toolset.execute({ name: 'delegate_role', arguments: JSON.stringify({ role: 'measurer', task: 'measure', context: false }) });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /measured/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a custom role reaches both delegation tools', async () => {
    const config = customConfig();
    const names = executorNames(config);
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-delegate-custom-'));
    try {
        const toolset = createToolset({
            root, config, names: ['delegate_role', 'run_subagent'], approvalLevel: 'read',
            delegate: async () => ({ output: 'ok', summary: 'ok' }),
            subagent: async () => ({ output: 'ok', summary: 'ok', ok: true }),
            toolEnums: { delegate_role: { role: names }, run_subagent: { kind: names } },
        });
        const definitions = Object.fromEntries(toolset.definitions().map((definition) => [definition.name, definition]));
        assert.ok(definitions.delegate_role.parameters.properties.role.enum.includes('researcher'));
        assert.ok(definitions.run_subagent.parameters.properties.kind.enum.includes('researcher'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a custom role runs through the sub-agent runner', async () => {
    const config = customConfig();
    const seen = [];
    const { createSubagentRunner } = await import('../src/agent/subagents.js');
    const runner = createSubagentRunner({
        config,
        roles: {
            resolve: (name) => ({ name, model: `model-${name}` }),
            run: async (role, options) => { seen.push({ role, options }); return { status: 'completed', text: 'report', turns: 1, toolCalls: 0, images: [] }; },
        },
        root: process.cwd(), allNames: CALLER_TOOLS, approvalLevel: 'read',
    });
    const result = await runner('researcher', 'find the spec');
    assert.equal(seen[0].role, 'researcher');
    assert.equal(seen[0].options.maxTurns, 9);
    assert.deepEqual(seen[0].options.toolset.names(), ['read_file', 'search_files']);
    assert.equal(result.ok, true);
});
