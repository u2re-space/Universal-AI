# Pace budget: speed and quality share 200

**Date:** 2026-10-19
**Status:** approved for planning

This amends `docs/superpowers/specs/2026-10-19-pace-design.md`. The policy table, rung table, and effort-shift table in that spec stay as they are. They now receive derived inputs. Defaults stay speed 10 and quality 40.

## Goal

`--speed` and `--quality` share a budget of 200. A sum up to 100 is the stable zone and uses today's tables unchanged. A sum from 101 to 200 still runs. `speed` above 100 runs and then breaks the guarantees. `quality` above 200, `speed` below 0, or a sum above 200 does not run.

`speed` 0 with `quality` 200 selects the same models as `speed` 100 with `quality` 100. It does not take the speed priority. The run spends the expensive models on many steps.

## Non-goals

- A new run status. "A step may stop early" is an instruction to the model.
- Negative speed, or quality above 200, as a supported mode.
- Changing image `--quality` words (`low|medium|high|xhigh|max|auto`).
- Changing the encode route, desktop-specialist effort, or the first-answer model.
- A measured fidelity score. `effectiveFidelity` still uses the raw quality and stays clamped to 0..100.

## Validation

The same check runs in `resolvePace`, in config load, and in `--speed` / integer `--quality`. The first failing rule wins:

1. `quality` is not an integer 0..200 → `pace.quality: целое 0..200, и speed + quality не больше 200`
2. `speed` is not an integer 0 or greater, or `speed + quality` is greater than 200 → `pace.speed: целое от 0, и speed + quality не больше 200`

Config load prefixes that sentence with `Конфигурация: ` as it does for every other config error. The CLI throws `UsageError` with the sentence itself. `resolvePace` throws `Error` with the sentence itself. A word `--quality` still sets image quality and does not enter this check.

`speed` 200 with `quality` 0 is valid. `speed` 0 with `quality` 200 is valid. `speed` 150 with `quality` 50 is valid. `speed` 100 with `quality` 101 is not.

## Derived inputs

```text
modelQuality = min(quality, 100)
modelSpeed   = min(100, speed + max(0, quality - 100))
paceSpeed    = min(speed, 100)
```

The ceiling index uses `modelQuality` in place of quality. `plannerRung` and `authorRung` use `modelSpeed` in place of speed. Policy, merge, the step cap, review rounds, the acceptance tone, and the base effort shift use `paceSpeed` and `modelQuality`.

Review rounds and the acceptance tone therefore treat quality 200 like quality 100: two rounds and `strict`, unless the reckless override below turns review off.

## Zones

`guarantees` is `steady`, `strained`, or `broken`.

| Condition | guarantees |
| --- | --- |
| `speed + quality` ≤ 100 | `steady` |
| sum ≥ 101 and `speed` ≤ 100 | `strained` |
| `speed` ≥ 101 | `broken` |

`steady` adds no sentence. The other two append one English sentence after the acceptance paragraph on the planner, and on the reviewer when a review starts.

- `strained`: `Speed and quality together exceed the stable budget. Balance is not promised.`
- `broken`: `This pace is past the safe speed. Acceptance criteria are not binding. A step may stop before its plan is finished. Finish the smallest usable slice and stop.`

The broken sentence is also appended to the author step text. The reviewer does not run in that zone, so it does not receive a copy.

## Reckless override

When `speed` is greater than 100, `resolvePace` first builds the directive as if speed were `paceSpeed` (100). It then applies all of the following:

- `reviewMode` is `off` and `reviewRounds` is 0.
- `stepCap` is 1. `--max-steps` and a pinned `agent.maxSteps` do not raise it back up.
- The effort floor is `minimal` for every role, including planner, reviewer, and a complex author.
- On top of the shift already computed for `paceSpeed` 100 and `modelQuality`, add −1 when speed is 101..150 and −2 when speed is 151..200.
- Models stay at the rungs chosen for `paceSpeed` 100 and `modelQuality`. Reckless speed does not move a role to a cheaper rung.

`strained` does not change rungs, review, the step cap, or the effort floor. It only adds its sentence.

## Locked results

Label `normal`, ladder `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`.

| speed | quality | Ceiling | Policy shape | Planner effort | guarantees |
| --- | --- | --- | --- | --- | --- |
| 10 | 40 | `gpt-6.1-sol` | A, cap 12, review on | `high` | `steady` |
| 0 | 200 | `gpt-6-astra` | B, cap 16, review on | `xhigh` | `strained` |
| 100 | 100 | `gpt-6-astra` | fast A, merge on | `medium` | `strained` |
| 180 | 20 | `gpt-6-luna` | computed as speed 100, then one step and review off | `minimal` | `broken` |

At 0/200 a complex author is also on `gpt-6-astra`. At 100/100 that author is on `gpt-6-astra` as well. At 180/20 the ceiling is the bottom rung, the same ceiling speed 100 would have at quality 20, and the reckless shift takes the planner from `medium` down to `minimal`.

`effectiveFidelity(87, 40)` stays 66. `effectiveFidelity(87, 200)` is 100 because the raw quality is used and the result is clamped at 100.

## Files

- `src/agent/pace.js` — derived inputs, `guarantees`, the reckless override, `guaranteesParagraph`, and the shared range check.
- `src/agent/team.js` — append the guarantees sentence to the planner, the reviewer, and, when broken, the author step.
- `src/core/config.js`, `src/commands/flags.js` — the new bounds. Help in `src/cli-help.js` and `README.md` says speed and quality share 200, quality stops at 200, and a sum above 100 is no longer the stable zone.

## Tests

`test/pace.test.js` locks the four rows above, plus rejection of speed −1, quality 201, and speed 100 with quality 101. Existing 0..100 assertions stay. `test/generate.test.js` locks the same three rejections on the CLI and on config load, and still accepts `--quality high` as image quality.
