# Handoff chain for `ai run` and `ai gen`

**Date:** 2026-10-15
**Status:** approved for implementation

## Goal

`ai run` and `ai gen` are two names for one command: the same flags, the same positionals, and one team pipeline. After the main request, a first prose answer can go straight to `encoder` or to the existing planner. Large code does not travel inside the next prompt. It is stored under `.tmp/<run>/`, and later roles see a reference. The planner or the encoder chooses the output filename and the language. A local executor writes files with the same approval gate as `write_file`, and reads files or line ranges into the same handoff so the next role receives them.

## Decisions

- Node.js built-in modules only. No new npm dependencies. No new role. The role list stays at 13 names.
- Team mode grows one stage in front of the current planner. The stage is on by default (`agent.chain: true`). `--no-chain` restores today's order: planner, collector, worker, reviewer, summarizer.
- `--single` stays one model and one tool loop. It does not run this chain.
- `ai run` and `ai gen` are two names for one command. They share one parser, one flag set, and one positional grammar. `gen` does not accept a flag `run` rejects, and `run` does not accept a flag `gen` rejects.
- A generation profile is attached when either name has a kind, or when `--fidelity`, `--creativity`, `--platform`, or `--example` is set. `--template` is the task message, not the signal that creates a profile. The profile carries kind (or null), fidelity, creativity, platform, expected output names, and references. Kind rules apply only when kind is set. The fidelity contract stays in the operator instructions, so every later role can read it. When a profile is present, `.ai/generation.json` is written before the model call. With no kind, `outputs` is an empty array.
- The first answer uses the `default` role. It is prose. Its last non-empty line may be `route: encode` or `route: plan`. That line is removed before the text is forwarded.
- Route priority: `--route encoder|planner`, then that label, then a heuristic. The heuristic chooses `encode` when the answer has at least one fenced code block, or a backtick span that is one relative path (no spaces, no `..`, and a dot in the final segment). Otherwise it chooses `plan`. A broken `route:` line is ignored.
- The direct `encode` branch runs its `fs:read` and `fs:write` commands and finishes. Planner, collector, worker, and reviewer are not called.
- The `plan` branch calls the current planner. The planner returns the current plan plus `fileActions`. It does not write files. File actions run after the plan is accepted and before the collector. The rest of the team is unchanged.
- A fence tag and a filename printed next to a block are hints. They are not the output name and not the language. `scan_add.comp` can stay the path while `language` is `glsl`.
- The desktop batch schema stays `batch`. File commands are a second instruction and a second schema, `file_commands`, on the same `encoder` role. The command list allows `fs:write` and `fs:read`. `delegate_role` still requests a desktop batch.
- A read copies the selected lines into a new artifact and adds a reference to the handoff before the next command or the next role. A fragment of 2048 bytes or less is also inlined under that reference. A larger fragment stays in `.tmp` and the handoff keeps the reference only.
- After a JSON file is read, one extra pass collects path mentions from its string values. That pass does not follow mentions inside the files it adds.

## Command surface

`ai run` and `ai gen` call the same handler. Help text lists their flags once, under one heading, including `--route`, `--no-chain`, `--approve`, `--role`, `--single`, `--team`, `--desktop`, `--no-memory`, `--fidelity`, `--creativity`, `--platform`, `--template`, and `--example`. The detach warning about a missing `--approve write|all` is shown for both names.

Positionals are the task words, plus optional stdin and `@file`, for both names. If the first positional is exactly `landing`, `site`, `backend`, or `app`, it is the generation kind and the remaining words are the task. These two lines are the same call:

```text
ai gen landing "страница"
ai run landing "страница"
```

`--kind` sets that same kind on either name. On `ai memory`, `--kind` still selects a memory kind. If `--kind` and the first positional are both generation kinds and they differ, the command exits with a usage error before the model call. A first positional that is a longer phrase, such as `"landing page"`, is not itself the kind token. The whole-word scan below can still select a kind from that phrase.

