import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveRole, roleNames, BUILTIN_ROLE_NAMES, ROLE_NAMES, CUSTOM_ROLE_NAME, defaults } from '../src/core/config.js';
import { toolNamesForRole } from '../src/agent/team.js';

const home = 'test/.home-custom-roles';

/**
 * Load a config with the given role definitions.
 * @param {object} roles
 * @param {object} [extra]
 * @returns {Promise<object>}
 */
const load = (roles, extra = {}) => loadConfig({
    env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-sol' },
    overrides: { roles, ...extra },
    ensureHome: false,
});

// ── names ──────────────────────────────────────────────────────────────────

test('BUILTIN_ROLE_NAMES lists every role the code ships', () => {
    assert.deepEqual([...BUILTIN_ROLE_NAMES], [...ROLE_NAMES]);
    assert.ok(BUILTIN_ROLE_NAMES.includes('planner'));
    assert.ok(BUILTIN_ROLE_NAMES.includes('image-processor'));
});

test('a custom role name is a short lower-case slug', () => {
    assert.ok(CUSTOM_ROLE_NAME.test('researcher'));
    assert.ok(CUSTOM_ROLE_NAME.test('docs-writer'));
    assert.ok(CUSTOM_ROLE_NAME.test('qa_2'));
    assert.ok(!CUSTOM_ROLE_NAME.test('Researcher'));
    assert.ok(!CUSTOM_ROLE_NAME.test('2fast'));
    assert.ok(!CUSTOM_ROLE_NAME.test('has space'));
    assert.ok(!CUSTOM_ROLE_NAME.test('a'.repeat(33)));
});

test('roleNames adds the configured names after the built-ins', async () => {
    const config = await load({ researcher: { model: 'gpt-6-luna' } });
    const names = roleNames(config);
    assert.deepEqual(names.slice(0, BUILTIN_ROLE_NAMES.length), [...BUILTIN_ROLE_NAMES]);
    assert.ok(names.includes('researcher'));
    assert.equal(names.length, BUILTIN_ROLE_NAMES.length + 1);
});

test('roleNames without custom roles returns the built-ins', async () => {
    const config = await load({});
    assert.deepEqual(roleNames(config), [...BUILTIN_ROLE_NAMES]);
});

// ── validation ─────────────────────────────────────────────────────────────

test('a custom role with its own model is accepted', async () => {
    const config = await load({ researcher: { model: 'gpt-6-luna' } });
    assert.equal(config.roles.researcher.model, 'gpt-6-luna');
});

test('a malformed custom role name is rejected', async () => {
    await assert.rejects(load({ 'Researcher': { model: 'gpt-6-luna' } }), /roles\.Researcher/);
    await assert.rejects(load({ '2fast': { model: 'gpt-6-luna' } }), /roles\.2fast/);
});

test('a custom role still rejects unknown fields', async () => {
    await assert.rejects(load({ researcher: { speed: 3 } }), /roles\.researcher\.speed: неизвестное поле/);
});

test('a custom role validates its fields like a built-in one', async () => {
    await assert.rejects(load({ researcher: { effort: 'extreme' } }), /roles\.researcher\.effort/);
    await assert.rejects(load({ researcher: { maxEffort: 'extreme' } }), /roles\.researcher\.maxEffort/);
    await assert.rejects(load({ researcher: { temperature: 9 } }), /roles\.researcher\.temperature/);
});

// ── resolveRole ────────────────────────────────────────────────────────────

test('resolveRole serves a custom role from its own settings', async () => {
    const config = await load({
        researcher: {
            model: 'gpt-6-luna', effort: 'high', instructions: 'You research one question.',
            tools: ['read_file', 'search_files'], context: 'small', maxEffort: 'xhigh',
        },
    });
    const role = resolveRole(config, 'researcher');
    assert.equal(role.model, 'gpt-6-luna');
    assert.equal(role.effort, 'high');
    assert.equal(role.instructions, 'You research one question.');
    assert.deepEqual(role.tools, ['read_file', 'search_files']);
    assert.equal(role.context, 16 * 1024);
    assert.equal(role.ceiling, 'xhigh');
});

test('a custom role falls back to roles.default and the top level', async () => {
    const config = await load({ researcher: { instructions: 'Research.' } });
    const role = resolveRole(config, 'researcher');
    assert.equal(role.model, 'gpt-6.1-sol');       // top-level model
    assert.equal(role.summary, 'auto');            // top-level reasoning.summary
    assert.equal(role.verbosity, 'low');           // top-level verbosity
});

