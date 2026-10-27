import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_INSTRUCTIONS } from '../src/roles/index.js';
import { EXECUTORS } from '../src/agent/role-registry.js';
import { defaults } from '../src/core/config.js';

const NAMES = ['default', 'planner', 'architect', 'orchestrator', 'worker', 'coder', 'writer', 'reviewer', 'vision', 'summarizer', 'solver', 'clicker', 'typer', 'encoder', 'tester', 'classifier', 'extractor', 'measurer', 'decorator', 'image-processor'];

test('role modules match config role names', () => {
    assert.deepEqual(Object.keys(defaults.roles).sort(), NAMES.slice().sort());
    for (const name of NAMES) {
        assert.equal(typeof ROLE_INSTRUCTIONS[name], 'string');
        assert.ok(ROLE_INSTRUCTIONS[name].trim().length > 40);
    }
});

test('existing role instructions keep their job', () => {
    assert.match(ROLE_INSTRUCTIONS.planner, /senior planner/);
    assert.match(ROLE_INSTRUCTIONS.planner, /\{maxSteps\}/);
    assert.match(ROLE_INSTRUCTIONS.architect, /architect and designer/);
    assert.match(ROLE_INSTRUCTIONS.architect, /stepGuidance/);
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

test('the decorator builds CSS or SVG before the page markup', () => {
    assert.match(ROLE_INSTRUCTIONS.decorator, /before the first HTML page/);
    assert.match(ROLE_INSTRUCTIONS.decorator, /offset-path/);
    assert.match(ROLE_INSTRUCTIONS.decorator, /clip-path/);
    assert.match(ROLE_INSTRUCTIONS.decorator, /separate SVG file/);
    assert.match(ROLE_INSTRUCTIONS.decorator, /Do not edit application HTML/);
    assert.match(ROLE_INSTRUCTIONS.decorator, /styles\/decor\//);
    assert.match(ROLE_INSTRUCTIONS.decorator, /assets\/decor\//);
});

test('the image processor trims padding through crop_image', () => {
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /Trimming padding is a crop_image call/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /trim=true/);
});

test('font selection instructions distinguish research, pairing, measured appearance, and downloading', () => {
    assert.match(ROLE_INSTRUCTIONS.planner, /font-research task/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /language coverage/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /verified CSS2 stylesheet URL/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /only when local font files are explicitly required/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /candidates could not be verified/);
    assert.match(ROLE_INSTRUCTIONS.measurer, /source-pixel font size/);
    assert.match(ROLE_INSTRUCTIONS.measurer, /family confidence/);
    assert.match(ROLE_INSTRUCTIONS.measurer, /separate from visual measurements/);
});

test('desktop helpers keep their tool slices and never delegate', () => {
    assert.equal(EXECUTORS.solver.tools, 'screen');
    assert.deepEqual(EXECUTORS.clicker.tools, ['click', 'screenshot']);
    assert.deepEqual(EXECUTORS.typer.tools, ['type', 'screenshot']);
    assert.deepEqual(EXECUTORS.encoder.tools, ['screenshot']);
    assert.equal(EXECUTORS.tester.tools, 'check');
    assert.deepEqual(EXECUTORS.measurer.tools, ['view_image', 'crop_image', 'split_image', 'fetch_url']);
    for (const name of ['solver', 'clicker', 'typer', 'encoder', 'tester', 'measurer']) {
        const tools = EXECUTORS[name].tools;
        assert.equal(Array.isArray(tools) ? tools.includes('delegate_role') : false, false, name);
        assert.equal(Array.isArray(tools) ? tools.includes('run_batch') : false, false, name);
    }
});
