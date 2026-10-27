import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWritingStep } from '../src/roles/writer.js';
import { defaults, resolveRole } from '../src/core/config.js';

const pinned = (overrides) => ({
    ...defaults,
    roles: { ...defaults.roles, writer: { ...defaults.roles.writer, ...overrides } },
});

test('writer stays on the cheaper model and raises effort with complexity', () => {
    const trivial = resolveRole(defaults, 'writer', 'trivial');
    assert.equal(trivial.model, 'gpt-6.1-terra');
    assert.equal(trivial.effort, 'medium');

    const normal = resolveRole(defaults, 'writer', 'normal');
    assert.equal(normal.model, 'gpt-6.1-terra');
    assert.equal(normal.effort, 'high');

    const complex = resolveRole(defaults, 'writer', 'complex');
    assert.equal(complex.model, 'gpt-6.1-terra');
    assert.equal(complex.effort, 'xhigh');

    const unknown = resolveRole(defaults, 'writer', 'unknown');
    assert.equal(unknown.model, normal.model);
    assert.equal(unknown.effort, normal.effort);
});

test('an explicit writer effort replaces the tier', () => {
    const role = resolveRole(pinned({ effort: 'low' }), 'writer', 'complex');
    assert.equal(role.model, 'gpt-6.1-terra');
    assert.equal(role.effort, 'low');
});

test('documents and reports use the writer, code and rules do not', () => {
    assert.equal(isWritingStep(['README.md']), true);
    assert.equal(isWritingStep(['docs/guide.md']), true);
    assert.equal(isWritingStep(['notes.txt']), true);
    assert.equal(isWritingStep([], 'Напиши отчёт'), true);
    assert.equal(isWritingStep([], 'Write the documentation'), true);
    assert.equal(isWritingStep(['.rules/stack.md']), false);
    assert.equal(isWritingStep(['.skills/scaffold/SKILL.md']), false);
    assert.equal(isWritingStep(['src/app.tsx']), false);
});
