import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveRole } from '../src/core/config.js';
import { overridesFrom } from '../src/commands/flags.js';
import { applyPins, resolvePace } from '../src/agent/pace.js';
import { buildRequestBody } from '../src/agent/loop.js';

/**
 * A config with only the fields resolveRole and buildRequestBody read.
 * @param {object} [extra]
 * @returns {object}
 */
const cfg = (extra = {}) => ({
    model: 'gpt-6.1-sol',
    reasoning: { effort: 'high', summary: 'auto' },
    verbosity: 'low', maxOutputTokens: null, temperature: null,
    roles: {}, models: null, ...extra,
});

const ladder = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'];
const paceBase = { speed: 10, quality: 40, mode: 'auto', models: ladder };

// ── resolveRole: the model ceiling ─────────────────────────────────────────

test('resolveRole lowers a role effort to the ceiling of its model', () => {
    // gpt-6.1-sol is capped at xhigh, so a role asking for max gets xhigh.
    const role = resolveRole(cfg({ roles: { planner: { model: 'gpt-6.1-sol', effort: 'max' } } }), 'planner');
    assert.equal(role.model, 'gpt-6.1-sol');
    assert.equal(role.effort, 'xhigh');
    assert.equal(role.ceiling, 'xhigh');
    assert.equal(role.config.reasoning.effort, 'xhigh');
});

test('resolveRole keeps an effort at or below the ceiling', () => {
    const role = resolveRole(cfg({ roles: { planner: { model: 'gpt-6.1-sol', effort: 'high' } } }), 'planner');
    assert.equal(role.effort, 'high');
});

test('resolveRole leaves an uncapped model alone', () => {
    const role = resolveRole(cfg({ roles: { planner: { model: 'gpt-6.1-terra', effort: 'max' } } }), 'planner');
    assert.equal(role.effort, 'max');
});

test('resolveRole passes none through any ceiling', () => {
    const role = resolveRole(cfg({ roles: { summarizer: { model: 'gpt-6.1-sol', effort: 'none' } } }), 'summarizer');
    assert.equal(role.effort, 'none');
});

// ── resolveRole: the role ceiling ──────────────────────────────────────────

test('roles.<name>.maxEffort caps a model with no ceiling of its own', () => {
    const role = resolveRole(cfg({ roles: { summarizer: { model: 'gpt-6.1-terra', effort: 'max', maxEffort: 'low' } } }), 'summarizer');
    assert.equal(role.effort, 'low');
    assert.equal(role.ceiling, 'low');
});

test('the stricter of the model ceiling and the role ceiling wins', () => {
    // Model allows xhigh, the role asks for no more than medium.
    const tight = resolveRole(cfg({ roles: { worker: { model: 'gpt-6.1-sol', effort: 'max', maxEffort: 'medium' } } }), 'worker');
    assert.equal(tight.effort, 'medium');
    // Model allows xhigh, the role would allow max, so the model ceiling binds.
    const loose = resolveRole(cfg({ roles: { worker: { model: 'gpt-6.1-sol', effort: 'max', maxEffort: 'max' } } }), 'worker');
    assert.equal(loose.effort, 'xhigh');
});

test('roles.default.maxEffort applies to a role without its own ceiling', () => {
    const role = resolveRole(cfg({ roles: { default: { maxEffort: 'low' }, planner: { model: 'gpt-6.1-terra', effort: 'high' } } }), 'planner');
    assert.equal(role.effort, 'low');
});

// ── resolveRole: the model ladder ──────────────────────────────────────────

test('a configured ladder snaps the effort to the nearest level below', () => {
    const config = cfg({
        models: { 'gpt-6.1-sol': { efforts: ['low', 'medium', 'high'] } },
        roles: { planner: { model: 'gpt-6.1-sol', effort: 'xhigh' } },
    });
    assert.equal(resolveRole(config, 'planner').effort, 'high');
});

test('a configured ceiling from models.<id> overrides the registry', () => {
    const config = cfg({
        models: { 'gpt-6.1-terra': { ceiling: 'medium' } },
        roles: { planner: { model: 'gpt-6.1-terra', effort: 'max' } },
    });
    assert.equal(resolveRole(config, 'planner').effort, 'medium');
});

