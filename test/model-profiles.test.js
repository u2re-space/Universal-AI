import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EFFORT_ORDER,
    CONTEXT_LEVELS,
    DEFAULT_PROFILE,
    MODEL_PROFILES,
    profileFor,
    effortRank,
    capEffort,
    snapEffort,
    contextBytes,
} from '../src/openai/model-profiles.js';

// ── Constants ──────────────────────────────────────────────────────────────

test('EFFORT_ORDER contains all reasoning levels plus none', () => {
    assert.deepEqual(EFFORT_ORDER, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('CONTEXT_LEVELS maps to positive byte counts', () => {
    assert.ok(CONTEXT_LEVELS.small > 0);
    assert.ok(CONTEXT_LEVELS.normal > 0);
    assert.ok(CONTEXT_LEVELS.large > 0);
    assert.ok(CONTEXT_LEVELS.max > 0);
    assert.ok(CONTEXT_LEVELS.small < CONTEXT_LEVELS.normal);
    assert.ok(CONTEXT_LEVELS.normal < CONTEXT_LEVELS.large);
    assert.ok(CONTEXT_LEVELS.large < CONTEXT_LEVELS.max);
});

test('DEFAULT_PROFILE has reasonable defaults', () => {
    assert.ok(DEFAULT_PROFILE.window > 0);
    assert.ok(DEFAULT_PROFILE.maxOutput > 0);
    assert.equal(DEFAULT_PROFILE.ceiling, null);
    assert.equal(DEFAULT_PROFILE.efforts, null);
});

test('MODEL_PROFILES contains known models', () => {
    assert.ok('gpt-6.1-sol' in MODEL_PROFILES);
    assert.ok('gpt-6-luna' in MODEL_PROFILES);
    assert.ok('gpt-6-astra' in MODEL_PROFILES);
    assert.ok('gpt-6-luna-decisions' in MODEL_PROFILES);
    for (const id of Object.keys(MODEL_PROFILES)) {
        const p = MODEL_PROFILES[id];
        assert.ok(typeof p.window === 'number' && p.window > 0, `${id}.window`);
        assert.ok(typeof p.maxOutput === 'number' && p.maxOutput > 0, `${id}.maxOutput`);
        assert.ok(p.ceiling === null || typeof p.ceiling === 'string', `${id}.ceiling`);
        assert.ok(p.efforts === null || Array.isArray(p.efforts), `${id}.efforts`);
    }
});

// ── effortRank ──────────────────────────────────────────────────────────────

test('effortRank returns correct index', () => {
    assert.equal(effortRank('none'), 0);
    assert.equal(effortRank('minimal'), 1);
    assert.equal(effortRank('low'), 2);
    assert.equal(effortRank('medium'), 3);
    assert.equal(effortRank('high'), 4);
    assert.equal(effortRank('xhigh'), 5);
    assert.equal(effortRank('max'), 6);
    assert.equal(effortRank(null), -1);
    assert.equal(effortRank('unknown'), -1);
});

// ── profileFor ──────────────────────────────────────────────────────────────

test('profileFor resolves a known model from the registry', () => {
    const p = profileFor('gpt-6.1-sol');
    assert.equal(p.window, 256 * 1024);
    assert.equal(p.maxOutput, 32768);
    assert.equal(p.ceiling, 'xhigh');
    assert.equal(p.efforts, null);
});

test('profileFor resolves a qualified model id', () => {
    const p = profileFor('openai/gpt-6.1-sol');
    assert.equal(p.window, 256 * 1024);
    assert.equal(p.ceiling, 'xhigh');
});

test('profileFor returns DEFAULT_PROFILE for unknown models', () => {
    const p = profileFor('openai/unknown-model');
    assert.equal(p.window, DEFAULT_PROFILE.window);
    assert.equal(p.maxOutput, DEFAULT_PROFILE.maxOutput);
    assert.equal(p.ceiling, null);
    assert.equal(p.efforts, null);
});

test('profileFor merges user overrides from config.models', () => {
    const overrides = { 'gpt-6.1-sol': { ceiling: 'high', maxOutput: 8192 } };
    const p = profileFor('gpt-6.1-sol', overrides);
    assert.equal(p.window, 256 * 1024);
    assert.equal(p.maxOutput, 8192);
    assert.equal(p.ceiling, 'high');
    assert.equal(p.efforts, null);
});

test('profileFor merges effort ladder overrides', () => {
    const overrides = { 'gpt-6-luna': { efforts: ['high', 'xhigh', 'max'] } };
    const p = profileFor('gpt-6-luna', overrides);
    assert.deepEqual(p.efforts, ['high', 'xhigh', 'max']);
});

test('profileFor ignores invalid fields', () => {
    const overrides = { 'gpt-6.1-sol': { ceiling: 'invalid', bogus: 123 } };
    const p = profileFor('gpt-6.1-sol', overrides);
    assert.equal(p.ceiling, 'xhigh');
    assert.equal(p.bogus, undefined);
});

// ── capEffort ───────────────────────────────────────────────────────────────

test('capEffort passes through when ceiling is null', () => {
    assert.equal(capEffort('max', { ceiling: null }), 'max');
    assert.equal(capEffort('xhigh', { ceiling: null }), 'xhigh');
});

test('capEffort passes through when effort is below or equal ceiling', () => {
    assert.equal(capEffort('high', { ceiling: 'xhigh' }), 'high');
    assert.equal(capEffort('xhigh', { ceiling: 'xhigh' }), 'xhigh');
    assert.equal(capEffort('low', { ceiling: 'max' }), 'low');
});

test('capEffort lowers effort above ceiling', () => {
    assert.equal(capEffort('max', { ceiling: 'xhigh' }), 'xhigh');
    assert.equal(capEffort('xhigh', { ceiling: 'high' }), 'high');
    assert.equal(capEffort('xhigh', { ceiling: 'low' }), 'low');
});

test('capEffort handles null and unknown effort', () => {
    assert.equal(capEffort(null, { ceiling: 'high' }), null);
    assert.equal(capEffort('unknown', { ceiling: 'high' }), 'unknown');
});

test('capEffort preserves none', () => {
    assert.equal(capEffort('none', { ceiling: 'xhigh' }), 'none');
});

// ── snapEffort ──────────────────────────────────────────────────────────────

test('snapEffort with no ladder delegates to capEffort', () => {
    assert.equal(snapEffort('max', { ceiling: 'xhigh' }), 'xhigh');
});

test('snapEffort snaps down to the nearest allowed level', () => {
    const profile = { ceiling: null, efforts: ['low', 'medium', 'high'] };
    assert.equal(snapEffort('max', profile), 'high');
    assert.equal(snapEffort('xhigh', profile), 'high');
    assert.equal(snapEffort('medium', profile), 'medium');
    assert.equal(snapEffort('low', profile), 'low');
});

test('snapEffort snaps up when request is below the whole ladder', () => {
    const profile = { ceiling: null, efforts: ['high', 'xhigh', 'max'] };
    assert.equal(snapEffort('none', profile), 'high');
    assert.equal(snapEffort('low', profile), 'high');
    assert.equal(snapEffort('high', profile), 'high');
});

test('snapEffort applies ceiling after snapping', () => {
    const profile = { ceiling: 'xhigh', efforts: ['high', 'xhigh', 'max'] };
    assert.equal(snapEffort('max', profile), 'xhigh');
    assert.equal(snapEffort('xhigh', profile), 'xhigh');
    assert.equal(snapEffort('high', profile), 'high');
});

// ── contextBytes ────────────────────────────────────────────────────────────

test('contextBytes passes through a number', () => {
    assert.equal(contextBytes(1024, {}), 1024);
    assert.equal(contextBytes(100 * 1024, {}), 100 * 1024);
});

test('contextBytes resolves word levels', () => {
    const profile = { window: 200 * 1024 };
    assert.equal(contextBytes('small', profile), 16 * 1024);
    assert.equal(contextBytes('normal', profile), 96 * 1024);
    assert.equal(contextBytes('large', profile), 512 * 1024);
    assert.equal(contextBytes('max', profile), 8 * 1024 * 1024);
    assert.equal(contextBytes('auto', profile), 200 * 1024);
});

test('contextBytes falls back for unknown names', () => {
    assert.equal(contextBytes('unknown', {}), 96 * 1024);
    assert.equal(contextBytes(null, {}), 96 * 1024);
});

test('contextBytes uses DEFAULT_PROFILE window for auto', () => {
    assert.equal(contextBytes('auto', {}), DEFAULT_PROFILE.window);
});
