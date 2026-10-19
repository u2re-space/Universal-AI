# Pace: speed, quality, and effort

**Date:** 2026-10-19
**Status:** approved for planning

## Goal

`ai run` and `ai gen` choose the team shape from two integers and one mode. `--speed` (0..100, default 10) decides how finely the work is split. `--quality` (0..100, default 40) decides how expensive a model may be, how strict acceptance is, and, when a generation contract is written, what the stated fidelity is worth. `--pace auto|a|b|c` (default `auto`) chooses who may turn stages off.

A pure function, `resolvePace` in `src/agent/pace.js`, returns that decision. `runTeam` executes it. The function does not call a model and does not read the clock. A high speed does not promise a short run, and it does not promise the quality bar will be met.

## Non-goals

- `ask`, `chat`, and `--single`. They accept the new flags and do not call `resolvePace`.
- Completion, decisions, moderation, Telegram, image generation as its own command, and the `ai serve` socket. Pace is not a socket field.
- Measuring fidelity. `measured` stays `null` and `method` stays `unmeasured`. Creativity is not scaled.
- Environment variables for speed, quality, or pace.
- A fallback row for `gpt-6-astra`. A missing route fails the role that asked for it, as it does today.
- Retuning the first-answer model (`default`) or restructuring the `encode` route.
- Changing desktop-specialist effort (`scanner`, `solver`, `clicker`, `typer`, `encoder`, `tester`) or the vision effort. On the planner path their models are clamped when the resolved model is on the ladder, above the ceiling, and not pinned. The encode route is not clamped.
- Rewriting a saved plan's steps or its acceptance criteria on resume.

## Language

Sentences this program adds for a model are English. The customer's task stays verbatim. Operator text stays Russian: help, the pace line, the fidelity line, config errors, and the classifier warning.

## Flags and config

`--speed` is an integer 0..100. `--pace` is `auto`, `a`, `b`, or `c`.

`--quality` has two shapes. An integer 0..100 sets pace quality. One of `low`, `medium`, `high`, `xhigh`, `max`, `auto` sets image quality, as it does today. Any other value throws `UsageError` with `--quality: 0..100 или low|medium|high|xhigh|max|auto`. `ai image` rejects an integer and throws `Для image --quality: low | medium | high | xhigh | max | auto`. On every other command an integer is stored and applied only by `runTeam`.

There is no `--max-steps` flag today. `--max-turns` is the tool-loop limit and stays that. This work adds `--max-steps`, an integer of at least 1, stored as `agent.maxSteps`.

`defaults.pace`:

```json
{ "speed": 10, "quality": 40, "mode": "auto", "models": ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"] }
```

`models` is one to eight non-empty unique strings, cheapest first. Whitespace is trimmed. An empty list, a duplicate, a blank entry, or an unknown `pace.*` key fails config load. `pace.pins` in a file fails as an unknown key. A top-level `rolePins` section fails as an unknown section, because the loader writes that object itself after validation.

Config errors:

- `pace.speed: целое 0..100`
- `pace.quality: целое 0..100`
- `pace.mode: auto | a | b | c`
- `pace.models: от 1 до 8 непустых уникальных строк`

`ai config init` writes the `pace` block. It stops writing `agent.maxSteps`, so a new file does not pin the step cap. A file that already contains `agent.maxSteps`, including an old init file whose value is 12, does pin it. Removing the key lets pace choose the cap.

## Pins

`loadConfig` scans the home file, the `--config` file, and the CLI overrides before it validates. It then sets `config.rolePins` to `{ [role]: { model: boolean, effort: boolean } }` and `config.stepCapPinned` to a boolean.

A non-empty `roles.<role>.model` in any of those three sources pins the model. An own `effort` key there pins the effort. Built-in defaults pin nothing. `--role name=model` pins the model. `--role name=model:effort` pins both. `--max-steps`, or an own `agent.maxSteps` key in either file, sets `stepCapPinned`. When both a file and the flag set it, the flag wins, because CLI overrides merge last.

