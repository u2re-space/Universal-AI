import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
    applyFromStep, applyPlanUpdate, briefPlan, continuationText, createProgress, expandPlan, findLatestResumable, findResumable, loadWork, parsePlanUpdate, pathsIn, recordStep, resolveResumeStep, saveWork,
} from '../src/agent/work-plan.js';

const base = {
    summary: 'сделать', complexity: 'normal', filesOfInterest: [], searchQueries: [], questionsForCollector: [],
    acceptanceCriteria: ['работает'], needsReview: false, imageNotes: null, risks: [], fileActions: [], taskMap: [],
};

test('pathsIn keeps project files and skips versions', () => {
    assert.deepEqual(pathsIn('Собери src/app.js и test/app.test.js, версия 1.2'), ['src/app.js', 'test/app.test.js']);
    assert.deepEqual(pathsIn('Primary file: src/app.tsx. Next src/app.scss.'), ['src/app.tsx', 'src/app.scss']);
});

test('a step that names two files becomes one step per file plus a compatibility step', () => {
    const plan = expandPlan({
        ...base,
        steps: [{ goal: 'написать модули', details: 'src/a.js и src/b.js', verify: 'прочитать' }],
    }, { maxSteps: 12 });
    assert.deepEqual(plan.steps.map((step) => step.kind), ['work', 'work', 'compat']);
    assert.deepEqual(plan.steps[0].files, ['src/a.js']);
    assert.deepEqual(plan.steps[1].files, ['src/b.js']);
    assert.equal(plan.steps[0].id, 's01');
    assert.equal(plan.steps[2].id, 's03');
    assert.match(plan.steps[2].details, /src\/a\.js/);
});

test('a generation plan keeps related files in one step', () => {
    const plan = expandPlan({
        ...base,
        steps: [{ goal: 'страница', details: 'src/app.tsx и src/app.scss', verify: 'сборка' }],
    }, { maxSteps: 4, splitFiles: false });
    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.steps[0].files, ['src/app.tsx', 'src/app.scss']);
});

test('separate file steps keep their goals and gain a compatibility step', () => {
    const plan = expandPlan({
        ...base,
        steps: [
            { goal: 'Создать src/sum.js', details: 'export const sum', verify: 'прочитать файл' },
            { goal: 'Создать тест', details: 'test/sum.test.js', verify: 'node --test' },
        ],
    });
    assert.deepEqual(plan.steps.map((step) => step.goal), ['Создать src/sum.js', 'Создать тест', 'Reconcile generated files']);
});

test('a trivial step without files stays one step', () => {
    const plan = expandPlan({ ...base, complexity: 'trivial', steps: [{ goal: 'сделать', details: '', verify: '' }] });
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].kind, 'work');
});

test('expandPlan does not grow past maxSteps', () => {
    const plan = expandPlan({
        ...base,
        steps: [{ goal: 'оба', details: 'src/a.js src/b.js', verify: '' }],
    }, { maxSteps: 2 });
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps.some((step) => step.kind === 'compat'), false);
});

test('parsePlanUpdate reads a fence and ignores broken JSON', () => {
    const update = parsePlanUpdate('готово\n```plan-update\n{"note":"ещё","addSteps":[{"goal":"второй","details":"src/x.js","verify":"да"}],"revise":[{"id":"s02","details":"уточнить"}]}\n```');
    assert.equal(update.note, 'ещё');
    assert.equal(update.addSteps[0].goal, 'второй');
    assert.equal(update.revise[0].id, 's02');
    assert.equal(parsePlanUpdate('```plan-update\n{]\n```'), null);
    assert.equal(parsePlanUpdate('без блока'), null);
});

test('applyPlanUpdate revises a step and inserts the new one before compatibility', () => {
    const plan = expandPlan({
        ...base,
        steps: [
            { goal: 'src/a.js', details: 'src/a.js', verify: '' },
            { goal: 'src/b.js', details: 'src/b.js', verify: '' },
        ],
    });
    const update = parsePlanUpdate('```plan-update\n{"note":"добавлен","revise":[{"id":"s02","details":"только src/b.js"}],"addSteps":[{"goal":"третий","details":"ещё","verify":"да"}]}\n```');
    const next = applyPlanUpdate(plan, update, { maxSteps: 12, afterId: 's01' });
    assert.deepEqual(next.plan.steps.map((step) => step.goal), ['src/a.js', 'третий', 'src/b.js', 'Reconcile generated files']);
    assert.match(next.plan.steps[2].details, /src\/b\.js/);
    assert.equal(next.note, 'добавлен');
});

test('recordStep keeps the cursor on a failed step and advances after success', () => {
    const plan = expandPlan({ ...base, complexity: 'trivial', steps: [{ goal: 'один', details: '', verify: '' }, { goal: 'два', details: '', verify: '' }] });
    let progress = createProgress({ id: 'abcd1234', task: 'задача', plan });
    progress = recordStep(progress, { index: 0, status: 'incomplete', report: 'обрыв', files: [] });
    assert.equal(progress.cursor, 0);
    assert.equal(progress.status, 'incomplete');
    progress = recordStep(progress, { index: 0, status: 'completed', report: 'готово', files: ['src/a.js'] });
    assert.equal(progress.cursor, 1);
    assert.deepEqual(progress.files, [{ path: 'src/a.js', stepId: plan.steps[0].id }]);
    progress = recordStep(progress, { index: 0, status: 'max_turns', report: 'обрыв', files: ['src/a.js'], phase: 'body' });
    progress = recordStep(progress, { index: 1, status: 'completed', report: 'дальше', files: [] });
    assert.equal(progress.cursor, 0);
    assert.equal(progress.steps[0].phase, 'body');
});

