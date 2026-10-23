import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writerChoice, isWritingStep } from '../src/roles/writer.js';

test('writer stays on the cheaper model and raises effort with complexity', () => {
    assert.deepEqual(writerChoice('trivial'), { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(writerChoice('normal'), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(writerChoice('complex'), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(writerChoice('complex', { effort: 'low' }), { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(writerChoice('unknown'), writerChoice('normal'));
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
