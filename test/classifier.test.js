import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructions } from '../src/roles/classifier.js';
import { instructions as plannerInstructions } from '../src/roles/planner.js';
import { ARCHITECT_SCHEMA, CLASSIFIER_SCHEMA, IMAGE_PROCESSOR_SCHEMA, MEASURER_SCHEMA, PLAN_SCHEMA } from '../src/agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../src/roles/index.js';
import { renderArchitecture, renderMeasurements } from '../src/agent/team-text.js';
import { defaults } from '../src/core/config.js';

test('classifier schema is one label and the plan step carries complexity', () => {
    assert.equal(CLASSIFIER_SCHEMA.additionalProperties, false);
    assert.deepEqual(CLASSIFIER_SCHEMA.properties.label.enum, ['trivial', 'normal', 'complex']);
    assert.ok(CLASSIFIER_SCHEMA.required.includes('label'));
    assert.deepEqual(PLAN_SCHEMA.properties.steps.items.properties.complexity.enum, ['trivial', 'normal', 'complex']);
    assert.ok(PLAN_SCHEMA.required.includes('imageTasks'));
    assert.equal(PLAN_SCHEMA.properties.imageTasks.items.additionalProperties, false);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.required, ['summary', 'assets', 'typography', 'notes']);
    assert.equal(defaults.documentation.sources.googleFonts, 'https://fonts.google.com/');
    assert.equal(defaults.documentation.roles.planner.includes('googleFonts'), true);
    assert.equal(defaults.documentation.roles.measurer.includes('cssFonts') && defaults.documentation.roles.measurer.includes('googleFonts'), true);
    assert.equal(defaults.documentation.roles['image-processor'].includes('googleFonts'), true);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.properties.assets.items.required, ['path', 'format', 'use']);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.properties.typography.items.required, ['family', 'role', 'cssFamily', 'cssUrl', 'weights', 'rationale', 'source', 'localPath']);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.properties.typography.items.properties.role.enum, ['heading', 'body', 'display', 'monospace', 'accent']);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.properties.typography.items.properties.cssUrl.type, ['string', 'null']);
    assert.deepEqual(IMAGE_PROCESSOR_SCHEMA.properties.typography.items.properties.localPath.type, ['string', 'null']);
    assert.match(plannerInstructions, /font-research task/);
    assert.match(ROLE_INSTRUCTIONS['image-processor'], /web_search to compare Google Fonts/);
    assert.match(ROLE_INSTRUCTIONS.measurer, /family confidence/);
    assert.match(ROLE_INSTRUCTIONS.measurer, /never report a likely family as certain/);
    assert.match(plannerInstructions, /imageTasks/);
    assert.match(plannerInstructions, /Reply in JSON only/);
    assert.match(instructions, /Reply in JSON only/);
    const elementSchema = MEASURER_SCHEMA.properties.elements.items.properties;
    for (const field of ['padding', 'margin']) assert.ok(elementSchema[field].properties.top);
    assert.deepEqual(elementSchema.gap.type, ['number', 'null']);
    assert.deepEqual(MEASURER_SCHEMA.properties.rules.items.properties.value.type, ['number', 'null']);
    const sheet = {
        source: 'mockup.png', unit: 'px', canvas: { x: 0, y: 0, width: 400, height: 300 },
        elements: [{
            name: 'Hero card', box: { x: 40, y: 30, width: 200, height: 120 }, radius: 12,
            padding: { top: 16, right: 20, bottom: null, left: 20 },
            margin: { top: null, right: null, bottom: 24, left: null }, gap: 8,
            placement: 'two-column grid, aligned to canvas center',
            typography: { role: 'heading', family: '', familyConfidence: 'unknown', fontSize: 28, weight: 600, lineHeight: 34, letterSpacing: 0, style: '' },
        }],
        regions: [], rules: [{ name: 'spacing step', value: 8, unit: 'px', from: 'card items' }], notes: '',
    };
    const rendered = renderMeasurements(sheet);
    assert.match(rendered, /left 10%; top 10%; width 50%; height 40%/);
    assert.match(rendered, /aspect-ratio 1\.333 \/ 1/);
    assert.match(rendered, /padding: top 16 px, right 20 px/);
    assert.match(rendered, /margin: bottom 24 px/);
    assert.match(rendered, /gap: 8 px/);
    assert.match(rendered, /spacing step: 8 px/);
    assert.match(rendered, /typography: heading, size 28 px, weight 600, line-height 34 px, letter-spacing 0 px/);
    assert.match(rendered, /Typography workflow/);
    assert.match(ROLE_INSTRUCTIONS.coder, /canvas-relative percentages/);
    assert.match(ROLE_INSTRUCTIONS.coder, /responsive/);
    assert.match(ROLE_INSTRUCTIONS.worker, /numeric boxes relative to the stated canvas/);
    assert.match(ROLE_INSTRUCTIONS.coder, /selected family, CSS stack, role, weights/);
    assert.match(ROLE_INSTRUCTIONS.worker, /selected family, CSS stack, role, weights/);
});

test('architect schema carries structure, design, and a per-step brief', () => {
    assert.deepEqual(ARCHITECT_SCHEMA.required, ['summary', 'structure', 'design', 'stepGuidance', 'questionsForOrchestrator', 'conventions', 'risks']);
    assert.deepEqual(ARCHITECT_SCHEMA.properties.structure.items.required, ['path', 'kind', 'purpose', 'responsibilities', 'dependsOn', 'notes']);
    assert.deepEqual(ARCHITECT_SCHEMA.properties.design.required, ['layout', 'typography', 'color', 'motion', 'assets']);
    assert.deepEqual(ARCHITECT_SCHEMA.properties.stepGuidance.items.required, ['stepId', 'files', 'guidance']);
    const rendered = renderArchitecture({
        summary: 'one module',
        structure: [{ path: 'src/app.js', kind: 'code', purpose: 'entry', responsibilities: 'boot', dependsOn: [], notes: '' }],
        design: { layout: 'single column', typography: '', color: '', motion: '', assets: '' },
        stepGuidance: [{ stepId: 's01', files: ['src/app.js'], guidance: 'Export start().' }],
        questionsForOrchestrator: ['Where is the entry point?'],
        conventions: ['ES modules'],
        risks: [],
    });
    assert.match(rendered, /src\/app\.js \(code\): entry/);
    assert.match(rendered, /layout: single column/);
    assert.match(rendered, /s01 · files: src\/app\.js: Export start\(\)\./);
    assert.match(rendered, /Where is the entry point\?/);
});
