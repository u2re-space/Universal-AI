/**
 * @file test/role-tiers.test.js
 * @purpose Role tiers in both shapes: the model ladder with effort levels, and one entry per tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_LEVELS, normalizeTiers, tierChoice } from '../src/core/role-tiers.js';
import { defaults, resolveRole } from '../src/core/config.js';

const CODER_LADDER = [
    { model: 'gpt-6-luna', effort: ['high', 'xhigh', 'max'] },
    { model: 'gpt-6.1-sol', effort: ['medium', 'high', 'xhigh'] },
];

test('the ladder form advances the model and the effort with the work size', () => {
    assert.deepEqual(TIER_LEVELS, ['trivial', 'normal', 'complex']);
    assert.deepEqual(tierChoice(CODER_LADDER, 'trivial'), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(tierChoice(CODER_LADDER, 'normal'), { model: 'gpt-6.1-sol', effort: 'high' });
    assert.deepEqual(tierChoice(CODER_LADDER, 'complex'), { model: 'gpt-6.1-sol', effort: 'xhigh' });
});

test('a single rung keeps the model and climbs its own effort ladder', () => {
    const ladder = [{ model: 'gpt-6-luna', effort: ['medium', 'high', 'xhigh'] }];
    assert.deepEqual(tierChoice(ladder, 'trivial'), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(tierChoice(ladder, 'normal'), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(tierChoice(ladder, 'complex'), { model: 'gpt-6-luna', effort: 'xhigh' });
});

test('a short ladder clamps to its top', () => {
    const ladder = [{ model: 'gpt-6-luna', effort: ['low'] }, { model: 'gpt-6.1-sol' }];
    assert.deepEqual(tierChoice(ladder, 'trivial'), { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(tierChoice(ladder, 'normal'), { model: 'gpt-6.1-sol', effort: null });
    assert.deepEqual(tierChoice(ladder, 'complex'), { model: 'gpt-6.1-sol', effort: null });
});

test('the explicit form names every tier on its own', () => {
    const tiers = {
        trivial: { model: 'gpt-6-luna', effort: 'medium' },
        normal: { model: 'gpt-6-luna', effort: 'high' },
        complex: { model: 'gpt-6.1-sol', effort: 'high' },
    };
    assert.deepEqual(tierChoice(tiers, 'trivial'), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(tierChoice(tiers, 'normal'), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(tierChoice(tiers, 'complex'), { model: 'gpt-6.1-sol', effort: 'high' });
});

test('an unknown size counts as normal, and no size means no tier', () => {
    assert.deepEqual(tierChoice(CODER_LADDER, 'huge'), tierChoice(CODER_LADDER, 'normal'));
    assert.equal(tierChoice(CODER_LADDER, null), null);
    assert.equal(tierChoice(CODER_LADDER, undefined), null);
});

test('an empty or malformed tier list yields no tier', () => {
    assert.equal(normalizeTiers([]), null);
    assert.equal(normalizeTiers([{ effort: ['high'] }]), null);
    assert.equal(normalizeTiers(null), null);
    assert.equal(normalizeTiers('gpt-6-luna'), null);
    assert.equal(tierChoice({}, 'normal'), null);
});

test('the shipped coder tiers keep the old values in the ladder form', () => {
    const trivial = resolveRole(defaults, 'coder', 'trivial');
    const normal = resolveRole(defaults, 'coder', 'normal');
    const complex = resolveRole(defaults, 'coder', 'complex');
    assert.deepEqual([trivial.model, trivial.effort], ['gpt-6-luna', 'medium']);
    assert.deepEqual([normal.model, normal.effort], ['gpt-6.1-sol', 'high']);
    assert.deepEqual([complex.model, complex.effort], ['gpt-6.1-sol', 'xhigh']);
});

test('the shipped writer tiers stay on one model', () => {
    assert.equal(resolveRole(defaults, 'writer', 'trivial').effort, 'medium');
    assert.equal(resolveRole(defaults, 'writer', 'normal').effort, 'high');
    assert.equal(resolveRole(defaults, 'writer', 'complex').effort, 'xhigh');
    assert.equal(resolveRole(defaults, 'writer', 'complex').model, 'gpt-6-luna');
});

test('the shipped measurer tiers keep the cheap model for normal work', () => {
    const trivial = resolveRole(defaults, 'measurer', 'trivial');
    const normal = resolveRole(defaults, 'measurer', 'normal');
    const complex = resolveRole(defaults, 'measurer', 'complex');
    assert.deepEqual([trivial.model, trivial.effort], ['gpt-6-luna', 'medium']);
    assert.deepEqual([normal.model, normal.effort], ['gpt-6.1-sol', 'high']);
    assert.deepEqual([complex.model, complex.effort], ['gpt-6.1-sol', 'xhigh']);
});

test('the shipped decorator tiers keep the cheap model until the ornament is complex', () => {
    const trivial = resolveRole(defaults, 'decorator', 'trivial');
    const normal = resolveRole(defaults, 'decorator', 'normal');
    const complex = resolveRole(defaults, 'decorator', 'complex');
    assert.deepEqual([trivial.model, trivial.effort], ['gpt-6-luna', 'high']);
    assert.deepEqual([normal.model, normal.effort], ['gpt-6.1-sol', 'xhigh']);
    assert.deepEqual([complex.model, complex.effort], ['gpt-6.1-sol', 'xhigh']);
});