test('a null ceiling in models.<id> removes the registry limit', () => {
    const config = cfg({
        models: { 'gpt-6.1-sol': { ceiling: null } },
        roles: { planner: { model: 'gpt-6.1-sol', effort: 'max' } },
    });
    assert.equal(resolveRole(config, 'planner').effort, 'max');
});

// ── pace: ceilings on the directive ────────────────────────────────────────

test('resolvePace never hands a role an effort above its model ceiling', () => {
    // summarizer sits on rung 0 with base max; the ladder of the model decides what it gets.
    const pace = resolvePace({ ...paceBase, label: 'normal', modelProfiles: { 'gpt-6-luna': { ceiling: 'medium' } } });
    assert.equal(pace.roles.summarizer.model, 'gpt-6.1-terra');
    assert.equal(pace.roles.summarizer.effort, 'xhigh');
});

test('resolvePace caps an author step to the model it lands on', () => {
    // complex + speed 0 → rung 1 (gpt-6.1-terra); the ceiling only bounds the effort,
    // because authorRung chooses the rung.
    const pace = resolvePace({
        ...paceBase, speed: 0, quality: 100, label: 'normal',
        modelProfiles: { 'gpt-6.1-terra': { ceiling: 'low' } },
        steps: [{ complexity: 'complex', author: 'coder', files: [], goal: 'g', details: '', verify: '' }],
    });
    assert.equal(pace.steps[0].model, 'gpt-6.1-terra');
    assert.equal(pace.steps[0].effort, 'low');
});

test('resolvePace without profiles keeps the registry ceilings', () => {
    const pace = resolvePace({ ...paceBase, speed: 0, quality: 200, label: 'normal' });
    // quality 200 pushes the planner to xhigh; sol serves it, so nothing changes.
    assert.equal(pace.roles.planner.model, 'gpt-6.1-sol');
    assert.equal(pace.roles.planner.effort, 'xhigh');
});

test('applyPins caps a pinned effort, because a ceiling is not a preference', () => {
    const pace = resolvePace({ ...paceBase, label: 'normal' });
    const pinned = applyPins(pace, { planner: { model: 'gpt-6.1-sol', effort: 'max' } }, { planner: { model: true, effort: true } });
    assert.equal(pinned.roles.planner.model, 'gpt-6.1-sol');
    assert.equal(pinned.roles.planner.effort, 'xhigh');
});

test('applyPins honours the role ceiling of the pinned model', () => {
    const pace = resolvePace({ ...paceBase, label: 'normal' });
    const pinned = applyPins(
        pace,
        { planner: { model: 'gpt-6.1-terra', effort: 'max', maxEffort: 'low' } },
        { planner: { model: true, effort: true } },
    );
    assert.equal(pinned.roles.planner.effort, 'low');
});

test('applyPins leaves a pin alone when the model is unknown', () => {
    const pace = resolvePace({ ...paceBase, label: 'normal' });
    const pinned = applyPins(pace, { planner: { model: 'custom-planner', effort: 'max' } }, { planner: { model: true, effort: true } });
    assert.equal(pinned.roles.planner.effort, 'max');
});

// ── buildRequestBody: the last gate ────────────────────────────────────────

test('buildRequestBody caps the effort of a request from any caller', () => {
    const body = buildRequestBody({ config: cfg(), model: 'gpt-6.1-sol', input: [], reasoningEffort: 'max' });
    assert.equal(body.reasoning.effort, 'xhigh');
});

test('buildRequestBody honours a configured ladder', () => {
    const config = cfg({ models: { 'gpt-6.1-terra': { efforts: ['low', 'medium'] } } });
    const body = buildRequestBody({ config, model: 'gpt-6.1-terra', input: [], reasoningEffort: 'high' });
    assert.equal(body.reasoning.effort, 'medium');
});

test('buildRequestBody passes an effort a model can serve', () => {
    const body = buildRequestBody({ config: cfg(), model: 'gpt-6.1-terra', input: [], reasoningEffort: 'max' });
    assert.equal(body.reasoning.effort, 'max');
});

// ── configuration ──────────────────────────────────────────────────────────

