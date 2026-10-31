import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveRole, roleNames, BUILTIN_ROLE_NAMES, ROLE_NAMES, CUSTOM_ROLE_NAME, defaults } from '../src/core/config.js';
import { toolNamesForRole } from '../src/agent/team.js';

const home = 'test/.home-custom-roles';

/**
 * Load a config with the given role definitions. `extra.roles` is a second layer, like a CLI
 * `--role` override on top of a config file: its fields win, the rest of the role stays.
 * @param {object} roles
 * @param {object} [extra]
 * @returns {Promise<object>}
 */
const load = (roles, extra = {}) => {
    const merged = { ...roles };
    for (const [name, role] of Object.entries(extra.roles ?? {})) merged[name] = { ...merged[name], ...role };
    return loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-sol' },
        overrides: { ...extra, roles: merged },
        ensureHome: false,
    });
};

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
    const config = await load({ researcher: { model: 'gpt-6.1-terra' } });
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
    const config = await load({ researcher: { model: 'gpt-6.1-terra' } });
    assert.equal(config.roles.researcher.model, 'gpt-6.1-terra');
});

test('a malformed custom role name is rejected', async () => {
    await assert.rejects(load({ 'Researcher': { model: 'gpt-6.1-terraa' } }), /roles\.Researcher/);
    await assert.rejects(load({ '2fast': { model: 'gpt-6.1-terra' } }), /roles\.2fast/);
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
            model: 'gpt-6.1-terra', effort: 'high', instructions: 'You research one question.',
            tools: ['read_file', 'search_files'], context: 'small', maxEffort: 'xhigh',
        },
    });
    const role = resolveRole(config, 'researcher');
    assert.equal(role.model, 'gpt-6.1-terra');
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
    const config = await load({ default: { model: 'gpt-6.1-terra' }, researcher: { instructions: 'Research.' } });
    assert.equal(resolveRole(config, 'researcher').model, 'gpt-6.1-terra');
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
    const config = await load({ coder: { tiers: { complex: { model: 'gpt-6.1-terra', effort: 'medium' } } } });
    const role = resolveRole(config, 'coder', 'complex');
    assert.equal(role.model, 'gpt-6.1-terra');
    assert.equal(role.effort, 'medium');
});

test('a ladder tier advances the model and the effort together', async () => {
    const config = await load({
        researcher: {
            tiers: [
                { model: 'gpt-6.1-terra', effort: ['low', 'medium', 'high'] },
                { model: 'gpt-6.1-sol', effort: ['medium', 'high', 'xhigh'] },
            ],
        },
    });
    assert.deepEqual([resolveRole(config, 'researcher', 'trivial').model, resolveRole(config, 'researcher', 'trivial').effort], ['gpt-6.1-terra', 'low']);
    assert.deepEqual([resolveRole(config, 'researcher', 'normal').model, resolveRole(config, 'researcher', 'normal').effort], ['gpt-6.1-sol', 'high']);
    assert.deepEqual([resolveRole(config, 'researcher', 'complex').model, resolveRole(config, 'researcher', 'complex').effort], ['gpt-6.1-sol', 'xhigh']);
});

test('an explicit role setting wins over its tier', async () => {
    const config = await load({ coder: { model: 'gpt-6.1-terra', effort: 'low' } });
    const role = resolveRole(config, 'coder', 'complex');
    assert.equal(role.model, 'gpt-6.1-terra');
    assert.equal(role.effort, 'low');
});

test('without a complexity a role ignores its tiers', async () => {
    const config = await load({});
    assert.equal(resolveRole(config, 'coder').model, 'gpt-6.1-sol');
});

test('a ladder tier from a config file replaces the shipped one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-tier-cfg-'));
    try {
        await writeFile(path.join(dir, 'config.json'), JSON.stringify({
            roles: {
                coder: {
                    tiers: [
                        { model: 'gpt-6.1-terra', effort: ['low', 'medium', 'high'] },
                        { model: 'gpt-6.1-sol', effort: ['medium', 'high', 'xhigh'] },
                    ],
                },
            },
        }));
        const config = await loadConfig({ env: { AI_AGENT_HOME: dir, AI_MODEL: 'gpt-6.1-sol' }, ensureHome: false });
        const trivial = resolveRole(config, 'coder', 'trivial');
        const normal = resolveRole(config, 'coder', 'normal');
        const complex = resolveRole(config, 'coder', 'complex');
        assert.deepEqual([trivial.model, trivial.effort], ['gpt-6.1-terra', 'low']);
        assert.deepEqual([normal.model, normal.effort], ['gpt-6.1-sol', 'high']);
        assert.deepEqual([complex.model, complex.effort], ['gpt-6.1-sol', 'xhigh']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a --role pin wins over a tier', async () => {
    const tiers = [
        { model: 'gpt-6.1-terra', effort: ['low', 'medium', 'high'] },
        { model: 'gpt-6.1-sol', effort: ['medium', 'high', 'xhigh'] },
    ];
    const pinnedModel = await load({ coder: { tiers } }, { roles: { coder: { model: 'gpt-6.1-terra' } } });
    const complex = resolveRole(pinnedModel, 'coder', 'complex');
    assert.deepEqual([complex.model, complex.effort], ['gpt-6.1-terra', 'xhigh']);
    const pinnedBoth = await load({ coder: { tiers } }, { roles: { coder: { model: 'gpt-6.1-terra', effort: 'low' } } });
    const forced = resolveRole(pinnedBoth, 'coder', 'complex');
    assert.deepEqual([forced.model, forced.effort], ['gpt-6.1-terra', 'low']);
});

test('a tier is validated in both shapes', async () => {
    await assert.rejects(load({ coder: { tiers: { huge: { model: 'gpt-6.1-terra' } } } }), /roles\.coder\.tiers\.huge/);
    await assert.rejects(load({ coder: { tiers: { normal: { speed: 3 } } } }), /roles\.coder\.tiers\.normal\.speed/);
    await assert.rejects(load({ coder: { tiers: { normal: { effort: 'extreme' } } } }), /roles\.coder\.tiers\.normal\.effort/);
    await assert.rejects(load({ coder: { tiers: [] } }), /roles\.coder\.tiers/);
    await assert.rejects(load({ coder: { tiers: ['gpt-6.1-terra'] } }), /roles\.coder\.tiers\[0\]/);
    await assert.rejects(load({ coder: { tiers: [{ effort: ['high'] }] } }), /roles\.coder\.tiers\[0\]\.model/);
    await assert.rejects(load({ coder: { tiers: [{ model: 'gpt-6.1-terra', speed: 3 }] } }), /roles\.coder\.tiers\[0\]\.speed/);
    await assert.rejects(load({ coder: { tiers: [{ model: 'gpt-6.1-terra', effort: 'high' }] } }), /roles\.coder\.tiers\[0\]\.effort/);
    await assert.rejects(load({ coder: { tiers: [{ model: 'gpt-6.1-terra', effort: ['extreme'] }] } }), /roles\.coder\.tiers\[0\]\.effort/);
    await assert.rejects(load({ coder: { tiers: 'gpt-6.1-terra' } }), /roles\.coder\.tiers/);
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
    // The architect stays read-only; the merged orchestrator keeps every enabled name (the former writer rights).
    const architect = toolNamesForRole(allNames, 'architect', { tools: null });
    assert.deepEqual(architect, ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall']);
    assert.deepEqual(toolNamesForRole(allNames, 'orchestrator', { tools: null }), allNames);
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
