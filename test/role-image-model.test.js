import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { loadConfig, roleToolConfig, resolveRole, defaults } from '../src/core/config.js';
import { createToolset } from '../src/agent/tools.js';

const RIVERFLOW = 'sourceful/riverflow-v2.6-pro';
const GPT_MODEL = 'openai/gpt-image-2.6-sunburst';

/**
 * A config with the picture models a role may name, and the run default next to them.
 * @param {object} roles
 * @param {object} [extra]
 * @returns {object}
 */
const configWith = (roles, extra = {}) => ({
    baseURL: 'https://api.example/v1/',
    imageModel: GPT_MODEL,
    image: { size: 'auto', format: 'png', background: 'auto', alphaMode: 'off', vectorModel: 'vendor/top-vector' },
    limits: {},
    reasoning: { effort: 'medium', summary: 'auto', mode: 'off' },
    roles,
    ...extra,
});

// ── the resolver itself ────────────────────────────────────────────────────

test('every role accepts imageModel and vectorModel as its own fields', () => {
    for (const role of Object.values(defaults.roles)) {
        assert.ok('imageModel' in role, 'roles.<name>.imageModel must be a known field');
        assert.ok('vectorModel' in role, 'roles.<name>.vectorModel must be a known field');
        assert.equal(role.imageModel, null, 'a role inherits the run image model by default');
    }
});

test('roleToolConfig swaps only the models the role names', () => {
    const config = configWith({ decomposer: { imageModel: RIVERFLOW } });
    const tools = roleToolConfig(config, 'decomposer');
    assert.equal(tools.imageModel, RIVERFLOW, 'the decomposer draws with the model of its own role');
    assert.equal(tools.image.vectorModel, 'vendor/top-vector', 'a field the role does not name stays the run default');
    assert.equal(config.imageModel, GPT_MODEL, 'the run config itself must not be rewritten');
    assert.notEqual(tools.image, config.image, 'a copy of image keeps the shared object intact');
});

test('a role that names no picture model gets the very config object back', () => {
    const config = configWith({ coder: { model: 'gpt-6.1-terra' } });
    assert.equal(roleToolConfig(config, 'coder'), config, 'no override, no copy: shared budgets stay shared');
    assert.equal(roleToolConfig(config, null), config);
    assert.equal(roleToolConfig(config, 'unknown-role'), config);
});

test('roles.default is the parent: a role wins over it, and it wins over the top level', () => {
    const config = configWith({
        default: { imageModel: 'vendor/family-model', vectorModel: 'vendor/family-vector' },
        'image-processor': { imageModel: GPT_MODEL },
        decorator: {},
    });
    assert.equal(roleToolConfig(config, 'decorator').imageModel, 'vendor/family-model', 'decorator inherits roles.default');
    assert.equal(roleToolConfig(config, 'decorator').image.vectorModel, 'vendor/family-vector');
    assert.equal(roleToolConfig(config, 'image-processor').imageModel, GPT_MODEL, 'the role itself beats roles.default');
    assert.equal(roleToolConfig(config, 'image-processor').image.vectorModel, 'vendor/family-vector');
});

test('resolveRole carries the picture models of the role too', () => {
    const config = configWith({ decomposer: { imageModel: RIVERFLOW, vectorModel: 'vendor/own-vector' } });
    const role = resolveRole(config, 'decomposer');
    assert.equal(role.model, config.model, 'the brain of the role is untouched by its image model');
    assert.equal(role.config.imageModel, RIVERFLOW);
    assert.equal(role.config.image.vectorModel, 'vendor/own-vector');
});

// ── configuration ──────────────────────────────────────────────────────────

test('a role image model loads from the config and an empty one is rejected', async () => {
    const home = path.join(os.tmpdir(), 'ai-home-role-image');
    try {
        const config = await loadConfig({
            env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
            overrides: { roles: { decomposer: { imageModel: RIVERFLOW }, decorator: { vectorModel: 'recraft/recraft-v4.1-pro-vector' } } },
            ensureHome: true,
        });
        assert.equal(config.roles.decomposer.imageModel, RIVERFLOW);
        assert.equal(config.roles.decorator.vectorModel, 'recraft/recraft-v4.1-pro-vector');
        await assert.rejects(
            () => loadConfig({
                env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
                overrides: { roles: { 'image-processor': { imageModel: '   ' } } },
                ensureHome: false,
            }),
            /roles\.image-processor\.imageModel/,
        );
        await assert.rejects(
            () => loadConfig({
                env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
                overrides: { roles: { 'image-processor': { imageModell: 'vendor/typo' } } },
                ensureHome: false,
            }),
            /неизвестное поле/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

// ── the tools really follow the role ───────────────────────────────────────

/** A client that records every request and answers with one flat picture. */
async function recordingClient() {
    const canvas = createCanvas(4, 4);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#b02020';
    ctx.fillRect(0, 0, 4, 4);
    const png = canvas.toBuffer('image/png').toString('base64');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>').toString('base64');
    const seen = [];
    return {
        seen,
        images: {
            async generate(request) { seen.push({ route: 'generate', ...request }); return [png]; },
            async edit(request) { seen.push({ route: 'edit', ...request }); return [png]; },
            async vectorize(request) { seen.push({ route: 'vectorize', ...request }); return [svg]; },
        },
    };
}

test('generate_image of a role is charged to that role image model', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-role-tools-'));
    try {
        const client = await recordingClient();
        const config = configWith({ decomposer: { imageModel: RIVERFLOW } });
        const toolset = createToolset({
            root: dir, client, config, role: 'decomposer',
            names: ['generate_image', 'vectorize_image'], approvalLevel: 'all',
        });
        const made = await toolset.execute({
            name: 'generate_image',
            arguments: JSON.stringify({ prompt: 'flat mark', path: 'assets/mark.png' }),
        });
        assert.equal(made.ok, true, made.output);
        assert.equal(client.seen[0].model, RIVERFLOW, 'the role must draw with its own generator');

        // The same toolset of another role keeps the run default: the override belongs to the role, not the client.
        const other = createToolset({
            root: dir, client, config, role: 'image-processor',
            names: ['generate_image', 'vectorize_image'], approvalLevel: 'all',
        });
        await other.execute({
            name: 'generate_image',
            arguments: JSON.stringify({ prompt: 'flat mark', path: 'assets/other.png' }),
        });
        assert.equal(client.seen[1].model, GPT_MODEL, 'a role without an image model uses the run model');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('vectorize_image of a role is charged to that role vector model', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-role-vector-'));
    try {
        const canvas = createCanvas(4, 4);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#b02020';
        ctx.fillRect(0, 0, 4, 4);
        await writeFile(path.join(dir, 'mark.png'), canvas.toBuffer('image/png'));

        const client = await recordingClient();
        const config = configWith({ decorator: { vectorModel: 'vendor/role-vector' } }, { limits: { maxImageBytes: 1024 * 1024 } });
        const toolset = createToolset({
            root: dir, client, config, role: 'decorator',
            names: ['vectorize_image'], approvalLevel: 'all',
        });
        const made = await toolset.execute({
            name: 'vectorize_image',
            arguments: JSON.stringify({ image: 'mark.png', prompt: 'keep the flat red square', remove_background: false }),
        });
        assert.equal(made.ok, true, made.output);
        assert.equal(client.seen[0].model, 'vendor/role-vector', 'the vector model of the role must win');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
