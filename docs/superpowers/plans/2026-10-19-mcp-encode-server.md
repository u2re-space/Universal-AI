# MCP Encode Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host an MCP server inside `ai run`, `ai gen`, and `ai chat` so the file-encoder role executes that server instead of calling the encoder model.

**Architecture:** `agent.encode: mcp` binds one localhost HTTP server. Streamable HTTP at `/mcp` exposes eight tools plus `encode`. The same port's WebSocket is a process-wide claim registry. `encodeHandoff` still opens the encoder stage, then calls `encodeArtifacts` and does not call the encoder model. `encoder` leaves today's model and `executeFileCommands` in place.

**Tech Stack:** Node.js 26 ESM, type stripping for `.ts`, `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `zod` 4, `node:test`, `node:http`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-19-mcp-encode-server-design.md`.
- `agent.encode` is `encoder` or `mcp`. Default `encoder`. Any other value fails with `agent.encode: encoder | mcp` and exit code 2.
- Listen on `127.0.0.1` only. No token. No stdio listener. Bind failure exits 2 with `Не удалось открыть MCP-сервер: <message>` before the command works.
- Stderr prints, once, `MCP: http://127.0.0.1:<port>/mcp` and `Processing: ws://127.0.0.1:<port>`.
- Only `src/encode/server.ts` imports `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, or `zod`. No `tsc` build. `.ts` files use erasable syntax only.
- Eight tool names: `list_files`, `read_file`, `search_files`, `write_file`, `replace_text`, `delete_file`, `run_command`, `run_script`.
- A held name runs on the holder. An unheld name runs on Node. `decide` still runs before a write, delete, or command.
- `encode` writes an artifact body to one in-root `hintPath`. A bad hint fails before any write. A later write failure does not return `written`. Earlier files stay.
- While the listener is up, the encoder stage does not call `roles.run('encoder')` or `executeFileCommands`. A failed `encode` fails the stage. The desktop encoder is unchanged.
- Do not mount this listener inside `ai serve`.
- Claim frames match the processing spec except `processing.claim` has no `runId`.

---

## File structure

- Create `src/encode/encode.ts` — hint-path writer. No SDK.
- Create `src/encode/registry.js` — one process registry and its WebSocket frames. No model and no filesystem.
- Create `src/encode/server.ts` — Streamable HTTP tools. The only SDK importer.
- Create `src/encode/host.js` — start and close the listener, dynamic-import the TypeScript modules, build `processTool`.
- Modify `src/core/config-defaults.js`, `src/core/config.js` — `agent.encode`.
- Modify `src/commands/run.js`, `src/commands/chat.js`, `src/agent/team.js` — start the host and make the encoder stage the executor.
- Modify `README.md` — the switch and the two stderr lines.
- Create `test/encode.test.js`, `test/encode-registry.test.js`, `test/encode-server.test.js`.
- Modify `test/core.test.js` or `test/env.test.js` for the config error, and `test/team.test.js` for the encoder stage.

### Task 1: Configuration switch

**Files:**
- Modify: `src/core/config-defaults.js`
- Modify: `src/core/config.js`
- Test: `test/core.test.js`

**Interfaces:**
- Consumes: `defaults.agent`, `loadConfig` validation.
- Produces: `defaults.agent.encode === 'encoder'`. `loadConfig` rejects any other string with `agent.encode: encoder | mcp`.

- [ ] **Step 1: Write the failing test**

In `test/core.test.js`, next to the existing `agent.route` rejection, add:

```javascript
test('agent.encode accepts encoder or mcp and rejects anything else', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-encode-cfg-'));
    try {
        const config = await loadConfig({ home, env: { AI_AGENT_HOME: home }, ensureHome: false });
        assert.equal(config.agent.encode, 'encoder');
        await writeFile(path.join(home, 'config.json'), JSON.stringify({ agent: { encode: 'mcp' } }));
        const mcp = await loadConfig({ home, env: { AI_AGENT_HOME: home }, ensureHome: false });
        assert.equal(mcp.agent.encode, 'mcp');
        await writeFile(path.join(home, 'config.json'), JSON.stringify({ agent: { encode: 'nope' } }));
        await assert.rejects(
            loadConfig({ home, env: { AI_AGENT_HOME: home }, ensureHome: false }),
            /agent\.encode: encoder \| mcp/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
```

Use the imports already in that file. `loadConfig` is exported from `src/core/config.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 --test-name-pattern "agent.encode accepts" test/core.test.js`

Expected: FAIL because `config.agent.encode` is undefined.

- [ ] **Step 3: Implement the switch**

In `defaults.agent`, after `route`:

```javascript
        encode: 'encoder',              // encoder (file-command model) | mcp (this process hosts the encode server)
```

In `src/core/config.js`, after the `agent.route` check:

```javascript
    if (!['encoder', 'mcp'].includes(c.agent.encode)) fail('agent.encode: encoder | mcp');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 --test-name-pattern "agent.encode accepts" test/core.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/config-defaults.js src/core/config.js test/core.test.js
git commit -m "$(cat <<'EOF'
feat: add agent.encode switch

EOF
)"
```

### Task 2: Hint-path writer

**Files:**
- Create: `src/encode/encode.ts`
- Create: `test/encode.test.js`

**Interfaces:**
- Consumes: `resolveInside` from `src/agent/paths.js`.
- Produces: `encodeArtifacts({ root, text, artifacts, workspace, directoryTree, writeFile }) => Promise<{ written: string[] }>`. `writeFile(path: string, content: string)` is called only after the hint is accepted. A throw from `writeFile` rejects the promise. `text`, `workspace`, and `directoryTree` are accepted and not interpreted.

- [ ] **Step 1: Write the failing test**

Create `test/encode.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { encodeArtifacts } from '../src/encode/encode.ts';

async function rootFor() {
    return mkdtemp(path.join(os.tmpdir(), 'ai-encode-'));
}

test('encode writes one hinted artifact and rejects a bad hint before writing', async () => {
    const root = await rootFor();
    const disk = new Map();
    const writeFile = async (file, content) => { disk.set(file, content); };
    try {
        const ok = await encodeArtifacts({
            root, text: 'answer', workspace: '', directoryTree: '.',
            artifacts: [{ id: 'a001', body: 'hello\n', hintLanguage: 'js', hintPath: 'src/a.js' }],
            writeFile,
        });
        assert.deepEqual(ok.written, ['src/a.js']);
        assert.equal(disk.get('src/a.js'), 'hello\n');
        disk.clear();
        await assert.rejects(encodeArtifacts({
            root, text: '', workspace: '', directoryTree: '.',
            artifacts: [{ id: 'a001', body: 'x', hintLanguage: null, hintPath: null }],
            writeFile,
        }));
        await assert.rejects(encodeArtifacts({
            root, text: '', workspace: '', directoryTree: '.',
            artifacts: [{ id: 'a001', body: 'x', hintLanguage: null, hintPath: '../out.js' }],
            writeFile,
        }));
        assert.equal(disk.size, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('encode keeps an earlier file when a later write throws and does not return written', async () => {
    const root = await rootFor();
    let calls = 0;
    const writeFile = async (file, content) => {
        calls += 1;
        if (calls === 2) throw new Error('holder refused');
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(root, file), content));
    };
    try {
        await assert.rejects(encodeArtifacts({
            root, text: '', workspace: '', directoryTree: '.',
            artifacts: [
                { id: 'a001', body: 'one', hintLanguage: null, hintPath: 'one.txt' },
                { id: 'a002', body: 'two', hintLanguage: null, hintPath: 'two.txt' },
            ],
            writeFile,
        }), /holder refused/);
        assert.equal(await readFile(path.join(root, 'one.txt'), 'utf8'), 'one');
        assert.equal(await stat(path.join(root, 'two.txt')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('encode sends the write to the provided holder', async () => {
    const root = await rootFor();
    const seen = [];
    try {
        const result = await encodeArtifacts({
            root, text: 't', workspace: 'scan', directoryTree: 'tree',
            artifacts: [{ id: 'a001', body: 'body', hintLanguage: 'md', hintPath: 'note.md' }],
            writeFile: async (file, content) => { seen.push([file, content]); },
        });
        assert.deepEqual(result.written, ['note.md']);
        assert.deepEqual(seen, [['note.md', 'body']]);
        assert.equal(await stat(path.join(root, 'note.md')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/encode.test.js`

Expected: FAIL because `src/encode/encode.ts` does not exist.

- [ ] **Step 3: Implement the writer**

Create `src/encode/encode.ts`:

```typescript
import { resolveInside } from '../agent/paths.js';

export type EncodeArtifact = {
    id: string;
    body: string;
    hintLanguage: string | null;
    hintPath: string | null;
};

export async function encodeArtifacts(input: {
    root: string;
    text: string;
    artifacts: EncodeArtifact[];
    workspace: string;
    directoryTree: string;
    writeFile: (file: string, content: string) => Promise<void>;
}): Promise<{ written: string[] }> {
    const accepted: Array<{ path: string; body: string }> = [];
    for (const artifact of input.artifacts) {
        const hint = artifact.hintPath;
        if (typeof hint !== 'string' || !hint.trim()) throw new Error('Нет пути-подсказки для артефакта.');
        const { rel } = await resolveInside(input.root, hint, { forWrite: true, allowRoot: false });
        if (!rel || rel === '.backup' || rel.startsWith('.backup/')) throw new Error(`Путь вне записи: ${hint}`);
        accepted.push({ path: rel, body: artifact.body });
    }
    const written: string[] = [];
    for (const item of accepted) {
        await input.writeFile(item.path, item.body);
        written.push(item.path);
    }
    return { written };
}
```

The path check loop finishes before `writeFile`. A throw from `writeFile` rejects after the files already written by earlier iterations remain. `text`, `workspace`, and `directoryTree` are part of the contract and are not read.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/encode.test.js`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/encode/encode.ts test/encode.test.js
git commit -m "$(cat <<'EOF'
feat: write encode artifacts to hint paths

EOF
)"
```

### Task 3: Process registry

**Files:**
- Create: `src/encode/registry.js`
- Create: `test/encode-registry.test.js`

**Interfaces:**
- Consumes: `listenProtocol` from `src/server/protocol.js`.
- Produces: `createProcessRegistry()`. `listen()` returns `{ url, port, close }`. `requestTool(name, args, signal)` returns `null` when the name is free, or `{ output, summary, changes }` when a holder answers. Frames: `hello`, `processing.claim` without `runId`, `processing.claimed`, `processing.released`, `processing.held`, `tool.request`, `tool.result`. The eight names are the only claimable names. Empty `tools` releases that socket. A repeated claim replaces that socket's set. Stealing a name keeps an in-flight `requestId` on the old socket. Holder disconnect fails in-flight calls with `Держатель инструмента отключился.`

- [ ] **Step 1: Write the failing test**

Create `test/encode-registry.test.js` using the same in-memory socket style as `test/hub.test.js` if `createProcessRegistry` accepts an injected socket pair. Also test one real `listenProtocol` upgrade is not required here: call `registry.connect` / `registry.receive` the way `createHub` does, and add `requestTool`.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessRegistry } from '../src/encode/registry.js';

function pair() {
    const frames = [];
    return { frames, send(frame) { frames.push(frame); }, close() {} };
}

test('a client claims write_file and the next call waits on that socket', async () => {
    const registry = createProcessRegistry({ createId: (() => { let n = 0; return () => `id${++n}`; })() });
    const owner = pair();
    const socket = registry.connect(owner);
    await registry.receive(socket, { type: 'hello' });
    await registry.receive(socket, { type: 'processing.claim', tools: ['write_file', 'read_file'] });
    assert.deepEqual(owner.frames.find((frame) => frame.type === 'processing.claimed').tools, ['write_file', 'read_file']);
    assert.equal(await registry.requestTool('run_command', { command: 'echo' }), null);
    const pending = registry.requestTool('write_file', { path: 'a.js', content: 'x' });
    const request = owner.frames.find((frame) => frame.type === 'tool.request');
    assert.equal(request.name, 'write_file');
    await registry.receive(socket, { type: 'tool.result', requestId: request.requestId, output: 'записан', summary: '+ a.js' });
    assert.deepEqual(await pending, { output: 'записан', summary: '+ a.js', changes: [] });
});

test('an empty claim releases names and a bad name changes nothing', async () => {
    const registry = createProcessRegistry({ createId: () => 'id' });
    const owner = pair();
    const socket = registry.connect(owner);
    await registry.receive(socket, { type: 'hello' });
    await registry.receive(socket, { type: 'processing.claim', tools: ['read_file'] });
    await registry.receive(socket, { type: 'processing.claim', tools: ['nope'] });
    assert.equal(owner.frames.at(-1).code, 'bad_request');
    assert.equal(await registry.requestTool('read_file', { path: 'a.js' }) === null, false);
    const pending = registry.requestTool('read_file', { path: 'a.js' });
    await registry.receive(socket, { type: 'processing.claim', tools: [] });
    const request = owner.frames.find((frame) => frame.type === 'tool.request');
    await registry.receive(socket, { type: 'tool.result', requestId: request.requestId, output: 'text', summary: 's' });
    assert.equal((await pending).output, 'text');
    assert.equal(await registry.requestTool('read_file', { path: 'b.js' }), null);
});
```

The second test's in-flight call is sent before the empty claim, so the old socket still answers it. Add a disconnect test in the same file: after `registry.disconnect(socket)`, `requestTool` for its former name returns `null`, and a call that was already sent rejects with `Держатель инструмента отключился.`

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/encode-registry.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the registry**

Implement `createProcessRegistry` in `src/encode/registry.js` with the claim rules from `src/server/hub.js` (`validateToolList`, `applyClaim`, `requestTool`, `toolResult`) and these differences:

- There is no run id, no `start`, and no publisher.
- `hello` marks the socket authenticated. No token.
- `processing.claim` reads `frame.tools` only.
- `requestTool(name, args, signal)` looks up `holders.get(name)`.
- `listen()` uses `listenProtocol({ port: 0, onConnection })` and returns `{ url, port, close }`. The WebSocket URL is `ws://127.0.0.1:<port>`.

Copy the Russian error strings from `src/server/hub.js` for a bad tool name, a duplicate, a bad result, and holder disconnect.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/encode-registry.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/encode/registry.js test/encode-registry.test.js
git commit -m "$(cat <<'EOF'
feat: add a process-wide tool claim registry

EOF
)"
```

### Task 4: HTTP server and shared tool call

**Files:**
- Create: `src/encode/server.ts`
- Create: `src/encode/host.js`
- Create: `test/encode-server.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `encodeArtifacts`, `createProcessRegistry`, `createToolset` handlers through a `callTool(name, args)` callback supplied by `host.js`.
- Produces: `startEncodeHost({ root, config, decide, signal, stderr }) => Promise<{ mcpURL, processingURL, encode, close }>`. `encode(input)` calls `encodeArtifacts` with a `writeFile` that runs `decide` and then `requestTool('write_file', ...)` or the local writer. `close()` closes the HTTP server and the registry. Installed packages: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `zod`.

- [ ] **Step 1: Install the packages and write the failing test**

Run: `npm install @modelcontextprotocol/server @modelcontextprotocol/node zod`

Create `test/encode-server.test.js` that starts the host on a temp directory with `agent.encode: 'mcp'`, writes `note.txt`, and posts MCP `tools/list` and `tools/call` to `mcpURL`. Assert the tool list contains the eight names and `encode`. Assert `read_file` of `note.txt` returns the file text in the tool result. Open a WebSocket to `processingURL`, send `hello` and `processing.claim` for `write_file`, then call `encode` with one artifact `hintPath: 'out.txt'`. Assert the claim socket receives `tool.request` named `write_file`, reply `tool.result`, and assert `out.txt` was not created by Node.

Use the stateless JSON handshake documented at <https://ts.sdk.modelcontextprotocol.io/v2/serving/http>: `POST /mcp` with `initialize`, then `notifications/initialized`, then `tools/list` or `tools/call`. If the installed SDK requires a different header, keep the assertions and change only the handshake.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/encode-server.test.js`

Expected: FAIL because `startEncodeHost` does not exist.

- [ ] **Step 3: Implement the host and the server**

`src/encode/server.ts` builds a fresh `McpServer` per request, registers the nine tools with Zod object schemas, and returns MCP text content from `callTool`. `encode`'s text content is `JSON.stringify({ written })`. A thrown error becomes `isError: true`.

Mount it with `node:http` through `listenProtocol({ onRequest })` so `/mcp` is handled by `toNodeHandler` from `@modelcontextprotocol/node`, with `localhostHostValidation` and `localhostOriginValidation` in front. Follow the plain `node:http` example on <https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/node/>. WebSocket upgrades on that same server stay with `listenProtocol` and are handled by the process registry.

`src/encode/host.js` dynamic-imports `./server.ts` and `./encode.ts` only from `startEncodeHost`. It prints the two stderr lines. `writeFile` for `encodeArtifacts` calls `decide` with category `write` and then `registry.requestTool('write_file', { path, content, overwrite: true }, signal)`. A `null` from `requestTool` writes through `writeTextFile` in `src/agent/fs-tools.js`. `close` is idempotent.

`callTool` for the eight names uses `createToolset({ processTool: (name, args, signal) => registry.requestTool(name, args, signal), ... })` so approval and the local handlers stay where they are.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/encode-server.test.js test/encode.test.js test/encode-registry.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/encode/server.ts src/encode/host.js test/encode-server.test.js
git commit -m "$(cat <<'EOF'
feat: host the encode MCP server on localhost

EOF
)"
```

### Task 5: Encoder stage and command startup

**Files:**
- Modify: `src/agent/team.js`
- Modify: `src/commands/run.js`
- Modify: `src/commands/chat.js`
- Modify: `README.md`
- Modify: `test/team.test.js`

**Interfaces:**
- Consumes: `startEncodeHost` and `encodeArtifacts` through the host's `encode`.
- Produces: `runTeam({ encodeHost })`. When `encodeHost` is set, `encodeHandoff` opens the encoder stage and calls `encodeHost.encode(...)`. It does not call `roles.run('encoder')` or `executeFileCommands`. When `encodeHost` is null, `encodeHandoff` is unchanged. `ai run` and `ai chat` call `startEncodeHost` only when `config.agent.encode === 'mcp'`, before their work, and `close` it in `finally`. `ai gen` needs no separate change.

- [ ] **Step 1: Write the failing team test**

In `test/team.test.js`, add a test whose answer script returns a fenced `src/a.js` body and a final line `route: encode`. Pass `encodeHost` whose `encode` writes that hint through the real `encodeArtifacts` and records the call. The mock must throw if `roleOf(body)` is `encoder`. Assert the encode stage event has `role: 'encoder'`, the file exists, and the mock never saw `file_commands`.

Add a second test with the same answer where `encodeHost.encode` throws. Assert `roles.run` is still not asked for `file_commands` and the team result is not `completed`.

The existing team tests pass `encodeHost` unset, so they keep calling the encoder model.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 --test-name-pattern "encode host" test/team.test.js`

Expected: FAIL because `runTeam` ignores `encodeHost`.

- [ ] **Step 3: Wire the stage and the commands**

In `encodeHandoff`, keep `notify({ type: 'stage.start', stage: 'encode', role: 'encoder', ... })`. When `encodeHost` is set:

```javascript
            const workspaceText = ctx.get('workspace') ?? '';
            try {
                const encoded = await encodeHost.encode({
                    root, text: handoff.text,
                    artifacts: handoff.artifacts.map((item) => ({
                        id: item.id, body: item.body ?? '', hintLanguage: item.hintLanguage ?? null, hintPath: item.hintPath ?? null,
                    })),
                    workspace: workspaceText, directoryTree,
                });
                notify({ type: 'stage.done', stage: 'encode', status: 'completed' });
                return { ok: true, written: encoded.written };
            } catch (error) {
                if (error instanceof CancelledError || error?.name === 'AbortError') throw error;
                notify({ type: 'stage.done', stage: 'encode', status: 'failed' });
                result.status = 'failed';
                result.error = error;
                result.text = handoff.text;
                await persist('failed');
                return { ok: false, done: finish() };
            }
```

Artifact bodies live on disk under `.tmp` after `spillAnswer`. Read each body from `item.rel` when `item.body` is absent, with `readFile` inside `encodeHandoff`, before calling `encode`. Do not give the encoder model those bodies.

In `run.js`, before `runTeam` or `runOnce`, when `config.agent.encode === 'mcp'`, `startEncodeHost` and pass it as `encodeHost`. Pass `processTool` from the host into every `createToolset` used by the single-agent path. Close the host in `finally`. `runTeam` already receives `processTool`; pass the host's `processTool` too, so worker tools use the registry.

In `chat.js`, start and close the host the same way, and pass its `processTool` into `createToolset`. Chat does not call `encodeHandoff`.

In `README.md`, under the team description, add that `agent.encode: mcp` prints `MCP:` and `Processing:` and makes the encoder stage execute that server.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 test/team.test.js test/encode.test.js test/encode-registry.test.js test/encode-server.test.js test/core.test.js`

Expected: PASS. Existing team tests still call the encoder model because they do not pass `encodeHost`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/team.js src/commands/run.js src/commands/chat.js README.md test/team.test.js
git commit -m "$(cat <<'EOF'
feat: make the encoder stage execute the MCP server

EOF
)"
```