test('models section accepts ceilings and ladders', async () => {
    const home = 'test/.home-ceilings';
    const config = await loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-sol' },
        overrides: { models: { 'gpt-6.1-sol': { ceiling: 'medium', efforts: ['low', 'medium'] } } },
        ensureHome: false,
    });
    assert.deepEqual(config.models['gpt-6.1-sol'], { ceiling: 'medium', efforts: ['low', 'medium'] });
    assert.equal(resolveRole(config, 'planner').effort, 'xhigh');
});

test('an unknown ceiling in models is rejected', async () => {
    await assert.rejects(
        loadConfig({
            env: { AI_AGENT_HOME: 'test/.home-ceilings', AI_MODEL: 'gpt-6.1-terra' },
            overrides: { models: { 'gpt-6.1-terra': { ceiling: 'ultra' } } },
            ensureHome: false,
        }),
        /models\.gpt-6.1-terra\.ceiling/,
    );
});

test('an unknown field in models is rejected', async () => {
    await assert.rejects(
        loadConfig({
            env: { AI_AGENT_HOME: 'test/.home-ceilings', AI_MODEL: 'gpt-6.1-terra' },
            overrides: { models: { 'gpt-6.1-terra': { price: 3 } } },
            ensureHome: false,
        }),
        /models\.gpt-6.1-terra\.price: неизвестное поле/,
    );
});

test('roles.<name>.maxEffort is validated', async () => {
    await assert.rejects(
        loadConfig({
            env: { AI_AGENT_HOME: 'test/.home-ceilings', AI_MODEL: 'gpt-6.1-terra' },
            overrides: { roles: { planner: { maxEffort: 'sometimes' } } },
            ensureHome: false,
        }),
        /roles\.planner\.maxEffort/,
    );
});

test('--max-effort caps every role through roles.default', async () => {
    const overrides = overridesFrom({ 'max-effort': 'medium' });
    assert.deepEqual(overrides.roles, { default: { maxEffort: 'medium' } });
    const config = await loadConfig({
        env: { AI_AGENT_HOME: 'test/.home-ceilings', AI_MODEL: 'gpt-6.1-sol' },
        overrides: { roles: { ...overrides.roles, planner: { model: 'gpt-6.1-sol', effort: 'max' } } },
        ensureHome: false,
    });
    assert.equal(resolveRole(config, 'planner').effort, 'medium');
    assert.equal(resolveRole(config, 'planner').ceiling, 'medium');
    assert.equal(resolveRole(config, 'worker').ceiling, 'medium');
});

test('--role parses an effort and a role ceiling', () => {
    assert.deepEqual(overridesFrom({ role: ['worker=gpt-6.1-terra:high:xhigh'] }).roles, {
        worker: { model: 'gpt-6.1-terra', effort: 'high', maxEffort: 'xhigh' },
    });
    assert.deepEqual(overridesFrom({ role: ['worker=gpt-6.1-terra::high'] }).roles, {
        worker: { model: 'gpt-6.1-terra', maxEffort: 'high' },
    });
    assert.throws(() => overridesFrom({ role: ['worker=gpt-6.1-terra:high:ultra'] }), /max-effort/);
    assert.throws(() => overridesFrom({ role: ['worker=gpt-6.1-terra:loud'] }), /effort/);
});

test('resolveRole never asks for more output tokens than the model accepts', () => {
    const role = resolveRole(cfg({ roles: { planner: { model: 'gpt-6.1-sol', maxOutputTokens: 40000 } } }), 'planner');
    assert.equal(role.maxOutput, 32768);
    assert.equal(role.maxOutputTokens, 32768);
    assert.equal(role.config.maxOutputTokens, 32768);
    const small = resolveRole(cfg({ roles: { planner: { model: 'gpt-6-luna-decisions', maxOutputTokens: 1000 } } }), 'planner');
    assert.equal(small.maxOutputTokens, 256);
    assert.equal(small.config.maxOutputTokens, 256);
});

test('buildRequestBody caps max_output_tokens at the profile limit', () => {
    const body = buildRequestBody({ config: cfg({ model: 'gpt-6.1-sol' }), input: [], maxOutputTokens: 40000 });
    assert.equal(body.max_output_tokens, 32768);
    const small = buildRequestBody({ config: cfg({ model: 'gpt-6-luna-decisions' }), input: [], maxOutputTokens: 1000 });
    assert.equal(small.max_output_tokens, 256);
});
