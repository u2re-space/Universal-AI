import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCodingStep } from '../src/roles/coder.js';
import { defaults, resolveRole } from '../src/core/config.js';

const pinned = (overrides) => ({
    ...defaults,
    roles: { ...defaults.roles, coder: { ...defaults.roles.coder, ...overrides } },
});

test('coder effort and model follow the plan complexity', () => {
    const trivial = resolveRole(defaults, 'coder', 'trivial');
    assert.equal(trivial.model, 'gpt-6.1-terra');
    assert.equal(trivial.effort, 'medium');

    const normal = resolveRole(defaults, 'coder', 'normal');
    assert.equal(normal.model, 'gpt-6.1-sol');
    assert.equal(normal.effort, 'high');

    const complex = resolveRole(defaults, 'coder', 'complex');
    assert.equal(complex.model, 'gpt-6.1-sol');
    assert.equal(complex.effort, 'xhigh');

    const unknown = resolveRole(defaults, 'coder', 'unknown');
    assert.equal(unknown.model, normal.model);
    assert.equal(unknown.effort, normal.effort);
});

test('an explicit coder model and effort replace the tier', () => {
    const role = resolveRole(pinned({ model: 'gpt-6-luna', effort: 'low' }), 'coder', 'complex');
    assert.equal(role.model, 'gpt-6-luna');
    assert.equal(role.effort, 'low');
});

test('code steps use the coder, documents do not', () => {
    assert.equal(isCodingStep(['src/app.tsx']), true);
    assert.equal(isCodingStep([], 'Создать src/sum.js'), true);
    assert.equal(isCodingStep(['README.md']), false);
    assert.equal(isCodingStep(['docs/guide.md']), false);
    assert.equal(isCodingStep(['.rules/stack.md']), false);
    assert.equal(isCodingStep(['vite.config.js']), false);
    assert.equal(isCodingStep(['package.json']), false);
});
