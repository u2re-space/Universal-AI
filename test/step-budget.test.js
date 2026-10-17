import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_MAX_STEPS, planLimit, stepAllowance } from '../src/agent/step-budget.js';
import { pathsIn } from '../src/agent/work-plan.js';

test('generation keeps a short plan and one pass on the interface', () => {
    assert.equal(GENERATION_MAX_STEPS, 4);
    assert.equal(planLimit({ maxSteps: 12, generation: true }), 4);
    assert.equal(planLimit({ maxSteps: 3, generation: true }), 3);
    assert.equal(planLimit({ maxSteps: 12, generation: false }), 12);
    const page = stepAllowance({ generation: true, files: ['src/app.tsx', 'src/app.scss'] });
    assert.equal(page.passes, 1);
    assert.equal(page.maxTurns, 20);
    const config = stepAllowance({ generation: true, files: ['vite.config.js'] });
    assert.equal(config.maxTurns, 10);
    assert.equal(stepAllowance({ generation: true, files: pathsIn('Primary file: src/app.tsx.') }).maxTurns, 20);
    assert.equal(stepAllowance({ generation: true }).maxTurns, 20);
    assert.equal(stepAllowance({ generation: true, goal: 'Recreate the reference styling and generate all required artwork.', details: 'layout' }).maxTurns, 25);
});

test('a normal source file gets a short surface pass and a longer body pass', () => {
    const source = stepAllowance({ files: ['src/main.js'] });
    assert.equal(source.passes, 2);
    assert.equal(source.surfaceTurns, 4);
    assert.equal(source.bodyTurns, 16);
    const rule = stepAllowance({ files: ['.rules/stack.md'] });
    assert.deepEqual(rule, { passes: 1, maxTurns: 4 });
    const small = stepAllowance({ complexity: 'trivial', files: ['note.txt'] });
    assert.deepEqual(small, { passes: 1, maxTurns: 8 });
    const capped = stepAllowance({ files: ['src/main.js'], ceiling: 6 });
    assert.equal(capped.surfaceTurns, 4);
    assert.equal(capped.bodyTurns, 6);
});