`resolvePace` does not see pins. `applyPins(directive, rolePins)` replaces a role's model or effort when that side is pinned. A pinned model is not clamped. An unpinned model that appears in `pace.models` and sits above the adjusted ceiling is replaced with the ceiling model. A model that is not on the ladder is left as resolved.

## resolvePace

```text
resolvePace({
  speed, quality, mode, models,
  label = null,            // null | 'trivial' | 'normal' | 'complex'
  steps = null,            // null, or [{ complexity, author, files, goal, details, verify }]
  generation = false,
  fidelity = null,         // stated integer, or null when no generation contract is written
  stepCapOverride = null,  // integer when stepCapPinned, else null
  task = '',               // goal of the policy "c" synthetic step
  author = 'worker'        // authorFor's choice for that synthetic step
})
```

`label` and each step `complexity` are `trivial`, `normal`, or `complex`. `author` is `coder`, `writer`, or `worker`, chosen by the existing `authorFor` before the call. Pace does not look at file extensions.

The result is frozen:

- `ready` — false when `label` is null. `runTeam` uses a not-ready result only to place the classifier.
- `policy` — `a`, `b`, or `c` once ready. Not-ready calls still return the policy that does not depend on the label (`b` below speed 10, `a` from 10 to 66). At speed 67 or above in `auto`, a missing label leaves `policy` as `a` and `ready` false. That placeholder must not skip the planner.
- `ceilingIndex`, `ceilingModel` — after the trivial-label drop once the label is known. Before that, the quality ceiling.
- `merge`
- `stepCap`
- `reviewRounds`
- `reviewMode` — `off`, `force`, or `plan`
- `collect` — `off` or `allow`
- `acceptance` — `loose`, `normal`, or `strict`
- `fidelity` — `null`, or `{ stated, effective }`
- `roles` — `{ classifier, planner, collector, reviewer, summarizer }`, each `{ model, effort, rung }`
- `steps` — `null` until the caller passes planner steps, then the merged list. Policy `c` with no saved plan is the exception: call 2 returns one synthetic step. Each item keeps `author`, `complexity`, `rung`, `model`, `effort`, `files`, `goal`, `details`, `verify`.

Three calls from `runTeam`:

1. No label and no steps. Only `roles.classifier` is used.
2. Label known, steps omitted. Policy, stages, caps, fidelity, and the standing roles are final.
3. Label and planner steps. Same as call 2, plus merged `steps`. This call is skipped for policy `c` when there is no saved plan. Call 2 then returns one synthetic step. Its goal is `task`, its complexity is the label, its author is the `author` argument the caller computed with `authorFor`, and its rung is the policy `c` row. A saved plan always takes call 3, and policy `c` does not replace those steps with the synthetic one.

## Policy

`mode` `a`, `b`, or `c` fixes the policy. `auto` uses speed and the label:

| Condition | Policy |
| --- | --- |
| speed 0–9 | `b` |
| speed 10–66 | `a` |
| speed 67–100 and label `trivial` | `c` |
| speed 67–100 and any other known label | `a` (fast A: `merge` true) |

Speed and quality still choose rungs, merge, and effort when the mode is fixed. `--pace b` at speed 90 does not merge and does not let the classifier turn stages off, but a complex step may still sit on the ceiling. `--pace a` at speed 80 and label `trivial` stays ordinary trivial A: the planner runs, and fast A does not apply. `--pace c` is one author even when the label is `complex`.

Fast A is policy `a`, speed at least 67, and a label other than `trivial`.

## Model rungs

Ceiling index for a ladder of length `n`:

`min(n - 1, floor(quality * n / 100))`

On the default ladder that is index 0 for quality 0–33, index 1 for 34–66, and index 2 for 67–100. Quality 40 is `gpt-6.1-sol`. `gpt-6-astra` opens at 67. Quality 100 stays on the last rung.

A `trivial` label lowers that index by one, not below 0. `normal` and `complex` leave it. No role is placed above the adjusted ceiling.

