import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_MODULES, ROLE_INSTRUCTIONS, SPECIALISTS } from '../src/roles/index.js';
import { defaults } from '../src/core/config.js';

const NAMES = ['default', 'planner', 'orchestrator', 'worker', 'coder', 'writer', 'reviewer', 'vision', 'summarizer', 'solver', 'clicker', 'typer', 'encoder', 'tester', 'classifier', 'extractor', 'measurer', 'image-processor'];

test('role modules match config role names', () => {
    assert.deepEqual(Object.keys(ROLE_MODULES).sort(), NAMES.slice().sort());
    assert.deepEqual(Object.keys(defaults.roles).sort(), NAMES.slice().sort());
    for (const name of NAMES) {
        assert.equal(typeof ROLE_MODULES[name].instructions, 'string');
        assert.ok(ROLE_MODULES[name].instructions.trim().length > 40);
    }
});

test('existing role instructions keep their job', () => {
    assert.match(ROLE_INSTRUCTIONS.planner, /senior planner/);
    assert.match(ROLE_INSTRUCTIONS.planner, /\{maxSteps\}/);
    assert.match(ROLE_INSTRUCTIONS.orchestrator, /orchestrator of a team/);
    assert.match(ROLE_INSTRUCTIONS.orchestrator, /Collect context/);
    assert.match(ROLE_INSTRUCTIONS.orchestrator, /Coordinate after a stage/);
    assert.match(ROLE_INSTRUCTIONS.orchestrator, /planUpdate/);
    assert.match(ROLE_INSTRUCTIONS.worker, /ONE step/);
    assert.match(ROLE_INSTRUCTIONS.coder, /generate code/);
    assert.match(ROLE_INSTRUCTIONS.writer, /documents, documentation, reports, and Markdown/);
    assert.match(ROLE_INSTRUCTIONS.worker, /delegate_role/);
    assert.match(ROLE_INSTRUCTIONS.reviewer, /independent reviewer/);
    assert.match(ROLE_INSTRUCTIONS.reviewer, /delegate_role/);
    assert.match(ROLE_INSTRUCTIONS.vision, /Plain text\./);
    assert.match(ROLE_INSTRUCTIONS.summarizerMemory, /long-term memory/);
    assert.match(ROLE_INSTRUCTIONS.summarizerFile, /Do not propose changes\./);
    assert.match(ROLE_INSTRUCTIONS.visionScreen, /elements/);
    assert.match(ROLE_INSTRUCTIONS.extractor, /extractor/);
    assert.match(ROLE_INSTRUCTIONS.extractor, /removeLines/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /before implementation begins/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /Do not edit application code/);
});

test('specialists do not delegate or run batches', () => {
    assert.deepEqual(Object.keys(SPECIALISTS).sort(), ['clicker', 'encoder', 'measurer', 'solver', 'tester', 'typer']);
    assert.deepEqual(SPECIALISTS.solver, { tools: ['screenshot', 'view_image'], turns: 6, schema: null });
    assert.deepEqual(SPECIALISTS.clicker, { tools: ['click', 'screenshot'], turns: 4, schema: null });
    assert.deepEqual(SPECIALISTS.typer, { tools: ['type', 'screenshot'], turns: 4, schema: null });
    assert.deepEqual(SPECIALISTS.encoder, { tools: ['screenshot'], turns: 3, schema: 'batch' });
    assert.deepEqual(SPECIALISTS.tester, { tools: ['screenshot'], turns: 4, schema: null });
    assert.deepEqual(SPECIALISTS.measurer, { tools: ['view_image', 'crop_image', 'split_image'], turns: 12, schema: 'measure' });
    for (const spec of Object.values(SPECIALISTS)) {
        assert.equal(spec.tools.includes('delegate_role'), false);
        assert.equal(spec.tools.includes('run_batch'), false);
    }
});
