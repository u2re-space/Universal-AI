import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceParagraph, applyPins, ceilingIndex, clampModel, guaranteesParagraph, mergeSteps, resolvePace, stageEffort, fineQuality, defaultFineQuality } from '../src/agent/pace.js';

const models = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'];
const base = { speed: 10, quality: 40, mode: 'auto', models };

test('ceiling index follows quality times ladder length', () => {
    assert.equal(ceilingIndex(0, 3), 0);
    assert.equal(ceilingIndex(33, 3), 0);
    assert.equal(ceilingIndex(34, 3), 1);
    assert.equal(ceilingIndex(40, 3), 1);
    assert.equal(ceilingIndex(66, 3), 1);
    assert.equal(ceilingIndex(67, 3), 2);
    assert.equal(ceilingIndex(100, 3), 2);
    assert.equal(ceilingIndex(100, 1), 0);
});

test('auto policy follows speed and the label', () => {
    assert.equal(resolvePace({ ...base, speed: 9, label: 'normal' }).policy, 'b');
    assert.equal(resolvePace({ ...base, speed: 10, label: 'normal' }).policy, 'a');
    assert.equal(resolvePace({ ...base, speed: 66, label: 'complex' }).merge, false);
    assert.equal(resolvePace({ ...base, speed: 67, label: 'trivial' }).policy, 'c');
    assert.equal(resolvePace({ ...base, speed: 67, label: 'complex' }).merge, true);
    assert.equal(resolvePace({ ...base, speed: 80, label: null }).ready, false);
    assert.equal(resolvePace({ ...base, speed: 80, label: null }).policy, 'a');
    assert.equal(resolvePace({ ...base, speed: 90, mode: 'b', label: 'complex' }).merge, false);
    assert.equal(resolvePace({ ...base, speed: 80, mode: 'a', label: 'trivial' }).policy, 'a');
    assert.equal(resolvePace({ ...base, speed: 80, mode: 'a', label: 'trivial' }).merge, false);
    assert.equal(resolvePace({ ...base, speed: 10, mode: 'c', label: 'complex' }).policy, 'c');
});

test('default pace keeps a complex author on the coder floor and the planner on terra', () => {
    const pace = resolvePace({
        ...base, label: 'normal',
        steps: [{ complexity: 'complex', author: 'coder', files: ['src/a.js'], goal: 'write', details: '', verify: '' }],
    });
    assert.equal(pace.ceilingModel, 'gpt-6.1-terra');
    assert.equal(pace.roles.planner.model, 'gpt-6.1-terra');
    assert.equal(pace.roles.planner.effort, 'xhigh');
    assert.equal(pace.roles.architect.model, 'gpt-6.1-terra');
    assert.equal(pace.roles.architect.effort, 'xhigh');
    assert.equal(pace.steps[0].model, 'gpt-6.1-terra');
    assert.equal(pace.steps[0].effort, 'high');
    assert.equal(pace.roles.classifier.model, 'gpt-6.1-terra');
    assert.equal(pace.roles.classifier.effort, 'xhigh');
    assert.equal(pace.roles.extractor.model, 'gpt-6.1-terra');
    assert.equal(pace.roles.extractor.effort, 'xhigh');
    assert.equal(pace.reviewRounds, 1);
    assert.equal(pace.reviewMode, 'force');
    assert.equal(pace.collect, 'allow');
    assert.equal(pace.stepCap, 12);
    assert.equal(pace.acceptance, 'normal');
});

test('trivial label lowers the ceiling and skips review', () => {
    const pace = resolvePace({ ...base, quality: 40, label: 'trivial' });
    assert.equal(pace.ceilingModel, 'gpt-6-luna');
    assert.equal(pace.roles.planner.model, 'gpt-6-luna');
    assert.equal(pace.reviewMode, 'off');
    assert.equal(pace.collect, 'off');
    assert.equal(pace.stepCap, 4);
    assert.equal(resolvePace({ ...base, quality: 40, label: 'trivial', generation: true }).stepCap, 2);
});

