import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageLongSide, imageTier } from '../src/roles/reviewer.js';
import { defaults, resolveRole } from '../src/core/config.js';

test('solver effort and model follow the step complexity', () => {
    const trivial = resolveRole(defaults, 'solver', 'trivial');
    assert.equal(trivial.model, 'gpt-6.1-terra');
    assert.equal(trivial.effort, 'high');

    const normal = resolveRole(defaults, 'solver', 'normal');
    assert.equal(normal.model, 'gpt-6.1-terra');
    assert.equal(normal.effort, 'xhigh');

    const complex = resolveRole(defaults, 'solver', 'complex');
    assert.equal(complex.model, 'gpt-6.1-sol');
    assert.equal(complex.effort, 'xhigh');

    const unknown = resolveRole(defaults, 'solver', 'unknown');
    assert.equal(unknown.model, normal.model);
    assert.equal(unknown.effort, normal.effort);
});

test('an explicit solver model and effort replace the tier', () => {
    const config = {
        ...defaults,
        roles: { ...defaults.roles, solver: { ...defaults.roles.solver, model: 'gpt-6.1-terra', effort: 'low' } },
    };
    const role = resolveRole(config, 'solver', 'complex');
    assert.equal(role.model, 'gpt-6.1-terra');
    assert.equal(role.effort, 'low');
});

function png(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

test('reviewer effort and model follow the image long side, and a screenshot stays complex', () => {
    assert.equal(imageLongSide(png(400, 120)), 400);
    assert.equal(imageLongSide(png(1920, 1080)), 1920);
    assert.equal(imageLongSide(Buffer.from('nope')), null);
    assert.equal(imageTier(400), 'trivial');
    assert.equal(imageTier(512), 'trivial');
    assert.equal(imageTier(800), 'normal');
    assert.equal(imageTier(1280), 'normal');
    assert.equal(imageTier(1281), 'complex');
    assert.equal(imageTier(null), 'normal');
    assert.equal(imageTier(80, { screen: true }), 'complex');

    assert.equal(resolveRole(defaults, 'reviewer', imageTier(400)).effort, 'medium');
    assert.equal(resolveRole(defaults, 'reviewer', imageTier(800)).effort, 'high');
    assert.equal(resolveRole(defaults, 'reviewer', imageTier(1281)).model, 'gpt-6.1-terra');
    assert.equal(resolveRole(defaults, 'reviewer', imageTier(80, { screen: true })).model, 'gpt-6.1-terra');
});

test('an explicit reviewer model and effort replace the tier', () => {
    const config = {
        ...defaults,
        roles: { ...defaults.roles, reviewer: { ...defaults.roles.reviewer, model: 'gpt-6.1-terra', effort: 'low' } },
    };
    const role = resolveRole(config, 'reviewer', imageTier(1920));
    assert.equal(role.model, 'gpt-6.1-terra');
    assert.equal(role.effort, 'low');
});
