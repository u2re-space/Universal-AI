# Pace budget implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--speed` and `--quality` share a budget of 200, stable only through a sum of 100, and speed above 100 breaks review, step count, and effort floors without choosing a cheaper model.

**Architecture:** `resolvePace` derives `modelSpeed`, `paceSpeed`, and `modelQuality`, then runs the existing policy, rung, and effort tables on those numbers. A sum above 100 adds a guarantees sentence. Speed above 100 then forces one step, turns review off, and drops the effort floor to `minimal`. Config load and the CLI call the same range check.

**Tech Stack:** Node.js 26 ESM, `node:test`, `node:assert/strict`. No new dependencies.

## Global Constraints

- Defaults stay speed 10 and quality 40.
- `modelQuality = min(quality, 100)`, `modelSpeed = min(100, speed + max(0, quality - 100))`, `paceSpeed = min(speed, 100)`.
- Ceiling uses `modelQuality`. `plannerRung` and `authorRung` use `modelSpeed`. Policy, merge, step cap, review rounds, acceptance tone, and the base effort shift use `paceSpeed` and `modelQuality`.
- Sum ≤ 100 is `steady` and adds no sentence. Sum ≥ 101 with speed ≤ 100 is `strained`. Speed ≥ 101 is `broken`.
- Strained sentence: `Speed and quality together exceed the stable budget. Balance is not promised.`
- Broken sentence: `This pace is past the safe speed. Acceptance criteria are not binding. A step may stop before its plan is finished. Finish the smallest usable slice and stop.`
- Broken override: `reviewMode` `off`, `reviewRounds` 0, `stepCap` 1. A pin or `--max-steps` does not raise that cap. Effort floor is `minimal` for every role. Add −1 to the shift when speed is 101..150 and −2 when speed is 151..200. Do not move a role to a cheaper rung than speed 100 would use.
- Quality message: `pace.quality: целое 0..200, и speed + quality не больше 200`. Speed message: `pace.speed: целое от 0, и speed + quality не больше 200`. Quality is checked first.
- Config prefixes the sentence with `Конфигурация: `. The CLI throws `UsageError` with the sentence. `resolvePace` throws `Error` with the sentence.
- A word `--quality` (`low|medium|high|xhigh|max|auto`) stays image quality.
- `effectiveFidelity` keeps using the raw quality and stays clamped to 0..100. `effectiveFidelity(87, 40)` is 66. `effectiveFidelity(87, 200)` is 100.
- No new run status. The encode route, desktop-specialist effort, and the first-answer model stay as they are.
- There is no negative speed and no quality above 200.

---

## File structure

- Modify `src/agent/pace.js` — budget check, derived axes, guarantees, reckless override.
- Modify `src/agent/team.js` — append the guarantees sentence.
- Modify `src/core/config.js` and `src/commands/flags.js` — call the same check.
- Modify `src/cli-help.js` and `README.md` — the shared budget.
- Modify `test/pace.test.js` and `test/generate.test.js`.

## Task 1: Budget inside resolvePace

**Files:**
- Modify: `src/agent/pace.js`
- Test: `test/pace.test.js`

**Interfaces:**
- Consumes: the existing `policyOf`, `effortShift`, `plannerRung`, `authorRung`, and `ceilingIndex`.
- Produces:
  - `assertPaceBudget(speed: number, quality: number): void` throws `Error` with the speed or quality sentence.
  - `guaranteesParagraph(guarantees: 'steady'|'strained'|'broken'): string` returns `''` for `steady`.
  - `resolvePace` gains `guarantees` on the directive. Illegal pairs throw before a directive is built.

- [ ] **Step 1: Write the failing tests**

Append to `test/pace.test.js`:

```javascript
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
```

Import `guaranteesParagraph` from `../src/agent/pace.js` next to the existing pace imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern "shared budget" test/pace.test.js`

Expected: FAIL. `guarantees` is undefined, or `guaranteesParagraph` is not exported.

- [ ] **Step 3: Derive the axes and apply the reckless override**

Export these constants and functions from `src/agent/pace.js`:

```javascript
export const PACE_QUALITY_MESSAGE = 'pace.quality: целое 0..200, и speed + quality не больше 200';
export const PACE_SPEED_MESSAGE = 'pace.speed: целое от 0, и speed + quality не больше 200';

export function assertPaceBudget(speed, quality) {
    if (!Number.isInteger(quality) || quality < 0 || quality > 200) throw new Error(PACE_QUALITY_MESSAGE);
    if (!Number.isInteger(speed) || speed < 0 || speed + quality > 200) throw new Error(PACE_SPEED_MESSAGE);
}