test('effort shift matches the locked rows', () => {
    const planner = (speed, quality, label = 'normal') => resolvePace({ ...base, speed, quality, label }).roles.planner.effort;
    assert.equal(planner(5, 50), 'max');
    assert.equal(planner(5, 20), 'high');
    assert.equal(planner(90, 80), 'high');
    assert.equal(planner(70, 80), 'xhigh');
    const author = (speed, quality, complexity) => resolvePace({
        ...base, speed, quality, label: 'normal',
        steps: [{ complexity, author: 'coder', files: [], goal: 'g', details: '', verify: '' }],
    }).steps[0].effort;
    assert.equal(author(90, 20, 'complex'), 'low');
    assert.equal(author(100, 10, 'trivial'), 'minimal');
});

test('stage caps follow policy, speed, and generation', () => {
    assert.equal(resolvePace({ ...base, speed: 5, label: 'complex' }).stepCap, 16);
    assert.equal(resolvePace({ ...base, speed: 5, label: 'complex', generation: true }).stepCap, 8);
    assert.equal(resolvePace({ ...base, speed: 5, label: 'complex' }).reviewMode, 'plan');
    assert.equal(resolvePace({ ...base, speed: 5, label: 'complex' }).collect, 'allow');
    const fast = resolvePace({ ...base, speed: 90, quality: 80, label: 'complex' });
    assert.equal(fast.merge, true);
    assert.equal(fast.collect, 'off');
    assert.equal(fast.stepCap, 2);
    assert.equal(resolvePace({ ...base, speed: 90, quality: 80, label: 'complex', generation: true }).stepCap, 1);
    assert.equal(resolvePace({ ...base, speed: 90, quality: 80, label: 'normal' }).stepCap, 4);
    assert.equal(resolvePace({ ...base, speed: 90, label: 'trivial' }).stepCap, 1);
    assert.equal(resolvePace({ ...base, speed: 90, label: 'trivial' }).steps.length, 1);
    const pinnedCap = resolvePace({ ...base, speed: 5, label: 'complex', stepCapOverride: 3 });
    assert.equal(pinnedCap.stepCap, 3);
    assert.equal(resolvePace({ ...base, mode: 'c', label: 'complex', stepCapOverride: 12 }).stepCap, 1);
});

test('policy c builds one author step and a saved plan stays split', () => {
    const once = resolvePace({ ...base, mode: 'c', label: 'complex', task: 'Build the API', author: 'coder' });
    assert.equal(once.steps.length, 1);
    assert.equal(once.steps[0].goal, 'Build the API');
    assert.equal(once.steps[0].author, 'coder');
    assert.equal(once.steps[0].complexity, 'complex');
    assert.equal(once.steps[0].model, 'gpt-6.1-terra');
    assert.equal(once.reviewMode, 'off');
    assert.equal(once.collect, 'off');
    const saved = resolvePace({
        ...base, mode: 'c', label: 'normal',
        steps: [
            { complexity: 'normal', author: 'coder', files: ['a.js'], goal: 'one', details: 'd1', verify: 'v1' },
            { complexity: 'normal', author: 'coder', files: ['b.js'], goal: 'two', details: 'd2', verify: 'v2' },
        ],
    });
    assert.equal(saved.steps.length, 2);
    assert.equal(saved.steps[0].goal, 'one');
});

test('merge folds adjacent steps of the same author and rung', () => {
    const pace = resolvePace({
        ...base, speed: 90, quality: 80, label: 'complex',
        steps: [
            { complexity: 'complex', author: 'coder', files: ['a.js'], goal: 'one', details: 'd1', verify: 'v1' },
            { complexity: 'complex', author: 'coder', files: ['b.js'], goal: 'two', details: 'd2', verify: 'v2' },
            { complexity: 'trivial', author: 'writer', files: ['README.md'], goal: 'note', details: '', verify: '' },
        ],
    });
    assert.equal(pace.steps.length, 2);
    assert.match(pace.steps[0].goal, /one\n\ntwo/);
    assert.equal(pace.steps[0].complexity, 'complex');
    assert.deepEqual(pace.steps[0].files, ['a.js', 'b.js']);
    assert.equal(pace.steps[1].author, 'writer');
    assert.equal(pace.steps[1].model, 'gpt-6-luna');
});

