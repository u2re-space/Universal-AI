/**
 * @file test/pipeline.test.js
 * @purpose Stage order as data: catalog, resolver precedence, dependency pulls, and the runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    STAGE_CATALOG, PIPELINE_STAGE_IDS, DEFAULT_PIPELINE, TAIL_STAGES,
    normalizePipeline, resolvePipeline, createPipeline,
} from '../src/agent/pipeline.js';
import { PLAN_SCHEMA } from '../src/agent/schemas.js';
import { defaults, loadConfig } from '../src/core/config.js';

test('catalog: unique ids, default order matches the catalog, tail stages exist', () => {
    const ids = STAGE_CATALOG.map((stage) => stage.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...DEFAULT_PIPELINE], ids);
    assert.deepEqual([...PIPELINE_STAGE_IDS], ids);
    assert.ok(ids.indexOf('decor') < ids.indexOf('work'), 'decor runs before the page markup');
    assert.ok(ids.indexOf('work') < ids.indexOf('iconify'), 'icons are integrated after the page markup');
    assert.ok(ids.indexOf('iconify') < ids.indexOf('review'), 'the result is reviewed after icon integration');
    for (const id of TAIL_STAGES) assert.ok(ids.includes(id), `${id} is a catalog stage`);
    for (const stage of STAGE_CATALOG) {
        for (const dependency of stage.after) assert.ok(ids.includes(dependency), `${stage.id} depends on a known stage`);
        for (const dependency of stage.requires) assert.ok(stage.after.includes(dependency), `${stage.id} requires a stage it already follows`);
    }
});

test('normalizePipeline accepts strings and objects, drops unknown and duplicate ids', () => {
    assert.deepEqual(normalizePipeline(['plan', 'work', 'plan']), { ids: ['plan', 'work'], ignored: [] });
    assert.deepEqual(normalizePipeline([{ id: 'plan' }, { id: 'work', enabled: false }, { id: 'review' }]), { ids: ['plan', 'review'], ignored: [] });
    assert.deepEqual(normalizePipeline(['plan', 'nope', '']), { ids: ['plan'], ignored: ['nope'] });
    assert.equal(normalizePipeline(null), null);
    assert.equal(normalizePipeline('plan'), null);
});

test('resolvePipeline: the plan wins, then the config, then the catalog', () => {
    const fromPlan = resolvePipeline({ planPipeline: ['plan', 'work'], configPipeline: ['answer', 'plan', 'work'] });
    assert.equal(fromPlan.source, 'plan');
    assert.deepEqual(fromPlan.order, ['plan', 'work', 'iconify', 'outcome', 'memory']);

    const fromConfig = resolvePipeline({ planPipeline: [], configPipeline: ['plan', 'work'] });
    assert.equal(fromConfig.source, 'config');
    assert.deepEqual(fromConfig.order, ['plan', 'work', 'iconify', 'outcome', 'memory']);

    const fallback = resolvePipeline({ planPipeline: ['nope'], configPipeline: ['also-nope'] });
    assert.equal(fallback.source, 'default');
    assert.deepEqual(fallback.order, [...DEFAULT_PIPELINE]);
});

test('resolvePipeline always appends the tail stages exactly once', () => {
    const { order } = resolvePipeline({ planPipeline: ['memory', 'outcome', 'plan'] });
    assert.deepEqual(order, ['plan', 'outcome', 'memory']);
    assert.equal(order.filter((id) => id === 'outcome').length, 1);
    assert.equal(order.filter((id) => id === 'memory').length, 1);
});

test('resolvePipeline pulls a dependency in front of its dependent, keeping the rest in place', () => {
    assert.deepEqual(resolvePipeline({ planPipeline: ['work', 'plan'] }).order, ['plan', 'work', 'iconify', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['review', 'work'] }).order, ['plan', 'work', 'iconify', 'review', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['memory', 'outcome'] }).order, ['plan', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['collect', 'plan', 'architect'] }).order, ['plan', 'architect', 'collect', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['work', 'decor', 'plan'] }).order, ['plan', 'decor', 'work', 'iconify', 'outcome', 'memory']);
});

test('resolvePipeline adds a hard dependency a caller forgot', () => {
    assert.deepEqual(resolvePipeline({ planPipeline: ['work'] }).order, ['plan', 'work', 'iconify', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['review'] }).order, ['plan', 'work', 'iconify', 'review', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['measure'] }).order, ['plan', 'decompose', 'measure', 'outcome', 'memory']);
    assert.deepEqual(resolvePipeline({ planPipeline: ['work', 'iconify', 'review'] }).order, ['plan', 'work', 'iconify', 'review', 'outcome', 'memory']);
});

test('resolvePipeline reports unknown ids and a stable signature', () => {
    const a = resolvePipeline({ planPipeline: ['plan', 'ghost', 'work'] });
    const b = resolvePipeline({ planPipeline: ['plan', 'work'] });
    assert.deepEqual(a.ignored, ['ghost']);
    assert.equal(a.signature, b.signature);
});

test('createPipeline runs stages in order and skips a stage whose when() is false', async () => {
    const seen = [];
    const events = [];
    const pipeline = createPipeline({
        config: { agent: { pipeline: ['plan', 'work', 'outcome'] } },
        stages: [
            { id: 'plan', run: async () => { seen.push('plan'); } },
            { id: 'work', when: () => false, run: async () => { seen.push('work'); } },
            { id: 'iconify', when: () => false, run: async () => { seen.push('iconify'); } },
            { id: 'outcome', run: async () => { seen.push('outcome'); } },
            { id: 'memory', run: async () => { seen.push('memory'); } },
        ],
        notify: (event) => events.push(event),
    });
    await pipeline.run();
    assert.deepEqual(seen, ['plan', 'outcome', 'memory']);
    assert.deepEqual(events.filter((e) => e.type === 'stage.skip').map((e) => e.stage), ['work', 'iconify']);
});

test('createPipeline stops on an exit value and runs no further stage', async () => {
    const seen = [];
    const pipeline = createPipeline({
        config: { agent: { pipeline: ['plan', 'work', 'outcome'] } },
        stages: [
            { id: 'plan', run: async () => ({ exit: 'stopped' }) },
            { id: 'work', run: async () => { seen.push('work'); } },
        ],
    });
    assert.equal(await pipeline.run(), 'stopped');
    assert.deepEqual(seen, []);
});

test('createPipeline picks up a plan that appears mid-run and applies its order', async () => {
    const seen = [];
    let plan = null;
    const pipeline = createPipeline({
        config: { agent: { pipeline: null } },
        plan: () => plan,
        stages: [
            { id: 'answer', run: async () => { seen.push('answer'); } },
            { id: 'plan', run: async () => { seen.push('plan'); plan = { pipeline: ['plan', 'work', 'outcome'] }; } },
            { id: 'collect', run: async () => { seen.push('collect'); } },
            { id: 'work', run: async () => { seen.push('work'); } },
            { id: 'outcome', run: async () => { seen.push('outcome'); } },
            { id: 'memory', run: async () => { seen.push('memory'); } },
        ],
    });
    await pipeline.run();
    assert.deepEqual(seen, ['answer', 'plan', 'work', 'outcome', 'memory']);
});

test('createPipeline ignores a stage with no implementation', async () => {
    const seen = [];
    const pipeline = createPipeline({
        config: { agent: { pipeline: ['plan', 'images', 'outcome'] } },
        stages: [{ id: 'plan', run: async () => { seen.push('plan'); } }],
    });
    await pipeline.run();
    assert.deepEqual(seen, ['plan']);
});

test('PLAN_SCHEMA carries the stage enum and requires the field', () => {
    const pipeline = PLAN_SCHEMA.properties.pipeline;
    assert.deepEqual(pipeline.items.enum, [...PIPELINE_STAGE_IDS]);
    assert.ok(PLAN_SCHEMA.required.includes('pipeline'));
});

test('agent.pipeline accepts known stages and rejects unknown ones', async () => {
    assert.equal(defaults.agent.pipeline, null);
    const config = await loadConfig({ cwd: process.cwd(), env: {}, overrides: { agent: { pipeline: ['plan', 'work', 'review'] } } });
    assert.deepEqual(config.agent.pipeline, ['plan', 'work', 'review']);
    await assert.rejects(
        loadConfig({ cwd: process.cwd(), env: {}, overrides: { agent: { pipeline: ['plan', 'nope'] } } }),
        /agent\.pipeline/,
    );
    await assert.rejects(
        loadConfig({ cwd: process.cwd(), env: {}, overrides: { agent: { pipeline: 'plan' } } }),
        /agent\.pipeline/,
    );
});
