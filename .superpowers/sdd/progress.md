# SDD progress

Branch: feat/map-and-serve
Base: 53252c726f30fd5b4ad10fcea817590e02305044
Plans: project map, then websocket server

Task 1 (map): complete (commits 53252c7..cb6541f, review clean). Minors: rounded mtime identity; cold one-path update clears imports if re-read fails; crafted map keys with .. are not normalized; later subtests delete util/text.js and widget.py.
Task 2 (map): complete (commits cb6541f..b293147, review clean). Notes: no direct search_files handler test; team mocks omit scope (runtime treats missing as all).
Task 3 (map): complete (commits b293147..e317911, review clean). Minor: replace/delete update path not separately tested.
Task 4 (map): complete (commits e317911..54b37cb, review clean). Minor: format helpers untested.
Task 5 (map): complete (commits 54b37cb..f271c47, review clean). Minor: planner role text does not name taskMap; edit-set variable shadows tool allow-list.

## Global CLI (`docs/superpowers/plans/2026-10-15-global-cli.md`)

Branch: feat/global-cli
Worktree: C:\Projects\Universal-AI\.worktrees\feat-global-cli
Base: 3f0456f0ce1a9706239aecd46e4d56a36439e322

Task 1 (global-cli): complete (commits 3f0456f..c5b4d76, review clean). Minor: manifest test does not spawn `ai --version`; Task 2's launcher test covers that stdout.
Task 2 (global-cli): complete (commits c5b4d76..9500835, review clean). Minors: `test/cli.test.js` grew by the launcher helper; arg passthrough and non-zero exit are not separately tested. Controller checked: task 2 did not touch `bin/ai.js`; `package.json` `files` still includes `bin`; `npm install -g` was not run.
Final review (3f0456f..9500835): With fixes. Plan-mandated conflicts waiting on the user: ai.cmd cwd `node` lookup, ai.ps1 exit 0 when node is missing, ai.ps1 drops pipeline input, test helper breaks on spaces. Also flagged: no cwd/exit-code test, `bin/ai.sh` mode 100644. Minors not blocking: old `npm link` name collision in README, cmd Ctrl+C prompt, spawn error listener.
Fix (9500835..a9cd010): complete, re-review approved. Minors left: quoted PATH entry makes ai.cmd exit 9009; Windows PowerShell 5.1 encodes non-ASCII pipe input as ASCII; no planted node.exe test; missing-node test accepts any non-zero; spaced-path temp dir is a fixed name; plan runLauncher signature and line 19 are slightly stale. Main checkout has untracked copies of the spec, plan, and empty bin launchers that block a checkout of this branch there.