test('rungs and review rounds follow the tables', () => {
    const high = resolvePace({ ...base, speed: 90, quality: 80, label: 'normal' });
    // gpt-6-astra is forbidden for the reviewer: the ladder steps down to the previous rung.
    assert.equal(high.roles.reviewer.model, 'gpt-6.1-terra');
    assert.equal(high.roles.orchestrator.rung, 1);
    assert.equal(high.roles.summarizer.model, 'gpt-6.1-terra');
    const normalAuthor = resolvePace({
        ...base, speed: 90, quality: 80, label: 'normal',
        steps: [{ complexity: 'normal', author: 'coder', files: [], goal: 'g', details: '', verify: '' }],
    }).steps[0];
    assert.equal(normalAuthor.model, 'gpt-6.1-terra');
    assert.equal(resolvePace({ ...base, quality: 20, label: 'complex' }).reviewRounds, 0);
    assert.equal(resolvePace({ ...base, quality: 20, label: 'complex' }).acceptance, 'loose');
    const single = resolvePace({ ...base, mode: 'c', speed: 10, quality: 80, label: 'normal', task: 'note', author: 'writer' });
    assert.equal(single.steps[0].model, 'gpt-6.1-terra');
    assert.equal(resolvePace({ ...base, mode: 'c', speed: 90, quality: 80, label: 'trivial', task: 'typo', author: 'worker' }).steps[0].model, 'gpt-6.1-terra');
    assert.equal(resolvePace({ ...base, mode: 'c', speed: 90, quality: 80, label: 'trivial', task: 'note', author: 'writer' }).steps[0].model, 'gpt-6-luna');
});

test('acceptance paragraphs name the criterion cap', () => {
    assert.match(acceptanceParagraph('loose'), /at most three/);
    assert.match(acceptanceParagraph('normal'), /at most six/);
    assert.match(acceptanceParagraph('strict'), /at most eight/);
});

test('pins replace pace and clamp only an unpinned ladder model', () => {
    const pace = resolvePace({ ...base, label: 'normal' });
    const pinned = applyPins(pace, { planner: { model: 'custom-planner', effort: 'max' } }, { planner: { model: true, effort: true } });
    assert.equal(pinned.roles.planner.model, 'custom-planner');
    assert.equal(pinned.roles.planner.effort, 'max');
    assert.equal(clampModel('gpt-6.1-sol', models, 1, false), 'gpt-6.1-terra');
    assert.equal(clampModel('gpt-6.1-sol', models, 1, true), 'gpt-6.1-sol');
    assert.equal(clampModel('gpt-6-luna-nano', models, 0, false), 'gpt-6-luna-nano');
});

test('generation fidelity is attached only when a stated value is passed', () => {
    assert.equal(resolvePace({ ...base, label: 'normal' }).fidelity, null);
    assert.deepEqual(resolvePace({ ...base, label: 'normal', fidelity: 80 }).fidelity, { stated: 80, effective: 61 });
});