`ai run "цель"` is a complete invocation. It does not need a generation kind in front of the task. Kind is chosen without a model call: `--kind`, then a first positional that is exactly a kind, then a single whole word `landing`, `site`, `backend`, or `app` inside the task. Two different kind words leave kind unset, and the command stays `run`. `ai run "исправь тест в test/"` has no kind. `ai run "собери landing"` is kind `landing`. `ai run "landing и site"` has no kind. A bare `ai "вопрос"` stays `ask`.

`--file <path>` and `--image <path>` may be repeated and may stand before the task:

```text
ai run --file notes.md --file spec.txt --image layout.png "цель"
```

Order is the order on the command line. Each `--image` is an image part on the first answer. Each `--file` is attached the way attachments work today. A UTF-8 text file within `limits.maxFileReadBytes` is also an artifact in the handoff before the first answer, as a whole-file read. A PDF, a binary file, or a text file over that limit stays an attachment only and does not fail the run. `--example` stays a generation reference. The rest of the global flags (`--out`, `--session`, `--instructions`, budgets, `--detach`, and the others already parsed for every command) keep their current meaning.

`--template <file>` is a UTF-8 message template. It may be repeated and may stand before the task. The files are joined in command order with a blank line between them. With no inline task, that text is the whole task:

```text
ai run --template quest.md
```

With an inline task, each `{{message}}` in the joined template is replaced by that task once, not recursively. When the template has no marker, the inline task is appended after the template. `ai run @task.md` still loads the inline task from a file. A missing template, a directory, or a non-UTF-8 file is a usage error before the model call. `--instructions` remains extra operator text and is not the task.

## Message

Each run has a directory `.tmp/<id>/` inside the working directory. `<id>` is eight hex characters. The directory remains after success and after failure.

`handoff.json` in that directory holds:

- `from` and `to`: `operator`, `answer`, `encoder`, `planner`, or `executor`
- `route`: `encode`, `plan`, or null before the choice
- `text`: the answer with each code fence replaced by one reference line
- `artifacts`: `{ id, rel, hintLanguage, hintPath, bytes, origin, start, end }`
- `commands`: the `fs:read` and `fs:write` list, empty until the encoder or a file action fills it
- `profile`: the generation profile, or null

Artifact ids are `a001`, `a002`, in order of appearance. The stored body is `.tmp/<id>/a001` with no extension. `hintLanguage` is the fence tag, or null. `hintPath` is a filename or relative path from the heading or the paragraph immediately before the fence, when that text contains one such path. Otherwise null. `origin` is the project path a read came from, or null for a fence spilled from the answer. `start` and `end` are 1-based inclusive line numbers, or both null when the artifact is a whole block or a whole file.

The shared context gets two sections. The artifact index has priority 8. The handoff text has priority 5. A fragment of 2048 bytes or less is already inlined in that text. Larger bodies stay in `.tmp`, and a later role can `read_file` that path.

## File commands

`file_commands` is a strict object:

- `summary`: string
- `commands`: array of `fs:read` or `fs:write`

Every command has `command`, `path`, `cwd`, `type` (`code` or `text`), `language`, `content`, `lines`, `source`, `start`, and `end`. `start` and `end` are both null, or both integers with `start` at least 1 and `end` at least `start`.

An `fs:write` uses exactly one of `content` (string), `lines` (array of strings), and `source` (a `.tmp` artifact from this run). Its `start` and `end` are null. The written body is the whole selected text. A line range is not written back into the middle of an existing file.

An `fs:read` leaves `content`, `lines`, and `source` null. Null `start` and `end` mean the whole file. A pair copies only those lines. The executor stores that text as the next artifact and records `origin`, `start`, and `end`. A fragment of 2048 bytes or less is inlined in `text` under its reference line. A larger fragment is referenced only. The read uses `readTextFile` semantics for line bounds: `start` past the end fails the command, and `end` past the end clamps to the last line. The selected text must fit in `limits.maxFileReadBytes` (256 KiB). A larger selection fails the command instead of being silently truncated. Binary files and non-UTF-8 files fail the command.

The encoder and the planner set `path` and `language`. An empty `cwd` means `.`.

