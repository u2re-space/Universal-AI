import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceParagraph, applyPins, ceilingIndex, clampModel, guaranteesParagraph, mergeSteps, resolvePace } from '../src/agent/pace.js';

const models = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'];
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

test('default pace keeps a complex author on luna and the planner on sol', () => {
    const pace = resolvePace({
        ...base, label: 'normal',
        steps: [{ complexity: 'complex', author: 'coder', files: ['src/a.js'], goal: 'write', details: '', verify: '' }],
    });
    assert.equal(pace.ceilingModel, 'gpt-6.1-sol');
    assert.equal(pace.roles.planner.model, 'gpt-6.1-sol');
    assert.equal(pace.roles.planner.effort, 'high');
    assert.equal(pace.steps[0].model, 'gpt-6-luna');
    assert.equal(pace.steps[0].effort, 'high');
    assert.equal(pace.roles.classifier.model, 'gpt-6-luna');
    assert.equal(pace.roles.classifier.effort, 'low');
    assert.equal(pace.roles.extractor.model, 'gpt-6-luna');
    assert.equal(pace.roles.extractor.effort, 'low');
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
    assert.equal(planner(5, 50), 'xhigh');
    assert.equal(planner(5, 20), 'medium');
    assert.equal(planner(90, 80), 'medium');
    assert.equal(planner(70, 80), 'high');
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
    assert.equal(once.steps[0].model, 'gpt-6.1-sol');
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
    assert.equal(high.roles.reviewer.model, 'gpt-6-astra');
    assert.equal(high.roles.collector.rung, 0);
    assert.equal(high.roles.summarizer.model, 'gpt-6-luna');
    const normalAuthor = resolvePace({
        ...base, speed: 90, quality: 80, label: 'normal',
        steps: [{ complexity: 'normal', author: 'coder', files: [], goal: 'g', details: '', verify: '' }],
    }).steps[0];
    assert.equal(normalAuthor.model, 'gpt-6.1-sol');
    assert.equal(resolvePace({ ...base, quality: 20, label: 'complex' }).reviewRounds, 0);
    assert.equal(resolvePace({ ...base, quality: 20, label: 'complex' }).acceptance, 'loose');
    const single = resolvePace({ ...base, mode: 'c', speed: 10, quality: 80, label: 'normal', task: 'note', author: 'writer' });
    assert.equal(single.steps[0].model, 'gpt-6.1-sol');
    assert.equal(resolvePace({ ...base, mode: 'c', speed: 90, quality: 80, label: 'trivial', task: 'typo', author: 'worker' }).steps[0].model, 'gpt-6-luna');
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
    assert.equal(clampModel('gpt-6-astra', models, 1, false), 'gpt-6.1-sol');
    assert.equal(clampModel('gpt-6-astra', models, 1, true), 'gpt-6-astra');
    assert.equal(clampModel('gpt-6-luna-nano', models, 0, false), 'gpt-6-luna-nano');
});

test('generation fidelity is attached only when a stated value is passed', () => {
    assert.equal(resolvePace({ ...base, label: 'normal' }).fidelity, null);
    assert.deepEqual(resolvePace({ ...base, label: 'normal', fidelity: 87 }).fidelity, { stated: 87, effective: 66 });
});

test('a shared budget of 200 splits stable, strained, and broken pace', () => {
    const steady = resolvePace({ ...base, speed: 10, quality: 40, label: 'normal' });
    assert.equal(steady.guarantees, 'steady');
    assert.equal(steady.ceilingModel, 'gpt-6.1-sol');
    assert.equal(steady.roles.planner.effort, 'high');
    assert.equal(steady.stepCap, 12);
    assert.equal(guaranteesParagraph('steady'), '');

    const qualityMax = resolvePace({ ...base, speed: 0, quality: 200, label: 'normal' });
    assert.equal(qualityMax.guarantees, 'strained');
    assert.equal(qualityMax.policy, 'b');
    assert.equal(qualityMax.ceilingModel, 'gpt-6-astra');
    assert.equal(qualityMax.roles.planner.model, 'gpt-6-astra');
    assert.equal(qualityMax.roles.planner.effort, 'xhigh');
    assert.equal(qualityMax.stepCap, 16);
    assert.equal(qualityMax.reviewMode, 'plan');
    assert.equal(qualityMax.reviewRounds, 2);
    assert.deepEqual(resolvePace({ ...base, speed: 0, quality: 200, label: 'normal', fidelity: 87 }).fidelity, { stated: 87, effective: 100 });
    const qualityAuthor = resolvePace({
        ...base, speed: 0, quality: 200, label: 'normal',
        steps: [{ complexity: 'complex', author: 'coder', files: ['a.js'], goal: 'write', details: '', verify: '' }],
    }).steps[0];
    assert.equal(qualityAuthor.model, 'gpt-6-astra');

    const both = resolvePace({ ...base, speed: 100, quality: 100, label: 'normal' });
    assert.equal(both.guarantees, 'strained');
    assert.equal(both.merge, true);
    assert.equal(both.ceilingModel, 'gpt-6-astra');
    assert.equal(both.roles.planner.model, 'gpt-6-astra');
    assert.equal(both.roles.planner.effort, 'medium');
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
