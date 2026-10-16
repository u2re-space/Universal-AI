import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coderChoice, isCodingStep } from '../src/roles/coder.js';

test('coder effort and model follow the plan complexity', () => {
    assert.deepEqual(coderChoice('trivial'), { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(coderChoice('normal'), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(coderChoice('complex'), { model: 'gpt-6.1-sol', effort: 'high' });
    assert.deepEqual(coderChoice('complex', { model: 'gpt-6-luna', effort: 'low' }), { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(coderChoice('unknown'), coderChoice('normal'));
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