When `language` is empty, the executor uses `hintLanguage`, then `text`. An `fs:read` with an empty `path` fails the shape check. When an `fs:write` `path` is empty, the executor uses `hintPath` if it is one relative path, otherwise `snippet-001` and the next numbers in command order. The extension comes from the language: `js`, `mjs`, `html`, `css`, `md`, `json`, `glsl`. Any other language uses `.txt`. This map is only for a missing path. A path the model already set is kept, including an extension that differs from the language.

An `fs:write` for an artifact larger than 2048 bytes must use `source`. A command that inlines that body is invalid.

`cwd` and `path` are joined and must stay inside the working directory. `source` must stay inside `.tmp/<id>/`. The executor reads the body, joins `lines` with `\n`, and writes through `writeTextFile` with the existing `limits.maxFileWriteBytes` (4 MiB). Overwrite follows `write_file`: backup into the run backup directory, then update `.ai/map.json` for that path. The change is recorded as `create` or `overwrite` on the team result, so the summary lists it.

`fs:write` uses approval category `write` and tool name `fs:write`, with the same answers as `write_file` (`yes`, `no`, `always`, `abort`). `fs:read` uses category `read` and is allowed without a prompt, including when the approval level is `read`.

A JSON object or array that was just read is scanned when `JSON.parse` accepts the selected text. Every string value that is one relative path is an extra read. The path has no scheme, no leading slash, no drive letter, and no `..` segment, and its final segment contains a dot. An optional `#start-end` suffix sets the line range. At most 32 mentions are taken, in encounter order. Mentions already present as artifacts are skipped. Files added by this pass are not scanned for further mentions. A mention that cannot be read is skipped. The original read still stands.

`fs:list` reads a directory. `mode` is `tree` (nested names, directories end with `/`) or `list` (one relative path per line). `depth` is 1 to 6 and defaults to 2. Hidden names are omitted. The listing is an artifact: small text is inlined, larger text stays in `.tmp`. A `--file` that is a directory is seeded as a tree. The planner and the encoder both receive a `# Directory tree` of the working directory. A planner `list` action and an encoder `fs:list` command append that tree or list to the handoff before the next role.

A `fileActions` item is `{ action, source, path, cwd, language, reason, start, end, depth, mode }`. `action` is `encode`, `write`, `read`, or `list`. For `encode`, the other fields are null: the encoder chooses names, languages, and ranges, then the executor runs the commands. For `write`, `source` is one artifact path and `path` is the destination. For `read`, `path` is the project file and `start`/`end` select the fragment. An empty `path` or `language` on a write uses the same defaults as a command. Empty `fileActions` means no file work. Items run in order. A later write in the same list may use `source` for an artifact created by an earlier read.

## Flow

1. Either name parses the shared positionals and flags. When a profile is present, `.ai/generation.json` is written and its instructions join the task. The chain then starts.
2. Unless `--no-chain` or `--single`, the `default` role writes the first answer. Attached images and files are passed to that call.
3. On a completed answer, fences are spilled and `handoff.json` is saved. A failed, cancelled, or budget-stopped answer stops the team with that status. Nothing is spilled and nothing is written.
4. The route is chosen. `--route` must be `encoder` or `planner`; anything else is a usage error before the model call.
5. `encode`: the encoder sees the reference text and the artifact index. Invalid JSON from the encoder stops the team as `failed`. A valid list, including an empty list, is checked for shape and then run in order. Reads update the handoff before the next command. `handoff.json` is updated with the commands and the new artifacts. Status is `completed` when the list was empty or every command succeeded. A denial or a rejected batch follows the errors below. The team result text is the answer, the artifact index, and the files written.
6. `plan`: the planner sees the spilled answer and the artifact index. Its `fileActions` run under the same read and write rules, and reads from those actions are in the handoff before the collector. Then collector, worker, reviewer, and summarizer run as they do today and can `read_file` the artifacts.

## Errors

