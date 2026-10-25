import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { SUBAGENTS, SUBAGENT_NAMES, subagentToolNames, createSubagentRunner } from '../src/agent/subagents.js';
import { TOOL_SPECS, enabledToolNames, createToolset, READ_ONLY_TOOLS } from '../src/agent/tools.js';
import { SHELL_TOOL_NAMES } from '../src/agent/tool-specs.js';
import { ROLE_MODULES } from '../src/roles/index.js';
import { defaults } from '../src/core/config.js';

/** A role runner stub: it records the request and lets the test drive the nested toolset. */
function fakeRoles(run) {
    const seen = [];
    return {
        seen,
        resolve: (name) => ({ name, model: `model-${name}`, effort: 'low' }),
        run: async (role, options) => {
            seen.push({ role, ...options });
            return run ? run(options) : { status: 'completed', text: 'report', turns: 2, toolCalls: 1, images: [] };
        },
    };
}

const SLICE_NAMES = ['all', 'read', 'check', 'screen', 'images'];

const CALLER_TOOLS = [
    ...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES, 'screenshot', 'click', 'type', 'run_ahk',
    'write_file', 'fetch_url', 'crop_image', 'ask_user', 'run_subagent', 'delegate_role', 'run_batch',
];

test('a sub-agent is an existing role, and the registry and the tool enum stay in step', () => {
    assert.deepEqual(SUBAGENT_NAMES, ['coder', 'worker', 'writer', 'reviewer', 'tester', 'vision', 'solver', 'image-processor']);
    for (const name of SUBAGENT_NAMES) {
        assert.ok(ROLE_MODULES[name], `${name} needs a registered role prompt`);
        assert.ok(defaults.roles[name], `${name} needs role settings so its model is configurable`);
        assert.ok(SLICE_NAMES.includes(SUBAGENTS[name].tools), `${name} names a known tool slice`);
        assert.ok(Number.isSafeInteger(SUBAGENTS[name].turns) && SUBAGENTS[name].turns > 0);
        assert.ok(SUBAGENTS[name].description.length > 20);
    }
    assert.deepEqual(TOOL_SPECS.run_subagent.parameters.properties.kind.enum, SUBAGENT_NAMES);
    assert.deepEqual(TOOL_SPECS.run_subagent.parameters.required.slice().sort(), ['kind', 'task']);

    assert.equal(enabledToolNames({ ...defaults.tools, subagents: true }).includes('run_subagent'), true);
    assert.equal(enabledToolNames({ ...defaults.tools, subagents: false }).includes('run_subagent'), false);
});

test('every sub-agent stays inside its remit and never delegates again', () => {
    for (const kind of SUBAGENT_NAMES) {
        const names = subagentToolNames(kind, CALLER_TOOLS);
        assert.ok(names.length > 0, `${kind} needs at least one tool`);
        for (const name of ['run_subagent', 'delegate_role', 'run_batch', 'ask_user']) {
            assert.equal(names.includes(name), false, `${kind} must not have ${name}`);
        }
        // A sub-agent that only checks may look at the screen but never drives it.
        if (SUBAGENTS[kind].tools !== 'all') {
            for (const name of ['click', 'type', 'run_ahk']) {
                assert.equal(names.includes(name), false, `${kind} must not have ${name}`);
            }
        }
    }

    for (const kind of ['coder', 'worker', 'writer']) {
        const names = subagentToolNames(kind, CALLER_TOOLS);
        assert.ok(names.includes('write_file') && names.includes('run_command'), `${kind} must be able to work`);
    }

    for (const kind of ['reviewer', 'tester']) {
        const names = subagentToolNames(kind, CALLER_TOOLS);
        assert.ok(names.includes('read_file') && names.includes('run_command') && names.includes('screenshot'));
        assert.equal(names.includes('write_file'), false, `${kind} must not change files`);
    }

    const vision = subagentToolNames('vision', CALLER_TOOLS);
    assert.ok(vision.includes('view_image'));
    for (const name of ['run_command', 'write_file', 'screenshot']) {
        assert.equal(vision.includes(name), false, `vision must not have ${name}`);
    }

    const solver = subagentToolNames('solver', CALLER_TOOLS);
    assert.ok(solver.includes('view_image') && solver.includes('screenshot'));
    assert.equal(solver.includes('run_command'), false);

    const assets = subagentToolNames('image-processor', CALLER_TOOLS);
    assert.ok(assets.includes('crop_image') && assets.includes('view_image'));
    for (const name of ['write_file', 'run_command']) {
        assert.equal(assets.includes(name), false, `image-processor must not have ${name}`);
    }

    // The slice never offers a tool the calling agent does not have.
    assert.deepEqual(subagentToolNames('vision', ['read_file']), ['read_file']);
    assert.deepEqual(subagentToolNames('solver', ['read_file']), ['read_file']);
    assert.equal(subagentToolNames('coder', ['read_file']).includes('write_file'), false);
    assert.throws(() => subagentToolNames('ghost', CALLER_TOOLS), /Неизвестный суб-агент/);
});