| Role | Rung |
| --- | --- |
| Classifier, collector | 0 |
| Summarizer | 0, unless its model is pinned |
| Planner, label `trivial` | 0 |
| Planner, speed ≥ 67 | adjusted ceiling |
| Planner, otherwise | `min(adjusted, 1)` |
| Author step `trivial` | 0 |
| Author step `normal`, speed ≥ 67 | `min(adjusted, 1)` |
| Author step `normal`, otherwise | 0 |
| Author step `complex`, speed ≥ 67 | adjusted ceiling |
| Author step `complex`, otherwise | one below the adjusted ceiling, not below 0 |
| Reviewer, quality ≥ 67 | adjusted ceiling |
| Reviewer, otherwise | `min(adjusted, 1)` |
| Policy `c` single author, label `trivial` | 0 |
| Policy `c` single author, label `normal` | `min(adjusted, 1)` |
| Policy `c` single author, label `complex` | adjusted ceiling |

The policy `c` author uses the label, not speed. A missing step `complexity` uses the plan's complexity. At speed 10 and quality 40 a complex author stays on `gpt-6-luna`. The current coder tier sends that step to `gpt-6.1-sol`. The team path stops calling `coderChoice` and `writerChoice`. Those functions and their tests stay.

On the planner path, desktop specialists and vision keep their resolved model when it is pinned, off the ladder, or on the ladder at or below the adjusted ceiling. Otherwise the resolved model becomes the ceiling model. Their effort is unchanged. The encode route does not clamp them.

## Effort