test('a custom role inherits roles.default.model when the top level has none', async () => {
    const config = await load({ default: { model: 'gpt-6-luna' }, researcher: { instructions: 'Research.' } });
    assert.equal(resolveRole(config, 'researcher').model, 'gpt-6-luna');
});

test('a custom role effort obeys the model ceiling', async () => {
    const config = await load({ researcher: { model: 'gpt-6.1-sol', effort: 'max' } });
    assert.equal(resolveRole(config, 'researcher').effort, 'xhigh');
});

test('a custom role ceiling tightens the model ceiling', async () => {
    const config = await load({ researcher: { model: 'gpt-6.1-sol', effort: 'max', maxEffort: 'low' } });
    assert.equal(resolveRole(config, 'researcher').effort, 'low');
});

test('a custom role with no settings still resolves', async () => {
    const config = await load({ observer: {} });
    const role = resolveRole(config, 'observer');
    assert.equal(role.name, 'observer');
    assert.equal(typeof role.model, 'string');
    assert.equal(role.instructions, null);
    assert.equal(role.tools, null);
    assert.equal(role.context, null);
});

test('a role tier supplies model and effort for a complexity', async () => {
    const config = await load({ coder: { tiers: { complex: { model: 'gpt-6-luna', effort: 'medium' } } } });
    const role = resolveRole(config, 'coder', 'complex');
    assert.equal(role.model, 'gpt-6-luna');
    assert.equal(role.effort, 'medium');
});

test('an explicit role setting wins over its tier', async () => {
    const config = await load({ coder: { model: 'gpt-6-luna', effort: 'low' } });
    const role = resolveRole(config, 'coder', 'complex');
    assert.equal(role.model, 'gpt-6-luna');
    assert.equal(role.effort, 'low');
});

test('without a complexity a role ignores its tiers', async () => {
    const config = await load({});
    assert.equal(resolveRole(config, 'coder').model, 'gpt-6.1-sol');
});

test('a tier is validated', async () => {
    await assert.rejects(load({ coder: { tiers: { huge: { model: 'gpt-6-luna' } } } }), /roles\.coder\.tiers\.huge/);
    await assert.rejects(load({ coder: { tiers: { normal: { speed: 3 } } } }), /roles\.coder\.tiers\.normal\.speed/);
    await assert.rejects(load({ coder: { tiers: { normal: { effort: 'extreme' } } } }), /roles\.coder\.tiers\.normal\.effort/);
});

test('roles.<name>.turns is a positive integer', async () => {
    const config = await load({ researcher: { turns: 9 } });
    assert.equal(config.roles.researcher.turns, 9);
    await assert.rejects(load({ researcher: { turns: 0 } }), /roles\.researcher\.turns/);
});

// ── tools ──────────────────────────────────────────────────────────────────

const allNames = [
    'list_files', 'read_file', 'search_files', 'write_file', 'replace_text', 'delete_file',
    'run_command', 'run_script', 'fetch_url', 'view_image', 'summarize_file', 'recall', 'run_subagent',
];

test('a custom role with tools keeps only those names', () => {
    const names = toolNamesForRole(allNames, 'researcher', { tools: ['read_file', 'search_files', 'fetch_url'] });
    assert.deepEqual(names, ['read_file', 'search_files', 'fetch_url']);
});

test('a custom role without tools keeps the whole run set', () => {
    assert.deepEqual(toolNamesForRole(allNames, 'researcher', {}), allNames);
    assert.deepEqual(toolNamesForRole(allNames, 'researcher'), allNames);
});

test('a tools list never adds a name the run did not enable', () => {
    const names = toolNamesForRole(allNames, 'researcher', { tools: ['read_file', 'not_enabled'] });
    assert.deepEqual(names, ['read_file']);
});

test('a built-in role keeps its own restriction when tools is empty', () => {
    const names = toolNamesForRole(allNames, 'orchestrator', { tools: null });
    assert.deepEqual(names, ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall']);
});

// ── defaults ───────────────────────────────────────────────────────────────

test('every built-in role carries the new fields', () => {
    for (const name of BUILTIN_ROLE_NAMES) {
        assert.ok(Object.hasOwn(defaults.roles[name], 'maxEffort'), `${name}.maxEffort`);
        assert.ok(Object.hasOwn(defaults.roles[name], 'context'), `${name}.context`);
        assert.ok(Object.hasOwn(defaults.roles[name], 'tools'), `${name}.tools`);
        assert.ok(Object.hasOwn(defaults.roles[name], 'turns'), `${name}.turns`);
        assert.ok(Object.hasOwn(defaults.roles[name], 'tiers'), `${name}.tiers`);
    }
});