test('run_subagent is offered only when a runner is wired, and folds the nested stats', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-tool-'));
    try {
        const names = ['run_subagent', 'write_file'];
        const without = createToolset({ root, config: defaults, names, approvalLevel: 'all' });
        assert.equal(without.names().includes('run_subagent'), false);
        const blocked = await without.execute({ name: 'run_subagent', arguments: JSON.stringify({ kind: 'coder', task: 'x' }) });
        assert.equal(blocked.ok, false);
        assert.match(blocked.output, /недоступен/);

        const runner = createSubagentRunner({
            config: defaults, roles: fakeRoles(async (options) => {
                await options.toolset.execute({ name: 'write_file', call_id: 'n1', arguments: JSON.stringify({ path: 'inner.txt', content: 'inner\n', overwrite: true }) });
                return { status: 'completed', text: 'wrote inner.txt', turns: 2, toolCalls: 1, images: [] };
            }),
            root, allNames: names, approvalLevel: 'all',
        });
        const toolset = createToolset({ root, config: defaults, names, approvalLevel: 'all', subagent: runner });
        assert.equal(toolset.names().includes('run_subagent'), true);
        const result = await toolset.execute({ name: 'run_subagent', arguments: JSON.stringify({ kind: 'coder', task: 'create inner.txt' }) });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /wrote inner\.txt/);
        assert.equal(result.summary, 'coder: completed');
        // The nested write is visible to the caller: the orchestrator and the reviewer read these stats.
        const changes = toolset.stats().changes;
        assert.equal(changes.length, 1);
        assert.equal(changes[0].op, 'create');
        assert.equal(changes[0].path, 'inner.txt');
        assert.equal(toolset.stats().byTool.run_subagent, 1);
        assert.equal(toolset.stats().byTool.write_file, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the sub-agent runs on its own context, tools, and turn cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-run-'));
    const events = [];
    try {
        const roles = fakeRoles();
        const subagent = createSubagentRunner({
            config: defaults, roles, root, allNames: ['read_file', 'run_subagent'], approvalLevel: 'read',
            agentsText: () => 'AGENTS.md rules', emit: (event) => events.push(event),
        });
        const result = await subagent('vision', 'Describe .tmp/mock.png');
        assert.equal(roles.seen.length, 1);
        const call = roles.seen[0];
        assert.equal(call.role, 'vision');
        assert.equal(call.text, 'Describe .tmp/mock.png');
        assert.equal(call.silent, true);
        assert.equal(call.maxTurns, SUBAGENTS.vision.turns);
        // The role runner adds the role prompt; the sub-agent only carries the project rules.
        assert.equal(call.instructions, 'AGENTS.md rules');
        assert.deepEqual(call.toolset.names(), ['read_file'], 'a sub-agent cannot delegate again');
        assert.match(result.output, /Суб-агент vision: статус completed/);
        assert.match(result.output, /report/);
        assert.equal(result.ok, true);
        assert.deepEqual(events.map((event) => event.type), ['subagent.start', 'subagent.done']);
        assert.equal(events[0].model, 'model-vision');
        assert.equal(events[1].status, 'completed');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('run_subagent rejects an unknown kind and an empty task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-bad-'));
    try {
        const subagent = createSubagentRunner({ config: defaults, roles: fakeRoles(), root, allNames: ['read_file'], approvalLevel: 'read' });
        await assert.rejects(() => subagent('ghost', 'task'), /неизвестный суб-агент «ghost»/);
        await assert.rejects(() => subagent('worker', '   '), /task пуст/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the sub-agent stays inside the caller access policy and reports a failed status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-policy-'));
    try {
        const subagent = createSubagentRunner({
            config: defaults,
            roles: fakeRoles(async (options) => {
                const denied = await options.toolset.execute({ name: 'run_command', call_id: 'n1', arguments: JSON.stringify({ command: 'dir', cwd: '', shell: '', reason: '' }) });
                assert.equal(denied.ok, false);
                assert.match(denied.output, /политикой доступа/);
                return { status: 'max_turns', text: '', turns: SUBAGENTS.tester.turns, toolCalls: 1, images: [], error: new Error('лимит ходов') };
            }),
            root, allNames: [...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES, 'write_file'], approvalLevel: 'read',
        });
        const result = await subagent('tester', 'check that npm test passes');
        assert.equal(result.ok, false);
        assert.match(result.output, /статус max_turns/);
        assert.match(result.output, /отчёт пуст/);
        assert.match(result.output, /лимит ходов/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the orchestrator and the architect stay read-only while the reviewer may use sub-agents', async () => {
    const { toolNamesForRole } = await import('../src/agent/team.js');
    const all = enabledToolNames({ ...defaults.tools, desktop: false, images: false });
    assert.equal(all.includes('run_subagent'), true);
    assert.equal(toolNamesForRole(all, 'worker').includes('run_subagent'), true);
    assert.equal(toolNamesForRole(all, 'reviewer').includes('run_subagent'), true);
    assert.equal(toolNamesForRole(all, 'orchestrator').includes('run_subagent'), false);
    assert.equal(toolNamesForRole(all, 'architect').includes('run_subagent'), false);
    assert.equal(toolNamesForRole(all, 'image-processor').includes('run_subagent'), false);
});