test('a shared budget of 200 splits stable, strained, and broken pace', () => {
    const steady = resolvePace({ ...base, speed: 10, quality: 40, label: 'normal' });
    assert.equal(steady.guarantees, 'steady');
    assert.equal(steady.ceilingModel, 'gpt-6.1-terra');
    assert.equal(steady.roles.planner.effort, 'xhigh');
    assert.equal(steady.stepCap, 12);
    assert.equal(guaranteesParagraph('steady'), '');

    const qualityMax = resolvePace({ ...base, speed: 0, quality: 200, label: 'normal' });
    assert.equal(qualityMax.guarantees, 'strained');
    assert.equal(qualityMax.policy, 'b');
    assert.equal(qualityMax.ceilingModel, 'gpt-6.1-sol');
    assert.equal(qualityMax.roles.planner.model, 'gpt-6.1-sol');
    assert.equal(qualityMax.roles.planner.effort, 'xhigh');
    assert.equal(qualityMax.stepCap, 16);
    assert.equal(qualityMax.reviewMode, 'plan');
    assert.equal(qualityMax.reviewRounds, 2);
    assert.deepEqual(resolvePace({ ...base, speed: 0, quality: 200, label: 'normal', fidelity: 80 }).fidelity, { stated: 80, effective: 100 });
    const qualityAuthor = resolvePace({
        ...base, speed: 0, quality: 200, label: 'normal',
        steps: [{ complexity: 'complex', author: 'coder', files: ['a.js'], goal: 'write', details: '', verify: '' }],
    }).steps[0];
    assert.equal(qualityAuthor.model, 'gpt-6.1-sol');

    const both = resolvePace({ ...base, speed: 100, quality: 100, label: 'normal' });
    assert.equal(both.guarantees, 'strained');
    assert.equal(both.merge, true);
    assert.equal(both.ceilingModel, 'gpt-6.1-sol');
    assert.equal(both.roles.planner.model, 'gpt-6.1-sol');
    assert.equal(both.roles.planner.effort, 'high');
    assert.match(guaranteesParagraph('strained'), /Balance is not promised/);

    const reckless = resolvePace({ ...base, speed: 180, quality: 20, label: 'normal' });
    assert.equal(reckless.guarantees, 'broken');
    assert.equal(reckless.ceilingModel, 'gpt-6-luna');
    assert.equal(reckless.roles.planner.effort, 'minimal');
    assert.equal(reckless.reviewMode, 'off');
    assert.equal(reckless.reviewRounds, 0);
    assert.equal(reckless.stepCap, 1);
    assert.equal(resolvePace({ ...base, speed: 180, quality: 20, label: 'normal', stepCapOverride: 12 }).stepCap, 1);
    assert.match(guaranteesParagraph('broken'), /Acceptance criteria are not binding/);

    assert.throws(() => resolvePace({ ...base, speed: -1, quality: 40 }), /pace\.speed/);
    assert.throws(() => resolvePace({ ...base, speed: 10, quality: 201 }), /pace\.quality/);
    assert.throws(() => resolvePace({ ...base, speed: 100, quality: 101 }), /pace\.speed/);
});

test('defaultFineQuality is min(quality + speed, 200)', () => {
    assert.equal(defaultFineQuality(10, 40), 50);
    assert.equal(defaultFineQuality(100, 100), 200);
    assert.equal(defaultFineQuality(150, 100), 200);
    assert.equal(defaultFineQuality(0, 0), 0);
    assert.equal(defaultFineQuality(undefined, undefined), 0);
});

test('fineQuality returns the set value or the default', () => {
    assert.equal(fineQuality({ speed: 10, quality: 40, codeQuality: 120 }, 'codeQuality'), 120);
    assert.equal(fineQuality({ speed: 10, quality: 40 }, 'codeQuality'), 50);
    assert.equal(fineQuality({ speed: 10, quality: 40, codeQuality: null }, 'codeQuality'), 50);
    assert.equal(fineQuality({ speed: 10, quality: 40, codeQuality: 0 }, 'codeQuality'), 0);
});

test('stageEffort moves one level per 34 points and stays neutral at the default', () => {
    assert.equal(stageEffort('high', 50, 50), 'high');
    assert.equal(stageEffort('high', 50, 40), 'high');
    assert.equal(stageEffort('high', 50, 84), 'xhigh');
    assert.equal(stageEffort('high', 50, 118), 'max');
    assert.equal(stageEffort('high', 50, 20), 'medium');
    assert.equal(stageEffort('low', 50, 0), 'minimal');
    assert.equal(stageEffort('medium', 50, 200), 'max');
});

