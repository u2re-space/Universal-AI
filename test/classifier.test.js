import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructions } from '../src/roles/classifier.js';
import { instructions as plannerInstructions } from '../src/roles/planner.js';
import { CLASSIFIER_SCHEMA, IMAGE_PROCESSOR_SCHEMA, PLAN_SCHEMA } from '../src/agent/schemas.js';

test('classifier schema is one label and the plan step carries complexity', () => {
    assert.equal(CLASSIFIER_SCHEMA.additionalProperties, false);
    assert.deepEqual(CLASSIFIER_SCHEMA.properties.label.enum, ['trivial', 'normal', 'complex']);
    assert.ok(CLASSIFIER_SCHEMA.required.includes('label'));
    assert.deepEqual(PLAN_SCHEMA.properties.steps.items.properties.complexity.enum, ['trivial', 'normal', 'complex']);
    assert.ok(PLAN_SCHEMA.required.includes('imageTasks'));
    assert.equal(PLAN_SCHEMA.properties.imageTasks.items.additionalProperties, false);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.required, ['summary', 'assets', 'notes']);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.properties.assets.items.required, ['path', 'format', 'use']);
    assert.match(plannerInstructions, /imageTasks/);
    assert.match(plannerInstructions, /Reply in JSON only/);
    assert.match(instructions, /Reply in JSON only/);
});
