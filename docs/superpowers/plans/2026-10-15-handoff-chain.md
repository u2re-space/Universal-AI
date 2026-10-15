# Handoff chain implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ai run` and `ai gen` share one team pipeline that spills the first answer into `.tmp`, then routes it to file commands or the existing planner.

**Architecture:** `src/agent/handoff.js` owns the run directory, fence spill, and route choice. `src/agent/file-commands.js` validates and executes `fs:read` / `fs:write`. `src/commands/team-args.js` parses the shared task, kind, and `--template`. `runTeam` grows an answer stage in front of the planner. `ai gen` calls the same `run` handler.

**Tech Stack:** Node.js 26 ESM, `node:test`, no new dependencies.

## Global Constraints

- Node.js built-in modules only. No new npm dependencies. No new role. The role list stays at 13 names.
- `agent.chain` defaults to true. `--no-chain` restores planner → collector → worker → reviewer → summarizer. `--single` does not run the chain.
- `ai run` and `ai gen` share one parser, one flag set, and one positional grammar.
- `--template <file>` is a UTF-8 message template. It is not a generation design reference and it does not by itself write `.ai/generation.json`.
- A generation profile is written when a kind is set or when `--fidelity`, `--creativity`, `--platform`, or `--example` is set. Kind may be null. Then `outputs` is empty.
- Route priority: `--route encoder|planner`, then a final line `route: encode` or `route: plan`, then fences or one backtick path. A broken `route:` line is ignored.
- The direct encode branch runs `fs:read` and `fs:write` and finishes. It does not call planner, collector, worker, or reviewer.
- Filename and language come from the planner or the encoder. Fence tags and nearby names are hints. `.tmp` bodies have no extension.
- An inline write body larger than 2048 bytes is invalid. A fragment of 2048 bytes or less is inlined in the handoff text.
- `fs:read` is approval category `read` (no prompt). `fs:write` is category `write`, same gate as `write_file`.
- JSON mentions are one level deep, at most 32, relative paths only, optional `#start-end`.
- `.tmp/<id>/` remains after success and failure. `<id>` is eight hex characters.
- Desktop batch schema stays `batch`. File commands use schema name `file_commands`.
- A bare `ai "вопрос"` stays `ask`.

---

## File structure

- Create `src/agent/handoff.js` — run directory, spill, route, handoff.json.
- Create `src/agent/file-commands.js` — schema, defaults, execute.
- Create `src/commands/team-args.js` — shared positionals, kind, message template.
- Modify `src/agent/team.js` — answer stage, encode branch, file actions.
- Modify `src/agent/roles.js` — `instructionsOnly`.
- Modify `src/agent/schemas.js` — `fileActions`.
- Modify `src/roles/encoder.js`, `src/roles/planner.js` — prompts.
- Modify `src/commands/run.js`, `src/commands/gen.js`, `src/commands/flags.js`, `src/cli.js`, `src/cli-help.js`.
- Modify `src/core/config-defaults.js`, `src/core/config.js`, `src/generate/brief.js`.
- Test `test/handoff.test.js` and extend `test/team.test.js`, `test/generate.test.js`.

### Task 1: Handoff and file commands

Pure spill, route, template, kind, and command execution. Tests in `test/handoff.test.js`.

### Task 2: Team stage

`runTeam` answers, spills, routes, and either executes file commands or continues into the current planner with `fileActions`.

### Task 3: One command surface

`ai run` and `ai gen` share task parsing, `--template`, `--file`, `--route`, and `--no-chain`. Help and the generation brief follow the spec.
