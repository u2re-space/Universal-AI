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

test('the sub-agent registry and the tool enum stay in step', () => {
    assert.deepEqual(SUBAGENT_NAMES, ['reader', 'implementor', 'verifier']);
    for (const name of SUBAGENT_NAMES) {
        assert.ok(ROLE_MODULES[SUBAGENTS[name].role], `${name} needs a registered role prompt`);
        assert.ok(Number.isSafeInteger(SUBAGENTS[name].turns) && SUBAGENTS[name].turns > 0);
        assert.ok(SUBAGENTS[name].description.length > 20);
    }
    assert.deepEqual(TOOL_SPECS.run_subagent.parameters.properties.kind.enum, SUBAGENT_NAMES);
    assert.deepEqual(TOOL_SPECS.run_subagent.parameters.required.slice().sort(), ['kind', 'task']);

    assert.equal(enabledToolNames({ ...defaults.tools, subagents: true }).includes('run_subagent'), true);
    assert.equal(enabledToolNames({ ...defaults.tools, subagents: false }).includes('run_subagent'), false);
});

test('a sub-agent gets its own tool slice and never a nested delegation', () => {
    const all = [...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES, 'write_file', 'fetch_url', 'ask_user', 'run_subagent', 'delegate_role', 'run_batch'];
    const reader = subagentToolNames('reader', all);
    assert.ok(reader.includes('read_file'));
    assert.ok(reader.includes('fetch_url'));
    for (const name of ['write_file', 'run_command', 'run_subagent', 'delegate_role', 'run_batch', 'ask_user']) {
        assert.equal(reader.includes(name), false, `reader must not have ${name}`);
    }

    const verifier = subagentToolNames('verifier', all);
    assert.ok(verifier.includes('read_file') && verifier.includes('run_command'));
    assert.equal(verifier.includes('write_file'), false);

    const implementor = subagentToolNames('implementor', all);
    assert.ok(implementor.includes('write_file') && implementor.includes('run_command'));
    for (const name of ['run_subagent', 'delegate_role', 'run_batch', 'ask_user']) {
        assert.equal(implementor.includes(name), false, `implementor must not have ${name}`);
    }

    // The slice never offers a tool the calling agent does not have.
    assert.deepEqual(subagentToolNames('reader', ['read_file']), ['read_file']);
    assert.equal(subagentToolNames('implementor', ['read_file']).includes('write_file'), false);
    assert.throws(() => subagentToolNames('ghost', all), /Неизвестный суб-агент/);
});

test('run_subagent is offered only when a runner is wired, and folds the nested stats', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-tool-'));
    try {
        const names = ['run_subagent', 'write_file'];
        const without = createToolset({ root, config: defaults, names, approvalLevel: 'all' });
        assert.equal(without.names().includes('run_subagent'), false);
        const blocked = await without.execute({ name: 'run_subagent', arguments: JSON.stringify({ kind: 'reader', task: 'x' }) });
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
        const result = await toolset.execute({ name: 'run_subagent', arguments: JSON.stringify({ kind: 'implementor', task: 'create inner.txt' }) });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /wrote inner\.txt/);
        assert.equal(result.summary, 'implementor: completed');
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
            agentsText: 'AGENTS.md rules', emit: (event) => events.push(event),
        });
        const result = await subagent('reader', 'Find the config loader.');
        assert.equal(roles.seen.length, 1);
        const call = roles.seen[0];
        assert.equal(call.role, 'reader');
        assert.equal(call.text, 'Find the config loader.');
        assert.equal(call.silent, true);
        assert.equal(call.maxTurns, SUBAGENTS.reader.turns);
        assert.equal(call.instructions, 'AGENTS.md rules');
        assert.equal(call.toolset.names().includes('run_subagent'), false, 'a sub-agent cannot delegate again');
        assert.match(result.output, /Суб-агент reader: статус completed/);
        assert.match(result.output, /report/);
        assert.equal(result.ok, true);
        assert.deepEqual(events.map((event) => event.type), ['subagent.start', 'subagent.done']);
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
        await assert.rejects(() => subagent('reader', '   '), /task пуст/);
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
                return { status: 'max_turns', text: '', turns: SUBAGENTS.verifier.turns, toolCalls: 1, images: [], error: new Error('лимит ходов') };
            }),
            root, allNames: [...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES, 'write_file'], approvalLevel: 'read',
        });
        const result = await subagent('verifier', 'run the tests');
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