export function guaranteesParagraph(guarantees) {
    if (guarantees === 'strained') return 'Speed and quality together exceed the stable budget. Balance is not promised.';
    if (guarantees === 'broken') return 'This pace is past the safe speed. Acceptance criteria are not binding. A step may stop before its plan is finished. Finish the smallest usable slice and stop.';
    return '';
}
```

At the start of `resolvePace`, call `assertPaceBudget(speed, quality)` and derive:

```javascript
const modelQuality = Math.min(quality, 100);
const modelSpeed = Math.min(100, speed + Math.max(0, quality - 100));
const paceSpeed = Math.min(speed, 100);
const guarantees = speed + quality <= 100 ? 'steady' : speed <= 100 ? 'strained' : 'broken';
const recklessExtra = speed <= 100 ? 0 : speed <= 150 ? -1 : -2;
```

Pass `paceSpeed` to `policyOf` and to the fast-merge test. Pass `modelQuality` to `ceilingIndex`, `reviewRounds`, and `acceptance`. Pass `modelSpeed` to `plannerRung` and `authorRung`. Pass `paceSpeed`, `modelQuality`, and `recklessExtra` to every `effortFor` call, including `decorate` and the policy `c` synthetic step.

Change `effortFor` to:

```javascript
function effortFor(base, paceSpeed, modelQuality, protect, recklessExtra = 0) {
    const shift = effortShift(paceSpeed, modelQuality) + recklessExtra;
    const floor = recklessExtra < 0 ? 'minimal' : (protect && modelQuality >= 67 && shift < 0 ? 'medium' : 'minimal');
    return applyShift(base, shift, floor);
}
```

`effectiveFidelity` still receives the raw `quality`, not `modelQuality`.

Skip `stepCapOverride` when `guarantees === 'broken'`. After the directive object is built, if `guarantees === 'broken'`, set `reviewMode` to `'off'`, `reviewRounds` to 0, and `stepCap` to 1. Set `directive.guarantees = guarantees` in every return, including the not-ready return. Do not change rungs in that override.

- [ ] **Step 4: Run the pace tests**

Run: `node --test test/pace.test.js`

Expected: PASS, including the existing 0..100 tests and the new budget test.

- [ ] **Step 5: Commit**

```bash
git add src/agent/pace.js test/pace.test.js
git commit -m "Share a 200-point budget between speed and quality"
```

## Task 2: Config and CLI use the same check

**Files:**
- Modify: `src/core/config.js`
- Modify: `src/commands/flags.js`
- Test: `test/generate.test.js`

**Interfaces:**
- Consumes: `assertPaceBudget`, `PACE_QUALITY_MESSAGE`, and `PACE_SPEED_MESSAGE` from Task 1.
- Produces: merged config and integer CLI flags reject the same pairs `resolvePace` rejects. `--quality high` still sets `image.quality`.

- [ ] **Step 1: Write the failing tests**

In the existing test `speed, quality, and pace flags parse and image quality stays a word`, replace the assertion that speed 101 throws `/--speed/` with:

```javascript
assert.equal(overridesFrom({ speed: '150', quality: '50' }, { command: 'run' }).pace.speed, 150);
assert.equal(overridesFrom({ speed: '150', quality: '50' }, { command: 'run' }).pace.quality, 50);
assert.throws(() => overridesFrom({ speed: '-1' }, { command: 'run' }), /pace\.speed/);
assert.throws(() => overridesFrom({ quality: '201' }, { command: 'run' }), /pace\.quality/);
assert.throws(() => overridesFrom({ speed: '100', quality: '101' }, { command: 'run' }), /pace\.speed/);
```

Keep the image-word, `nope`, `image` command, and `serve` assertions. Update the `nope` expectation if the dual-form message changes its range from `0..100` to `0..200`: the pattern should be `/0\.\.200 или low/`.

Add a config test:

```javascript
test('config rejects a pace pair outside the shared budget', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-pace-budget-'));
    const file = path.join(home, 'bad.json');
    const load = (pace) => loadConfig({
        configPath: file,
        env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model', OPENAI_API_KEY: 'sk-test' },
        ensureHome: false,
    });
    try {
        await writeFile(file, JSON.stringify({ pace: { quality: 201 } }));
        await assert.rejects(() => load(), /pace\.quality: целое 0\.\.200/);
        await writeFile(file, JSON.stringify({ pace: { speed: -1 } }));
        await assert.rejects(() => load(), /pace\.speed/);
        await writeFile(file, JSON.stringify({ pace: { speed: 100, quality: 101 } }));
        await assert.rejects(() => load(), /pace\.speed/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern "shared budget|pace pair outside" test/generate.test.js`

Expected: FAIL. Speed 150 is rejected by today's `0..100` check, or quality 201 is not rejected with the new sentence.

- [ ] **Step 3: Replace the old 0..100 checks**

In `src/core/config.js`, import `assertPaceBudget`. Replace the two `pace.speed` / `pace.quality` range failures with:

```javascript
try { assertPaceBudget(c.pace.speed, c.pace.quality); }
catch (error) { fail(error.message); }
```

`fail` already prefixes `Конфигурация: `.

In `src/commands/flags.js`, import `assertPaceBudget`, `PACE_QUALITY_MESSAGE`, and `PACE_SPEED_MESSAGE`. For an integer `--quality` that is not an image word: if `number()` throws, throw `UsageError` with `--quality: 0..200 или low|medium|high|xhigh|max|auto`. If the integer is above 200, throw `UsageError(PACE_QUALITY_MESSAGE)`. `command === 'image'` still throws the image sentence before the budget check. `command === 'serve'` still ignores an integer quality.

For `--speed`, if `number(..., { integer: true, min: 0 })` throws, throw `UsageError(PACE_SPEED_MESSAGE)` instead of `Некорректное значение --speed`. Do not reject speed 150 by itself.

After both flags have been copied onto `o.pace`, when both `speed` and `quality` are present, call `assertPaceBudget` and rethrow `UsageError` with `error.message`. A lone `--speed 250` is checked later by config load against the default quality, and that sum is above 200, so it still fails. Also reject a lone speed above 200 immediately with `PACE_SPEED_MESSAGE`, because quality cannot be negative.

- [ ] **Step 4: Run the flag and config tests**

Run: `node --test --test-name-pattern "speed, quality|pace pair outside|pace defaults" test/generate.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.js src/commands/flags.js test/generate.test.js
git commit -m "Reject pace pairs that spend more than 200"
```

## Task 3: Tell the model, and document the budget

**Files:**
- Modify: `src/agent/team.js`
- Modify: `src/cli-help.js`
- Modify: `README.md`
- Test: `test/team.test.js` and the full suite

**Interfaces:**
- Consumes: `guaranteesParagraph` and `directive.guarantees` from Task 1.
- Produces: the strained or broken sentence on the planner instructions, on the reviewer instructions when a review starts, and on the author step text when guarantees are `broken`.

- [ ] **Step 1: Write the failing team test**

Add to `test/team.test.js`:

```javascript
test('a strained budget tells the planner that balance is not promised', async () => {
    let planner = '';
    script = (body) => {
        const role = roleOf(body);
        if (role === 'classifier') return { text: JSON.stringify({ label: 'normal' }) };
        if (role === 'planner') {
            planner = body.instructions;
            return { text: JSON.stringify({ summary: 's', complexity: 'normal', steps: [{ goal: 'сделать', details: '', verify: '', complexity: 'normal' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: ['видно'], needsReview: false, imageNotes: null, risks: [], fileActions: [], taskMap: [] }) };
        }
        if (role === 'summarizer') return { text: JSON.stringify({ taskSummary: 'ok', memories: [] }) };
        return { text: 'готово' };
    };
    const result = await runTeam({
        client: client(),
        config: { ...baseConfig(), pace: { ...defaults.pace, speed: 60, quality: 60 }, agent: { ...baseConfig().agent, chain: false }, memory: { ...defaults.memory, enabled: false } },
        ledger: createLedger(), task: 'Сделай шаг', root, approvalLevel: 'all', emit: () => {},
    });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.match(planner, /Balance is not promised/);
});
```

`roleOf` already returns `'classifier'` for `task_label` and `'planner'` for `plan`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern "strained budget" test/team.test.js`

Expected: FAIL. The planner instructions do not contain `Balance is not promised`.

- [ ] **Step 3: Append the sentence and update the help**

Import `guaranteesParagraph` in `src/agent/team.js`. Build one string:

```javascript
const paceNotes = [acceptanceParagraph(paced.acceptance), guaranteesParagraph(paced.guarantees)].filter(Boolean).join('\n\n');
```

Use it in the planner instructions and in the reviewer instructions in place of `acceptanceParagraph(paced.acceptance)` alone. Where the author step body is built (`Goal: ${step.goal}...`), append `\n\n${guaranteesParagraph('broken')}` only when `paced?.guarantees === 'broken'`.

In `src/cli-help.js`, replace the speed and quality lines with:

```text
  --speed <0..200>       скорость работы (по умолчанию 10). Сумма со --quality до 100 стабильна. Выше 100 скорость срывает гарантии
  --quality <0..200>     качество работы (по умолчанию 40). Выше 200 и сумма больше 200 — отказ
```

Keep the sentence that a word `--quality` is image quality. In `README.md`, on the speed/quality bullet, add that the two flags share 200, a sum through 100 is the stable zone, and quality above 200 is rejected.

- [ ] **Step 4: Run the full suite**

Run: `node --test --test-timeout=60000 "test/*.test.js"`

Expected: PASS. If the strained test's planner is skipped because policy or chain calls another role first, answer `task_label` before the planner and keep `chain: false`. Do not weaken the sentence assertion.

- [ ] **Step 5: Commit**

```bash
git add src/agent/team.js src/cli-help.js README.md test/team.test.js
git commit -m "Warn when speed and quality leave the stable budget"
```