test('continuation text keeps the unfinished phase and forbids rewriting finished work', () => {
    const text = continuationText(
        { goal: 'стили и картинки', details: 'src/app.scss', verify: 'сравнить' },
        { phase: 'body', files: ['src/app.scss'], report: 'сетка уже есть' },
    );
    assert.match(text, /interrupted turn/);
    assert.match(text, /do not regenerate an image/);
    assert.match(text, /src\/app\.scss/);
    assert.match(text, /сетка уже есть/);
    assert.match(continuationText({ goal: 'дописать' }, {}, { resumeSession: true }), /conversation above/);
});

test('a resume step token and a start index stay on the unfinished step', () => {
    const plan = expandPlan({ ...base, complexity: 'trivial', steps: [{ goal: 'один', details: '', verify: '' }, { goal: 'два', details: '', verify: '' }] });
    assert.equal(resolveResumeStep(plan, '2'), 1);
    assert.equal(resolveResumeStep(plan, 's01'), 0);
    assert.equal(resolveResumeStep(plan, 's2'), 1);
    assert.equal(resolveResumeStep(plan, '9'), -1);
    let progress = createProgress({ id: 'abcd1234', task: 'задача', plan });
    progress = recordStep(progress, { index: 0, status: 'completed', report: 'готово', files: [] });
    progress = recordStep(progress, { index: 1, status: 'max_turns', report: 'обрыв', files: ['src/app.tsx'], phase: 'body' });
    const fromStart = applyFromStep(progress, 0);
    assert.equal(fromStart.cursor, 0);
    assert.equal(fromStart.steps[0].status, 'pending');
    assert.equal(fromStart.steps[1].status, 'max_turns');
    const fromOpen = applyFromStep(progress, 1);
    assert.equal(fromOpen.cursor, 1);
    assert.equal(fromOpen.steps[0].status, 'completed');
    assert.equal(fromOpen.steps[1].status, 'max_turns');
});

test('briefPlan points at the files and does not include step details', () => {
    const plan = expandPlan({ ...base, steps: [{ goal: 'написать', details: 'очень длинные детали', verify: 'да' }] });
    const progress = createProgress({ id: 'abcd1234', task: 'задача', plan });
    const text = briefPlan(plan, progress);
    assert.match(text, /\.tmp\/abcd1234\/plan\.json/);
    assert.equal(text.includes('очень длинные детали'), false);
});

test('findResumable returns the newest unfinished plan for the same task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-work-plan-'));
    try {
        const older = expandPlan({ ...base, steps: [{ goal: 'старый', details: '', verify: '' }] });
        const olderProgress = createProgress({ id: 'aaaa1111', task: 'одна задача', plan: older });
        olderProgress.status = 'incomplete';
        await saveWork(root, { id: 'aaaa1111', plan: older, progress: olderProgress });
        const newer = expandPlan({ ...base, steps: [{ goal: 'новый', details: '', verify: '' }] });
        const newerProgress = recordStep(createProgress({ id: 'bbbb2222', task: 'одна задача', plan: newer }), {
            index: 0, status: 'incomplete', report: 'обрыв', files: [],
        });
        await saveWork(root, { id: 'bbbb2222', plan: newer, progress: newerProgress });
        const done = expandPlan({ ...base, steps: [{ goal: 'конец', details: '', verify: '' }] });
        const doneProgress = recordStep(createProgress({ id: 'cccc3333', task: 'одна задача', plan: done }), {
            index: 0, status: 'completed', report: 'готово', files: [],
        });
        doneProgress.status = 'completed';
        await saveWork(root, { id: 'cccc3333', plan: done, progress: doneProgress });
        for (const [id, updatedAt] of [['aaaa1111', '2026-10-16T00:00:00.000Z'], ['bbbb2222', '2026-10-16T01:00:00.000Z'], ['cccc3333', '2026-10-16T02:00:00.000Z']]) {
            const file = path.join(root, '.tmp', id, 'progress.json');
            const saved = JSON.parse(await readFile(file, 'utf8'));
            saved.updatedAt = updatedAt;
            await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
        }
        const found = await findResumable(root, 'одна   задача');
        assert.equal(found.id, 'bbbb2222');
        assert.equal(found.plan.steps[0].goal, 'новый');
        const loaded = await loadWork(root, found.id);
        assert.equal(loaded.progress.cursor, 0);
        assert.equal(await findResumable(root, 'другая'), null);
        const latest = await findLatestResumable(root);
        assert.equal(latest.id, 'bbbb2222');
        assert.equal(await findLatestResumable(root, { includeDone: true }).then((work) => work.id), 'bbbb2222');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