The effort scale pace uses, from low to high, is `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Pace never selects `none`.

Base effort, before the shift:

| Role | Base |
| --- | --- |
| Classifier, collector, summarizer | `low` |
| Author `trivial` / `normal` / `complex` | `low` / `medium` / `high` |
| Planner on rung 0 | `medium` |
| Planner on a higher rung | `high` |
| Reviewer, quality ≤ 66 | `medium` |
| Reviewer, quality ≥ 67 | `high` |

The shift is added to that index and then clamped.

| speed | quality 0–33 | quality 34–66 | quality 67–100 |
| --- | --- | --- | --- |
| 0–9 | 0 | +1 | +1 |
| 10–66 | 0 | 0 | 0 |
| 67–83 | −1 | −1 | 0 |
| 84–100 | −2 | −1 | −1 |

The index cannot go below `minimal` or above `max`. When quality is at least 67 and the shift is negative, planner, reviewer, and a complex author stop at `medium`. Other roles may land on `minimal`. A positive shift does not raise a role that was already at `max`.

Locked results:

| speed | quality | Role | Result |
| --- | --- | --- | --- |
| 10 | 40 | planner on `gpt-6.1-sol` | `high` |
| 5 | 50 | planner on the second rung | `xhigh` |
| 90 | 20 | complex author | `low` |
| 90 | 80 | planner | `medium` |
| 70 | 80 | planner | `high` |
| 100 | 10 | trivial author | `minimal` |
| 5 | 20 | planner on the bottom rung | `medium` |

A pinned effort replaces this result. The pace line does not claim a duration or a quality score.

## Stages and step caps

Caps are listed as ordinary run / generation. For policies A and B, `stepCapOverride` replaces that cap when it is an integer. Policy C stays at one step. The built-in `agent.maxSteps` of 12 does not replace a pace cap. Policy B may therefore ask for 16 steps. `planLimit` takes the directive cap and does not apply its generation ceiling of 4 on top. A generation run whose pace cap is 8 stays at 8.

Review rounds from quality, on every team run: 0–33 gives 0, 34–66 gives 1, 67–100 gives 2.

| Shape | Collect | Review | Merge | Cap (run / gen) |
| --- | --- | --- | --- | --- |
| B | `allow` | `plan` | no | 16 / 8 |
| A, speed ≤ 66, label `trivial` | `off` | `off` | no | 4 / 2 |
| A, speed ≤ 66, other label | `allow` | `force` | no | 12 / 4 |
| Fast A, label `normal` | `off` | `force` | yes | 4 / 2 |
| Fast A, label `complex` | `off` | `force` | yes | 2 / 1 |
| C, no saved plan | `off` | `off` | already one step | 1 / 1 |

The stage table uses the resolved policy and the numeric speed, including when `--pace` skipped the `auto` band. `--pace a` at speed 5 is ordinary A, not B.

`allow` still uses today's collector check: files of interest, search queries, questions, or read/edit marks. An empty brief does not start the collector. `force` reviews up to `reviewRounds` and ignores `needsReview`. `plan` reviews only when `needsReview` is true, the plan complexity is not `trivial`, and `reviewRounds` is greater than 0. `force` with 0 rounds does not start the reviewer. Policy A reads the classifier label for these gates, not the plan complexity. A trivial label and a later complex step still skip review in policy A. The criterion counts below are instructions to the planner. The runtime does not delete extra criteria the model returns.

The planner is told `stepCap` through the existing `{maxSteps}` placeholder. `expandPlan` uses the same cap and still runs before merge, so the planner can keep one file per step and the runtime folds steps afterwards.

## Merge

`mergeSteps` is pure and runs in call 3 when `merge` is true. It folds adjacent steps that share both author and rung. Goal, details, and verify are joined with a blank line, in order. Complexity becomes the higher of `trivial` < `normal` < `complex`. Files are the union, first-seen order kept. A compatibility step stays alone when its author or rung differs. Merge runs once, before the plan is saved. Resume does not merge again.

## Fidelity

Only when the caller passes a stated fidelity, which is when a generation contract is already being written. One function, `effectiveFidelity(stated, quality)` in `src/generate/fidelity.js`, is used by the brief and by pace:

`Math.round(stated * (600 + quality * 4) / 1000)`

The result is clamped to 0..100. Quality 0 turns 100 into 60. Quality 40 turns 100 into 76 and the default 87 into 66. Quality 100 leaves 100. Creativity is copied through unchanged.

`.ai/generation.json` keeps `fidelity` as the stated integer and adds `effectiveFidelity`. `measured` and `method` stay as they are. The task and `fidelityInstructions` tell the model the working target. One English line sits with them: `Requested fidelity 87% at quality 40 works as 66%.` When the two numbers differ, the operator line is `точность 87% · рабочая 66%`. When they are equal it stays `точность 87%`.

## Acceptance

The tone follows the same quality bands as the review rounds, on every team run, including runs with no generation contract.

- `loose` (quality 0–33). The planner writes at most three criteria. Each one is an observable result. The reviewer accepts when the main goal is met. Polish, extra files, and weak tests are not high severity.
- `normal` (quality 34–66). At most six criteria. The reviewer sends the work back for a high-severity issue and lets cosmetic issues pass.
- `strict` (quality 67–100). At most eight criteria. Edge cases and checks are in scope. Accept only when the goal is met and no high-severity issue remains.

`acceptanceParagraph(tone)` returns that English paragraph. `runTeam` appends it to the planner instructions and, when a review starts, to the reviewer instructions. It does not rewrite `src/roles/planner.js` beyond one sentence: each step includes its own `complexity` of `trivial`, `normal`, or `complex`. The plan schema makes that field required. A step a saved plan lacks gets the plan complexity when it is loaded.

## Run sequence

`run` and `gen` pass the flags through `overridesFrom`. The generation brief is built first, so its working fidelity matches pace before the team starts.

When a saved plan exists, the classifier does not run. The label is the plan's complexity. Otherwise `runTeam` calls pace, runs the classifier, and calls pace again.

The classifier is a new role, `classifier`, with no tools and one turn. Its schema is `{ "label": "trivial" | "normal" | "complex" }` with every property required and extras rejected. The prompt is:

`Classify this task as trivial, normal, or complex. trivial: one obvious change or a question answered from one place. normal: a few files or one clear feature. complex: several parts, a design, or more than one system. Reply in JSON only.`

The call receives the task text and no image parts. Its model and effort come from call 1, then pins.

After the label is known, one Russian line is emitted:

`Темп: speed 10 · quality 40 · политика A · потолок gpt-6.1-sol`

The letter is the policy in upper case. The ceiling model is the adjusted one. `ai config show` prints `rolePins` and `stepCapPinned` because they belong to the resolved config.

The first-answer chain still runs first when `agent.chain` is on. An `encode` route keeps today's models, efforts, and stages. Pace does not classify, clamp, or merge on that route. When there is no chain, or the chain routes to the planner, pace runs. Policy `c` with no saved plan substitutes the single author for the planner. A saved plan is never substituted away.

Policy `c` without a saved plan does not run the planner, the collector, or the reviewer. The single author uses the policy `c` rung. Summarizer still runs when memory auto-save is on, on the bottom rung unless pinned, with its shifted effort.

Standing roles take their model and effort from the directive after pins. A fix round uses the author and the highest step complexity among the steps. An operator revision uses `authorFor` on the revision text and the plan complexity.

## Resume

Pace is computed again from the current flags. Saved steps and saved criteria stay. Review tone and review rounds come from the current quality and the recomputed policy. Policy `c` does not discard a saved plan: remaining steps still run, and review stays off because policy `c` says so. The classifier stays skipped.

## Failures

Cancellation and budget stop the run, including when they happen on the classifier. Any other classifier miss — bad JSON, an unknown label, an incomplete turn, or a failed request — emits `Метка задачи не распознана, взята normal.` and continues with `normal`. The same failure on any later role still stops the run.

## Files

- `src/agent/pace.js` — `resolvePace`, `mergeSteps`, `applyPins`, `acceptanceParagraph`, `effective` effort helpers.
- `src/generate/fidelity.js` — `effectiveFidelity`.
- `src/generate/brief.js` — manifest field and the two fidelity sentences.
- `src/roles/classifier.js` — prompt and settings. Registered in `src/roles/index.js` and `defaults.roles`.
- `src/agent/schemas.js` — classifier schema, and required `complexity` on each plan step.
- `src/agent/team.js` — the three calls, stage gates, and the pace line.
- `src/agent/step-budget.js` — when the caller supplies a pace cap, `planLimit` returns that cap (at least 1) and does not apply the generation ceiling of 4.
- `src/core/config-defaults.js`, `src/core/config.js` — the block, validation, and pin scan.
- `src/commands/flags.js`, `src/cli.js`, `src/cli-help.js` — the three flags and `--max-steps`.
- `src/commands/misc.js` — init template.
- `src/commands/run.js` — the fidelity line when the two percents differ.
- `README.md` — the same three flags next to the existing run/gen flags.

`index.js` exports nothing new.

## Tests

`node --test` stays the runner. No new dependencies.

`test/pace.test.js` locks the policy table, the ceiling formula, the trivial drop, every rung row, the effort rows in the locked table, stage gates, caps, merge order, and `effectiveFidelity(87, 40) === 66`.

Config and flag tests cover the `pace` block, a duplicate model, a pinned role from a fixture file, `--quality 40` beside `--quality high`, an integer `--quality` rejected for `ai image`, and `--pace` outside `auto|a|b|c`.

`test/generate.test.js` expects `effectiveFidelity` 66 when fidelity is 87 and quality is 40, and expects the working percent in the planner text.

Two team tests use the existing fake server. With classifier label `trivial` at speed 10, the reviewer is not called. With `--pace c`, the planner is not called. Harnesses that dispatch on role answer `classifier` with `{ "label": "normal" }` unless the test wants another label. The first model call on a fresh team run is the classifier, not the planner.

Planner JSON in tests gains `complexity` on each step. `overridesFrom({ role: ['all=cheap'] })` grows from 15 roles to 16 because `classifier` is a role. `coderChoice` and `writerChoice` tests stay on the old tiers.