- The shape of a command batch is checked before the first command runs. A write without exactly one body, a `source` outside this run's `.tmp`, a path outside the working directory, only one of `start` and `end` set, an inline body for an artifact over 2048 bytes, or a write over `maxFileWriteBytes` rejects the batch. The shape check does not require a `source` file to exist yet, so an earlier `fs:read` in the same list can create it. Nothing from that batch is read or written. Team status is `failed`.
- A missing file, a binary file, a non-UTF-8 file, a `start` past the end, or a selection over `maxFileReadBytes` stops the remaining commands. Earlier writes stay. Earlier reads stay in the handoff. Team status is `incomplete`.
- A denied approval stops the remaining writes. Writes already accepted in that batch stay. Reads already completed stay. Team status is `incomplete`.
- Approval level `read` denies every `fs:write` without a prompt. If a write was requested, status is `incomplete`.
- `abort` during approval cancels the run.
- The `.tmp/<id>/` directory is left in place.

## Units

| Unit | Responsibility |
| --- | --- |
| `src/agent/handoff.js` | Run directory, spill, route choice, `handoff.json` |
| `src/agent/file-commands.js` | `file_commands` schema, parse, defaults, execute |
| `src/agent/schemas.js` | Plan field `fileActions` |
| `src/roles/planner.js` | One paragraph: `fileActions` may encode, read a fragment, or request a write, and the planner does not write files |
| `src/roles/encoder.js` | File-command instructions beside the desktop batch prompt |
| `src/agent/team.js` | Answer stage, route, file actions, then the current team |
| `src/commands/run.js` | The only team handler. Shared positionals, profile, kind from the goal, `--route`, `--no-chain` |
| `src/commands/gen.js` | Alias: the same handler as `run` |
| `src/cli-help.js` | One flag section for `run` and `gen` |
| `src/core/config-defaults.js` | `agent.chain` defaults to true |
| `src/commands/flags.js` | Map the new flags onto config |

## Tests

`node --test`, no network. Pure cases live in `test/handoff.test.js`. Team cases extend `test/team.test.js` and the existing mock server.

Handoff tests cover spill names without extensions, hint language and hint path, route priority, a broken `route:` line, default language and default `snippet-00N` names, a `.comp` path kept beside language `glsl`, exactly one write body, path escapes, the 2048-byte inline rule, the 4 MiB write limit, approval level `read` allowing `fs:read` and denying `fs:write` without a prompt, a denial stopping later commands, and `.tmp` remaining after success and failure. They also cover a line range stored without the rest of the file, a short fragment inlined in `text`, a long fragment left as a reference, a JSON string `src/app.js#10-20` causing one extra read, a `..` or URL string ignored, and a mention inside that extra file not followed.

Team tests cover the encode branch stopping before the planner, the plan branch showing references rather than bodies, an `encode` action writing through the encoder, a `read` action attaching a fragment before the collector, a `write` action copying one artifact without a second model call, a write in the same list using an artifact created by an earlier read, `--no-chain` starting at the `plan` schema, and a failed answer writing nothing.

Generation tests keep the current fidelity and platform checks. A design starter is passed with `--example` or `--file`, not with `--template`. `ai gen landing "x" --fidelity 90` and `ai run landing "x" --fidelity 90` build the same profile, the same instructions, and the same `.ai/generation.json`. `ai gen --approve write --no-chain --role worker=gpt-6-luna site "x"` is accepted. A positional kind that disagrees with `--kind` is a usage error for both names. `ai memory --kind fact` still uses the memory kind. One case asserts that a generation run sends kind, fidelity, and platform in the first team message. The desktop schema name remains `batch`. The `all=cheap` role count remains 13.

Command-surface tests: `ai run "исправь тест"` has no kind. `ai run "собери landing"` selects kind `landing`. `ai run "landing и site"` has no kind. `ai "что такое landing"` stays `ask`. `ai run --file a.md --file b.txt --image c.png "цель"` keeps both files in order and the image, and the text files are artifacts before the first answer. `ai run --template quest.md` uses the file as the whole task. `ai run --template wrap.md "цель"` replaces `{{message}}` when the file contains that marker, and appends the task when it does not. A directory passed to `--template` is a usage error. `--template` alone does not write `.ai/generation.json`.

## Out of scope

Commands other than `fs:read` and `fs:write`. Writing a line range into the middle of an existing file. Deleting `.tmp` automatically. Sniffing a language from the source text. A JSON5 parser. Following JSON mentions more than one level deep. Changing the desktop batch. A second team or a second flag parser for `ai gen`.
