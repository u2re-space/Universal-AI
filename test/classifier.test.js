import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructions } from '../src/roles/classifier.js';
import { CLASSIFIER_SCHEMA, PLAN_SCHEMA } from '../src/agent/schemas.js';

test('classifier schema is one label and the plan step carries complexity', () => {
    assert.equal(CLASSIFIER_SCHEMA.additionalProperties, false);
    assert.deepEqual(CLASSIFIER_SCHEMA.properties.label.enum, ['trivial', 'normal', 'complex']);
    assert.ok(CLASSIFIER_SCHEMA.required.includes('label'));
    assert.deepEqual(PLAN_SCHEMA.properties.steps.items.properties.complexity.enum, ['trivial', 'normal', 'complex']);
    assert.match(instructions, /Reply in JSON only/);
});