test('a per-stage dial moves only its own stage', () => {
    const pace = resolvePace({ ...base, label: 'normal', architectQuality: 150 });
    assert.equal(pace.roles.architect.effort, 'max');
    assert.equal(pace.roles.planner.effort, resolvePace({ ...base, label: 'normal' }).roles.planner.effort);
    assert.equal(pace.roles.reviewer.effort, resolvePace({ ...base, label: 'normal' }).roles.reviewer.effort);
    assert.equal(pace.ceilingModel, resolvePace({ ...base, label: 'normal' }).ceilingModel);
});

test('styler steps keep their author and the gpt-6.1-sol model for initial styling', () => {
    const pace = resolvePace({ ...base, label: 'normal', steps: [{ complexity: 'trivial', author: 'styler', files: ['styles/app.css'], goal: 'write styles', details: '', verify: '' }] });
    assert.equal(pace.steps[0].author, 'styler');
    assert.equal(pace.steps[0].model, 'gpt-6.1-sol');

    const single = resolvePace({ ...base, mode: 'c', label: 'trivial', author: 'styler', task: 'write styles' }).steps[0];
    assert.equal(single.author, 'styler');
    assert.equal(single.model, 'gpt-6.1-sol');
});

test('the iconifier dial is isolated from other roles and exposed in qualities', () => {
    const quiet = resolvePace({ ...base, label: 'normal' });
    const loud = resolvePace({ ...base, label: 'normal', iconifierQuality: 150 });
    assert.equal(loud.qualities.iconifier, 150);
    assert.equal(loud.roles.architect.effort, quiet.roles.architect.effort);
    assert.equal(loud.roles.reviewer.effort, quiet.roles.reviewer.effort);
    assert.equal(loud.ceilingModel, quiet.ceilingModel);
});

test('the code dial lifts step effort without touching the model ceiling', () => {
    const quiet = resolvePace({ ...base, label: 'normal', steps: [{ complexity: 'normal', author: 'coder', files: [], goal: 'g', details: '', verify: '' }] });
    const loud = resolvePace({ ...base, label: 'normal', codeQuality: 150, steps: [{ complexity: 'normal', author: 'coder', files: [], goal: 'g', details: '', verify: '' }] });
    assert.equal(quiet.steps[0].effort, 'medium');
    assert.equal(loud.steps[0].effort, 'max');
    assert.equal(loud.steps[0].model, quiet.steps[0].model);
});

test('an unknown per-stage dial value is rejected', () => {
    assert.throws(() => resolvePace({ ...base, label: 'normal', codeQuality: 201 }), /pace\.codeQuality/);
    assert.throws(() => resolvePace({ ...base, label: 'normal', decorQuality: -1 }), /pace\.decorQuality/);
});

test('code authors never fall below the coder floor', () => {
    const step = (author, complexity, extra = {}) => resolvePace({
        ...base, speed: 90, quality: 20, label: 'normal', ...extra,
        steps: [{ complexity, author, files: [], goal: 'g', details: '', verify: '' }],
    }).steps[0];
    assert.equal(step('coder', 'trivial').model, 'gpt-6.1-terra');
    assert.equal(step('worker', 'trivial').model, 'gpt-6.1-terra');
    assert.equal(step('coder', 'normal').model, 'gpt-6.1-terra');
    // Documents keep the cheapest rung.
    assert.equal(step('writer', 'trivial').model, 'gpt-6-luna');
    // A raised code dial no longer leaves the author on the cheap model.
    assert.equal(step('coder', 'normal', { codeQuality: 120 }).model, 'gpt-6.1-terra');
    const single = resolvePace({ ...base, mode: 'c', speed: 90, quality: 20, label: 'trivial', task: 'fix', author: 'coder' }).steps[0];
    assert.equal(single.model, 'gpt-6.1-terra');
});

test('a ladder without the floor model keeps its own cheapest rung', () => {
    const custom = ['gpt-6-luna', 'gpt-6-sol'];
    const pace = resolvePace({
        speed: 10, quality: 40, mode: 'auto', models: custom, label: 'normal',
        steps: [{ complexity: 'trivial', author: 'coder', files: [], goal: 'g', details: '', verify: '' }],
    });
    assert.equal(pace.steps[0].model, 'gpt-6-luna');
});
