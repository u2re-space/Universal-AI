# Desktop roles and Windows interact

**Date:** 2026-10-15
**Status:** approved for implementation (approach 1)

## Goal

`ai run` keeps the current team. Role text lives in `src/roles/*.js`. With `--desktop`, the worker and the reviewer can see the Windows screen, click, type, run an AutoHotkey v2 script, and delegate one step to a specialist. An encoder produces a TOON or JSON batch. `src/interact/filesystem.js` is the only process that starts AutoHotkey.

## Decisions

- One command: `ai run`. No `ai desktop` command.
- `--desktop` and `tools.desktop` default to false. They add tools for the worker and the reviewer.
- Specialists: `scanner`, `solver`, `clicker`, `typer`, `encoder`, `tester`. The worker calls them through `delegate_role`. The planner does not assign roles to steps.
- `scanner` decides what to capture. It may return JSON and may compute coordinates. JSON is not required.
- `solver` solves the step: problems, arithmetic, captchas. It does not own the mouse.
- `clicker` clicks. `typer` types into fields.
- `encoder` returns a batch and does not execute it. The batch contains steps, clicks, typing, and an optional AutoHotkey v2 script.
- `tester` checks the result, including the screen.
- `vision` describes images in prose for `view_image`. A screen capture asks `vision` for strict JSON, then the tool shows that JSON to the caller as TOON.
- Click targets: pixel coordinates, window title, control name, or `ImageSearch`. All four are allowed.
- A screenshot is taken after every click, type, and AutoHotkey script when `desktop.shotAfterAction` is true (the default). The `screenshot` tool captures even when that flag is false.
- Mouse, keyboard, and screenshot are short AutoHotkey v2 scripts. `run_ahk` sends a script the model wrote, through the same runner.
- AutoHotkey is v2 only. The executable is `AutoHotkey64.exe`. There is no v1 syntax.
- `filesystem.js` finds that executable, writes a temporary `.ahk`, runs it, and reads a result file plus an optional PNG. Project files stay on `list_files`, `read_file`, and `write_file`.
- Approval uses the existing `--approve` levels. Desktop mutations are category `exec` (same gate as `run_command`). `ask` prompts for each desktop tool call. `all` allows them. `read` and `write` deny them. `delegate_role` is category `read`.
- A `run_batch` call is approved once, and then each action inside it is approved on its own.
- Node.js built-in modules only. No new npm dependencies.
- Desktop execution requires Windows and a resolvable `AutoHotkey64.exe`. Other platforms, and a missing executable, fail with a clear error when a desktop tool runs. Tests inject a fake executable and do not require AutoHotkey.

## Roles

Each file `src/roles/<name>.js` exports `instructions` and `settings`. `src/roles/index.js` builds `ROLE_MODULES`, `ROLE_INSTRUCTIONS`, and `SPECIALISTS`.

Existing instruction strings for `planner`, `collector`, `worker`, `reviewer`, `summarizerMemory`, `summarizerFile`, and `vision` move unchanged, except `worker` and `reviewer` gain one paragraph about desktop tools. `planner` keeps the `{maxSteps}` token. `src/commands/instructions.js` re-exports `ROLE_INSTRUCTIONS`.

New roles use the same settings shape as `roles.default` in `src/core/config.js`.

| Role | Work | Tools when delegated | Effort |
| --- | --- | --- | --- |
| scanner | What to capture; may return coordinates | screenshot | low |
| solver | Solve the step, including math and captchas | screenshot | high |
| clicker | Click | click, screenshot | low |
| typer | Type | type, screenshot | low |
| encoder | Return a batch | screenshot | medium |
| tester | Check the outcome | screenshot | medium |

`delegate_role` accepts only those six names. Specialist tool lists do not include `delegate_role` or `run_batch`.

## Batch

A batch is an object:

- `summary`: non-empty string
- `actions`: array of `screenshot`, `click`, `type`, or `ahk`

Click fields: `mode` is `coord`, `title`, `control`, or `image`. `coord` requires integer `x` and `y`. `title` requires `title`. `control` requires `title` and `control`. `image` requires `image` (a path inside the working directory). Optional `button` is `left`, `right`, or `middle` (default `left`). Optional `clicks` is 1 or 2 (default 1).

Type fields: `mode` is `text` or `keys`, plus non-empty `text`. `text` sends literal characters (`SendText`). `keys` sends an AutoHotkey key string (`Send`).

`ahk` requires non-empty `script` (AutoHotkey v2 statements, not a whole program). The runner wraps every script with `#Requires AutoHotkey v2.0`, a result file, and the screenshot helper.

`parseBatch` accepts a JSON document or a TOON document. TOON here is the subset this repo encodes: objects, primitive arrays, and tabular arrays of uniform objects with primitive cells. `encodeToon` / `decodeDocument` round-trip that subset. Strings that are unsafe bare tokens are JSON-quoted.

The encoder role uses strict JSON schema `batch`. `run_batch` accepts `batch_json`, `batch_toon`, or `path` (exactly one non-empty). `path` is inside the working directory.

## Screen

Screenshots are PNG files under `<working directory>/.ai/desktop/`. The tool result includes the relative path. When a `describeScreen` callback is present, the result also includes TOON of this JSON:

- `summary`: string
- `elements`: `{ name, text, x, y, width, height }` with integer or null coordinates
- `notes`: string

`describeImage` for ordinary files stays prose.

## Tools

Enabled only when `tools.desktop` is true:

| Tool | Category | Behavior |
| --- | --- | --- |
| screenshot | exec | Capture, then optional vision |
| click | exec | One click, then auto-capture |
| type | exec | Type text or keys, then auto-capture |
| run_ahk | exec | Run the wrapped script, then auto-capture |
| run_batch | exec | Parse a batch, approve and run each action |
| delegate_role | read | One specialist call |

`config.desktop.ahkPath` (string or null) overrides discovery. Discovery checks, in order: `desktop.ahkPath`, `%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe`, `%ProgramFiles(x86)%\AutoHotkey\v2\AutoHotkey64.exe`, `%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe`. No `where` lookup.

## Out of scope

- AutoHotkey v1
- A separate desktop command or a fixed scanner-solver-clicker loop inside `team.js`
- File read/write outside the project through AutoHotkey
- Video capture
- Running the encoder batch automatically without `run_batch`
