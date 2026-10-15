# MCP sources and project generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let the CLI generate a landing, site, backend, or app from references at a recorded fidelity target, using user-defined stdio MCP servers and a Chrome 157 Beta platform profile.

**Architecture:** Pure modules build the platform text, the fidelity contract, and the generation brief. A stdio MCP client turns each user server into strict function tools. `ai gen` writes `.ai/generation.json` and then calls the existing team. `ai mcp` edits the home config and can probe a server without an API key.

**Tech Stack:** Node.js 26, ESM, `node:test`, no npm dependencies.

## Global Constraints

- Node.js built-in modules only. No new npm dependencies.
- Default fidelity is 87. Default creativity is 20. Both are integers 0..100.
- `measured` is null. `method` is `unmeasured`. Do not invent a visual score.
- Default platform id is `chrome-157-beta`. Experimental flags off. Origin trials off. Snapshot date `2026-10-15`. ECMAScript edition 2026, only what Chrome 157 runs without a flag.
- Withhold CSS `random()`, the Chrome 157 origin trials, and anything behind a chrome://flag.
- Profile sources, verbatim: `https://css-tricks.com/`, `https://chromestatus.com/roadmap`, `https://262.ecma-international.org/`, `https://caniuse.com/`.
- MCP transport is stdio only. Client requests protocol `2025-06-18` and accepts `2025-06-18`, `2025-03-26`, `2024-11-05`.
- Tool names match `mcp_<serverId>_<toolName>`, `[A-Za-z0-9_-]`, length at most 64.
- MCP calls are approval category `network`. Resource list and read are category `read`.
- One MCP failure does not abort the run.
- Generated output: no npm, no bundler. Backend and app use `node:http`, ESM, `127.0.0.1`, `PORT` or 3000.
- Landing fixture: `test-gen/landing.png`.
- Do not drop commits already on `main`. Merge this branch with `--no-ff`.
- Source indent is 4 spaces. Each new module has a JSDoc file card.

---

### Task 1: Platform, fidelity, brief

**Files:**
- Create: `src/generate/platform.js`
- Create: `src/generate/fidelity.js`
- Create: `src/generate/brief.js`
- Test: `test/generate.test.js`

**Interfaces:**
- Produces: `resolvePlatform(id = 'chrome-157-beta')`, `platformInstructions(profile)`, `fidelityContract({ fidelity, creativity })`, `buildGenerationBrief({ kind, prompt, fidelity, creativity, platform, references })`, `writeGenerationManifest(root, manifest)`
- `buildGenerationBrief` returns `{ task, instructions, manifest }`
- `manifest.measured === null`, `manifest.method === 'unmeasured'`, `manifest.fidelity === 87` when those defaults are passed
- Kinds: `landing`, `site`, `backend`, `app`
- Landing outputs: `index.html`, `styles.css`
- Site outputs: `index.html`, `styles.css`, `about.html`
- Backend outputs: `server.js`
- App outputs: `server.js`, `public/index.html`, `public/styles.css`

- [x] **Step 1:** Write `test/generate.test.js` for the defaults, the withheld `css-random` entry, the four source URLs, a rejected percent, and a brief that cites `test-gen/landing.png` at 87%.

- [x] **Step 2:** Run `node --test test/generate.test.js` and confirm the new assertions fail because the modules are missing.

- [x] **Step 3:** Implement the three modules. `platformInstructions` must say experimental flags are off and must list every enabled and withheld id from the profile data.

- [x] **Step 4:** Re-run the test and confirm it passes.

- [x] **Step 5:** Commit the modules and the test.

### Task 2: MCP frame, client, session

**Files:**
- Create: `src/mcp/frame.js`
- Create: `src/mcp/client.js`
- Create: `src/mcp/servers.js`
- Create: `src/mcp/session.js`
- Create: `test/helpers/mcp-stdio.js`
- Test: `test/mcp.test.js`

**Interfaces:**
- Produces: `encodeMessage(payload)`, `createFrameParser()`, `connectMcp({ command, args, env, cwd, signal, timeoutMs })`, `normalizeMcpServer(entry)`, `mcpToolName(serverId, toolName)`, `openMcpSources(config, { signal, notify })`
- `connectMcp` resolves after `initialize` and `notifications/initialized`
- `openMcpSources` returns `{ extras, errors, close, describe }`
- Each tool extra is `{ name, description, parameters, category, handler }`
- Tool parameters are a strict object whose only property is `arguments_json`
- `handler` returns `{ output, summary, ok }`

- [x] **Step 1:** Write frame round-trip tests and a stdio fixture that implements `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, and `ping`.

- [x] **Step 2:** Run `node --test test/mcp.test.js` and confirm failure.

- [x] **Step 3:** Implement frame, client, name normalization, and session. A dead server becomes `errors[]` and does not throw from `openMcpSources`.

- [x] **Step 4:** Re-run the test. Call `mcp_demo_echo` through `createToolset` with `arguments_json` and confirm the fixture text comes back.

- [x] **Step 5:** Commit.

### Task 3: Config, tool extras, commands

**Files:**
- Modify: `src/core/config-defaults.js`
- Modify: `src/core/config.js`
- Modify: `src/commands/flags.js`
- Modify: `src/agent/tools.js`
- Modify: `src/agent/team.js`
- Modify: `src/commands/run.js`
- Modify: `src/commands/misc.js`
- Create: `src/commands/gen.js`
- Create: `src/commands/mcp.js`
- Modify: `src/cli.js`
- Modify: `src/cli-help.js`
- Modify: `index.js`
- Modify: `README.md`
- Test: extend `test/generate.test.js` and `test/mcp.test.js`

**Interfaces:**
- Consumes: Task 1 and Task 2 exports
- `defaults.generate = { fidelity: 87, creativity: 20, platform: 'chrome-157-beta' }`
- `defaults.tools.mcp = true`
- `defaults.mcp = { servers: [] }`
- `createToolset({ extras })` adds those tools to `names()`, `definitions()`, and `execute()`
- `ai gen` does not require a new agent loop
- `ai mcp` does not require `OPENAI_API_KEY`
- `redactConfig` replaces MCP env values with `…`

- [x] **Step 1:** Add tests for config defaults, invalid fidelity, invalid server id, `--fidelity 101`, `ai mcp list` without an API key, `ai mcp add` plus `probe`, and `ai gen landing --image <landing.png> --no-memory` against the mock server. The planner input must include `87%` and `chrome-157-beta`. `.ai/generation.json` must keep `measured: null`.

- [x] **Step 2:** Run the new tests and confirm they fail.

- [x] **Step 3:** Wire defaults, validation, flags, extras, team, run, gen, mcp, help, README, and `index.js`.

- [x] **Step 4:** Run `node --test test/generate.test.js test/mcp.test.js` and then `npm test`.

- [x] **Step 5:** Commit.

### Task 4: Merge

- [ ] **Step 1:** Review the branch diff against `main`.

- [ ] **Step 2:** `git checkout main` and `git merge --no-ff feat/mcp-generate`.

- [ ] **Step 3:** Run `npm test` on `main`.
