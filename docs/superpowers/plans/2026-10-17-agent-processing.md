# Agent Processing API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated `ai serve` socket execute selected tools for one client run, and record the file changes it reports.

**Architecture:** The hub keeps a per-run map of tool name to socket and waits for `tool.result` the same way it waits for approval. `createToolset` calls an optional `processTool` after approval; `null` keeps the Node handler. `commandRunner` installs that function only for runs started by a `start` frame.

**Tech Stack:** Node.js 26 ESM, `node:test`, the existing `ai serve` hub. No npm dependencies.

## Global Constraints

- Node.js built-in modules only. No new dependencies. `index.js` gains no export.
- `ai serve` stays on `127.0.0.1`. No TLS. Incoming frames stay at 1 MiB. Outgoing frames stay on the existing `sanitizeValue` send path. No processing timer.
- Processable names, exactly: `delete_file`, `list_files`, `read_file`, `replace_text`, `run_command`, `run_script`, `search_files`, `write_file`.
- Claims belong to one client run. A terminal run rejects `processing.claim` with `bad_request` and `Захват доступен только для клиентского запуска.`
- One name has one holder. A socket's claim replaces its whole set on that run. An in-flight `requestId` stays with the socket that received `tool.request`.
- Wire `changes` entries use `op` `create`, `overwrite`, `edit`, or `delete`, and a string `path`. More than 100 items is `bad_request`.
- A remote result does not write `.backup`, does not append `stats.commands`, and does not run the scaffold guard.
- Do not route `executeFileCommands`. Only `createToolset` handlers are replaceable.
- Error codes stay `invalid_start`, `bad_request`, and `unknown_run`. Message strings in the snippets below are the spec text and must be copied unchanged.
- Spec: `docs/superpowers/specs/2026-10-17-agent-processing-design.md`.

---

## File structure

- Modify `src/server/hub.js` — claim registry, `processing` on `start`, `requestTool`, `tool.result`, release on disconnect. No filesystem and no model calls.
- Modify `src/agent/tools.js` — `processTool` argument and change accounting after a remote result.
- Modify `src/commands/shared.js` — one helper for the summary rows.
- Modify `src/commands/serve.js` — set `ctx.processTool` for a client run.
- Modify `src/commands/ask.js`, `src/commands/chat.js`, `src/commands/run.js`, `src/agent/team.js` — pass `processTool` into `createToolset`.
- Modify `src/commands/flow.js` — use the summary helper.
- Modify `README.md` — frames next to the existing bus description.
- Modify `test/hub.test.js`, `test/serve.test.js`. Create `test/processing.test.js`.

### Task 1: Claim registry

**Files:**
- Modify: `src/server/hub.js`
- Test: `test/hub.test.js`

**Interfaces:**
- Consumes: `createHub`, `connect`, `receive`, `openRun`, `publish`, `send`, `errorFrame`.
- Produces: each client or terminal run has `holders: Map<string, string>` (tool name to socket id). `processing.claim` and a non-empty `start.processing` update that map. Later tasks call `run.holders.get(name)` and reuse `applyClaim(run, socket, tools)`, `validateToolList(list, label)`, and `publishHeld(run)` inside `createHub`. `PROCESSABLE` is the eight names above, sorted.

- [ ] **Step 1: Write the failing tests**

Append to `test/hub.test.js`:

```javascript
function ids() {
    let n = 0;
    return () => `id${++n}`;
}

test('processing: start.processing claims before onStart and a bad list opens no run', async () => {
    let claimedBeforeStart = false;
    let starts = 0;
    let transport;
    const hub = createHub({
        token: 'secret', createId: ids(),
        onStart() {
            starts += 1;
            claimedBeforeStart = transport.frames.some((frame) => frame.type === 'processing.claimed');
            return new Promise(() => {});
        },
    });
    transport = pair();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['nope', 'nope'] });
    assert.equal(transport.frames.at(-1).code, 'invalid_start');
    assert.match(transport.frames.at(-1).message, /Имя инструмента повторяется: nope/);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: 'read_file' });
    assert.match(transport.frames.at(-1).message, /processing должен быть массивом/);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['read_file', 'missing'] });
    assert.match(transport.frames.at(-1).message, /Инструмент недоступен для захвата: missing/);
    assert.equal(starts, 0);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'empty', cwd: process.cwd(), processing: [] });
    assert.equal(starts, 1);
    assert.equal(claimedBeforeStart, false);
    assert.equal(transport.frames.some((frame) => frame.type === 'processing.claimed'), false);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['write_file', 'read_file'] });
    assert.equal(claimedBeforeStart, true);
    assert.equal(starts, 2);
    assert.deepEqual(transport.frames.find((frame) => frame.type === 'processing.claimed').tools, ['write_file', 'read_file']);
    const held = transport.frames.find((frame) => frame.type === 'run.event' && frame.event.type === 'processing.held');
    assert.deepEqual(held.event.tools, ['read_file', 'write_file']);
});

test('processing: claims replace a socket set, steal a name, and stay inside one run', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const ownerT = pair();
    const otherT = pair();
    const watchT = pair();
    const owner = hub.connect(ownerT);
    const other = hub.connect(otherT);
    const watch = hub.connect(watchT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(other, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(watch, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'one', cwd: process.cwd(), processing: ['read_file', 'write_file'] });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'two', cwd: process.cwd() });
    const runs = ownerT.frames.filter((frame) => frame.type === 'run.started').map((frame) => frame.run.id);
    await hub.receive(watch, { type: 'subscribe', runId: runs[1] });
    await hub.receive(other, { type: 'processing.claim', runId: runs[0], tools: ['read_file'] });
    assert.deepEqual(otherT.frames.find((frame) => frame.type === 'processing.claimed').tools, ['read_file']);
    assert.deepEqual(ownerT.frames.find((frame) => frame.type === 'processing.released').tools, ['read_file']);
    await hub.receive(owner, { type: 'processing.claim', runId: runs[0], tools: [] });
    assert.deepEqual(ownerT.frames.filter((frame) => frame.type === 'processing.claimed').at(-1).tools, []);
    const held = ownerT.frames.filter((frame) => frame.event?.type === 'processing.held').at(-1);
    assert.deepEqual(held.event.tools, ['read_file']);
    assert.equal(watchT.frames.some((frame) => frame.event?.type === 'processing.held'), false);
    const claimedCount = otherT.frames.filter((frame) => frame.type === 'processing.claimed').length;
    await hub.receive(other, { type: 'processing.claim', runId: runs[0], tools: ['read_file'] });
    assert.equal(otherT.frames.filter((frame) => frame.type === 'processing.claimed').length, claimedCount + 1);
    await hub.receive(other, { type: 'processing.claim', runId: runs[0], tools: ['read_file', 'read_file'] });
    assert.match(otherT.frames.at(-1).message, /Имя инструмента повторяется: read_file/);
    assert.deepEqual(ownerT.frames.filter((frame) => frame.event?.type === 'processing.held').at(-1).event.tools, ['read_file']);
    await hub.receive(other, { type: 'processing.claim', runId: 'missing', tools: ['read_file'] });
    assert.equal(otherT.frames.at(-1).code, 'unknown_run');
});

test('processing: a publisher may claim a client run but not its own terminal run', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const ownerT = pair();
    const pubT = pair();
    const owner = hub.connect(ownerT);
    const pub = hub.connect(pubT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(pub, { type: 'hello', role: 'publisher', token: 'secret', command: 'run', title: 't', cwd: process.cwd() });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd() });
    const clientRun = ownerT.frames.find((frame) => frame.type === 'run.started' && frame.run.source === 'client').run.id;
    const terminalRun = pubT.frames.find((frame) => frame.type === 'run.started' && frame.run.source === 'terminal').run.id;
    await hub.receive(owner, { type: 'processing.claim', runId: terminalRun, tools: ['read_file'] });
    assert.equal(ownerT.frames.at(-1).code, 'bad_request');
    assert.equal(ownerT.frames.at(-1).message, 'Захват доступен только для клиентского запуска.');
    await hub.receive(pub, { type: 'processing.claim', runId: clientRun, tools: ['read_file'] });
    assert.deepEqual(pubT.frames.find((frame) => frame.type === 'processing.claimed').tools, ['read_file']);
    assert.equal(pubT.frames.some((frame) => frame.type === 'run.event' && frame.event?.type === 'processing.held'), false);
    assert.deepEqual(ownerT.frames.find((frame) => frame.event?.type === 'processing.held').event.tools, ['read_file']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-name-pattern "processing:" test/hub.test.js`

Expected: FAIL. `processing.claimed` is absent and the last frame is `unknown_type` or `invalid_start` for an unknown `processing` field.

- [ ] **Step 3: Implement the registry**

In `src/server/hub.js`, change the header `@changed` line to `2026-10-17 Claim registry for client-run tool holders.` and add `'processing'` to `START_FIELDS`.

Inside `createHub`, before `function openRun`, add:

```javascript
    const PROCESSABLE = ['delete_file', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file'];
    const PROCESSABLE_SET = new Set(PROCESSABLE);

    /**
     * @param {unknown} list
     * @param {string} label
     * @returns {string} Empty when the list is a set of processable names.
     * @ai.hint pure
     */
    function validateToolList(list, label) {
        if (!Array.isArray(list)) return `${label} должен быть массивом.`;
        const seen = new Set();
        for (const name of list) {
            if (seen.has(name)) return `Имя инструмента повторяется: ${name}.`;
            seen.add(name);
        }
        for (const name of list) {
            if (typeof name !== 'string' || !PROCESSABLE_SET.has(name)) return `Инструмент недоступен для захвата: ${name}.`;
        }
        return '';
    }

    /**
     * @param {object} run
     * @returns {string[]}
     * @ai.hint pure
     */
    function sortedHeld(run) {
        return [...run.holders.keys()].sort();
    }

    /**
     * @param {object} run
     * @returns {void}
     * @ai.hint pure
     */
    function publishHeld(run) {
        if (run.status !== 'running') return;
        publish(run.id, { type: 'processing.held', tools: sortedHeld(run) });
    }

    /**
     * Replace this socket's names on the run with `tools`.
     * @param {object} run
     * @param {object} socket
     * @param {string[]} tools
     * @returns {void}
     * @ai.hint pure
     */
    function applyClaim(run, socket, tools) {
        const next = new Set(tools);
        /** @type {Map<string, string[]>} */
        const released = new Map();
        for (const [name, holderId] of [...run.holders.entries()]) {
            const mine = holderId === socket.id;
            if (mine && !next.has(name)) run.holders.delete(name);
            if (!mine && next.has(name)) {
                run.holders.delete(name);
                const names = released.get(holderId) ?? [];
                names.push(name);
                released.set(holderId, names);
            }
        }
        for (const name of tools) run.holders.set(name, socket.id);
        for (const [holderId, names] of released) {
            sockets.get(holderId)?.send({ type: 'processing.released', runId: run.id, tools: names.sort() });
        }
        socket.send({ type: 'processing.claimed', runId: run.id, tools: [...tools] });
        publishHeld(run);
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function claim(socket, frame) {
        const run = typeof frame.runId === 'string' ? runs.get(frame.runId) : null;
        if (!run || run.status !== 'running') {
            send(socket, errorFrame('unknown_run', 'Запуск не найден или уже завершён.'));
            return;
        }
        if (run.source !== 'client') {
            send(socket, errorFrame('bad_request', 'Захват доступен только для клиентского запуска.'));
            return;
        }
        const problem = validateToolList(frame.tools, 'tools');
        if (problem) {
            send(socket, errorFrame('bad_request', problem));
            return;
        }
        applyClaim(run, socket, frame.tools);
    }
```

In `openRun`, add `holders: new Map()` next to `waiters: []`.

In `start`, after the `approve` check and before `const prompt`, reject a bad list without opening a run:

```javascript
        const listed = frame.processing;
        const claimNow = listed !== undefined && !(Array.isArray(listed) && listed.length === 0);
        if (claimNow) {
            const problem = validateToolList(listed, 'processing');
            if (problem) {
                send(socket, errorFrame('invalid_start', problem));
                return;
            }
        }
```

After `broadcast({ type: 'run.started', run: publicRun(run) })` and before the `chat` queue push, add:

```javascript
        if (claimNow) applyClaim(run, socket, listed);
```

In `receive`, before the `unknown_type` send, add:

```javascript
        if (frame.type === 'processing.claim') return claim(socket, frame);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 --test-name-pattern "processing:" test/hub.test.js`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/hub.js test/hub.test.js
git commit -m "$(cat <<'EOF'
feat: claim tool holders on a client run

EOF
)"
```

### Task 2: Tool request and result

**Files:**
- Modify: `src/server/hub.js`
- Test: `test/hub.test.js`

**Interfaces:**
- Consumes: `run.holders`, `pending`, `finish`, `disconnect`, `abortError`, `createId`.
- Produces: `requestTool(runId: string, name: string, args: object, signal?: AbortSignal) => Promise<null | { output: string, summary: string, changes: { op: string, path: string }[] }>`. `null` means no holder. Host `error` rejects with `Error` of that message. Holder loss rejects with `Error('Держатель инструмента отключился.')`. Abort or `finish` rejects with the existing abort error (`name === 'AbortError'`, message `Отменено.`). A missing run rejects with `Error('Запуск не найден.')` unless the signal is already aborted. The hub return adds `requestTool` beside `requestApproval`.

- [ ] **Step 1: Write the failing tests**

Append to `test/hub.test.js`:

```javascript
async function clientRun(hub) {
    const ownerT = pair();
    const owner = hub.connect(ownerT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['read_file', 'write_file'] });
    const runId = ownerT.frames.find((frame) => frame.type === 'run.started').run.id;
    return { owner, ownerT, runId };
}

test('processing: tool.result returns output and a bad frame keeps waiting', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const { owner, ownerT, runId } = await clientRun(hub);
    assert.equal(await hub.requestTool(runId, 'delete_file', { path: 'a.js' }), null);
    const pending = hub.requestTool(runId, 'read_file', { path: 'a.js' });
    const request = ownerT.frames.find((frame) => frame.type === 'tool.request');
    assert.equal(request.name, 'read_file');
    assert.deepEqual(request.args, { path: 'a.js' });
    const watchT = pair();
    const watch = hub.connect(watchT);
    await hub.receive(watch, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(watch, { type: 'tool.result', requestId: request.requestId, output: 'stolen', summary: 's' });
    assert.equal(watchT.frames.at(-1).message, 'Этот requestId адресован другому сокету.');
    await hub.receive(owner, { type: 'approve', requestId: request.requestId, decision: 'yes' });
    assert.equal(ownerT.frames.at(-1).message, 'Неизвестный requestId.');
    await hub.receive(owner, { type: 'tool.result', requestId: request.requestId, error: 1 });
    assert.equal(ownerT.frames.at(-1).message, 'error должен быть строкой.');
    await hub.receive(owner, { type: 'tool.result', requestId: request.requestId, output: 1, summary: 's' });
    assert.equal(ownerT.frames.at(-1).message, 'output и summary должны быть строками.');
    await hub.receive(owner, { type: 'tool.result', requestId: request.requestId, error: '   ', output: 'text', summary: 'sum' });
    assert.deepEqual(await pending, { output: 'text', summary: 'sum', changes: [] });
    const failed = hub.requestTool(runId, 'read_file', { path: 'b.js' });
    const failRequest = ownerT.frames.filter((frame) => frame.type === 'tool.request').at(-1);
    await hub.receive(owner, { type: 'tool.result', requestId: failRequest.requestId, error: 'Файл не найден', output: 'ignored' });
    await assert.rejects(failed, { message: 'Файл не найден' });
    await hub.receive(owner, { type: 'tool.result', requestId: 'nope', output: 'x', summary: 'y' });
    assert.equal(ownerT.frames.at(-1).message, 'Неизвестный requestId.');
});

test('processing: an in-flight request stays on the old holder', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const { owner, ownerT, runId } = await clientRun(hub);
    const first = hub.requestTool(runId, 'read_file', { path: 'a.js' });
    const second = hub.requestTool(runId, 'read_file', { path: 'b.js' });
    const requests = ownerT.frames.filter((frame) => frame.type === 'tool.request');
    assert.equal(requests.length, 2);
    const otherT = pair();
    const other = hub.connect(otherT);
    await hub.receive(other, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(other, { type: 'processing.claim', runId, tools: ['read_file'] });
    await hub.receive(owner, { type: 'tool.result', requestId: requests[0].requestId, output: 'old', summary: 'o' });
    await hub.receive(owner, { type: 'tool.result', requestId: requests[1].requestId, output: 'old-2', summary: 'o2' });
    assert.equal((await first).output, 'old');
    assert.equal((await second).output, 'old-2');
    const third = hub.requestTool(runId, 'read_file', { path: 'c.js' });
    const moved = otherT.frames.find((frame) => frame.type === 'tool.request');
    assert.equal(moved.args.path, 'c.js');
    await hub.receive(other, { type: 'tool.result', requestId: moved.requestId, output: 'new', summary: 'n', changes: [{ op: 'edit', path: 'c.js' }] });
    assert.deepEqual(await third, { output: 'new', summary: 'n', changes: [{ op: 'edit', path: 'c.js' }] });
    const huge = Array.from({ length: 101 }, () => ({ op: 'edit', path: 'c.js' }));
    const fourth = hub.requestTool(runId, 'read_file', { path: 'd.js' });
    const hugeRequest = otherT.frames.filter((frame) => frame.type === 'tool.request').at(-1);
    await hub.receive(other, { type: 'tool.result', requestId: hugeRequest.requestId, output: 'x', summary: 'y', changes: huge });
    assert.match(otherT.frames.at(-1).message, /op create, overwrite, edit или delete/);
    await hub.receive(other, { type: 'tool.result', requestId: hugeRequest.requestId, output: 'x', summary: 'y' });
    assert.equal((await fourth).output, 'x');
});

test('processing: holder disconnect fails its calls, and owner disconnect cancels the run', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const ownerT = pair();
    const otherT = pair();
    const owner = hub.connect(ownerT);
    const other = hub.connect(otherT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(other, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'owned', cwd: process.cwd(), processing: ['read_file'] });
    await hub.receive(other, { type: 'start', command: 'ask', prompt: 'other', cwd: process.cwd() });
    const ownedId = ownerT.frames.find((frame) => frame.type === 'run.started' && frame.run.title.startsWith('ask owned')).run.id;
    const otherId = otherT.frames.find((frame) => frame.type === 'run.started' && frame.run.title.startsWith('ask other')).run.id;
    await hub.receive(owner, { type: 'processing.claim', runId: otherId, tools: ['write_file'] });
    const ownedCall = hub.requestTool(ownedId, 'read_file', { path: 'a.js' });
    const otherCall = hub.requestTool(otherId, 'write_file', { path: 'b.js' });
    hub.disconnect(owner);
    await assert.rejects(ownedCall, { name: 'AbortError', message: 'Отменено.' });
    await assert.rejects(otherCall, { message: 'Держатель инструмента отключился.' });
    assert.equal(otherT.frames.some((frame) => frame.type === 'run.ended' && frame.runId === otherId), false);
    assert.equal(await hub.requestTool(otherId, 'write_file', { path: 'b.js' }), null);
    await assert.rejects(hub.requestTool('gone', 'read_file', {}), { message: 'Запуск не найден.' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(hub.requestTool('gone', 'read_file', {}, controller.signal), { name: 'AbortError' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-name-pattern "processing: tool|processing: an in-flight|processing: holder" test/hub.test.js`

Expected: FAIL. `hub.requestTool is not a function`.

- [ ] **Step 3: Implement request and result**

Inside `createHub`, add `requestTool` and `toolResult` next to `claim`:

```javascript
    const CHANGE_OPS = new Set(['create', 'overwrite', 'edit', 'delete']);

    /**
     * @param {unknown} changes
     * @returns {{ changes?: { op: string, path: string }[], error?: string }}
     * @ai.hint pure
     */
    function parseChanges(changes) {
        if (changes === undefined) return { changes: [] };
        if (!Array.isArray(changes) || changes.length > 100) return { error: 'changes: op create, overwrite, edit или delete и path-строка.' };
        const parsed = [];
        for (const item of changes) {
            if (!isRecord(item) || !CHANGE_OPS.has(item.op) || typeof item.path !== 'string') {
                return { error: 'changes: op create, overwrite, edit или delete и path-строка.' };
            }
            parsed.push({ op: item.op, path: item.path });
        }
        return { changes: parsed };
    }

    /**
     * @param {string} runId
     * @param {string} name
     * @param {object} args
     * @param {AbortSignal} [signal]
     * @returns {Promise<null | { output: string, summary: string, changes: { op: string, path: string }[] }>}
     * @ai.hint pure
     */
    function requestTool(runId, name, args, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        const run = runs.get(runId);
        if (!run || run.status !== 'running') return Promise.reject(new Error('Запуск не найден.'));
        const holderId = run.holders.get(name);
        if (!holderId) return Promise.resolve(null);
        const holder = sockets.get(holderId);
        if (!holder) return Promise.reject(new Error('Держатель инструмента отключился.'));
        const requestId = createId();
        return new Promise((resolve, reject) => {
            let settled = false;
            /**
             * @param {Error | null} error
             * @param {object} [value]
             * @returns {void}
             * @ai.hint pure
             */
            const done = (error, value) => {
                if (settled) return;
                settled = true;
                pending.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
                if (error) reject(error);
                else resolve(value);
            };
            /** @returns {void} */
            const onAbort = () => done(abortError());
            pending.set(requestId, { runId, holderId, kind: 'tool', resolve: done });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            holder.send({ type: 'tool.request', runId, requestId, name, args });
        });
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function toolResult(socket, frame) {
        const item = typeof frame.requestId === 'string' ? pending.get(frame.requestId) : null;
        if (!item || item.kind !== 'tool') {
            send(socket, errorFrame('bad_request', 'Неизвестный requestId.'));
            return;
        }
        if (item.holderId !== socket.id) {
            send(socket, errorFrame('bad_request', 'Этот requestId адресован другому сокету.'));
            return;
        }
        if (frame.error !== undefined && typeof frame.error !== 'string') {
            send(socket, errorFrame('bad_request', 'error должен быть строкой.'));
            return;
        }
        if (typeof frame.error === 'string' && frame.error.trim()) {
            item.resolve(new Error(frame.error));
            return;
        }
        if (typeof frame.output !== 'string' || typeof frame.summary !== 'string') {
            send(socket, errorFrame('bad_request', 'output и summary должны быть строками.'));
            return;
        }
        const parsed = parseChanges(frame.changes);
        if (parsed.error) {
            send(socket, errorFrame('bad_request', parsed.error));
            return;
        }
        item.resolve(null, { output: frame.output, summary: frame.summary, changes: parsed.changes });
    }
```

In `control`, treat a tool wait as an unknown approval id. Replace the missing-item check with:

```javascript
        if (!item || item.kind === 'tool') {
            send(socket, errorFrame('bad_request', 'Неизвестный requestId.'));
            return;
        }
```

In `finish`, settle a tool wait with the abort error instead of the approval string. Replace the pending loop body with:

```javascript
            if (item.kind === 'tool') item.resolve(abortError());
            else item.resolve(item.kind === 'question' ? null : 'abort');
            pending.delete(requestId);
```

Replace `disconnect` with a per-run release. Owned runs still cancel. Other client runs only lose this socket's names:

```javascript
    function disconnect(socket) {
        sockets.delete(socket.id);
        for (const run of [...runs.values()]) {
            if (run.status !== 'running') continue;
            if (run.ownerId === socket.id) {
                run.controller?.abort();
                finish(run.id, 'cancelled', 130);
                continue;
            }
            if (run.source !== 'client') continue;
            let lost = false;
            for (const [name, holderId] of [...run.holders.entries()]) {
                if (holderId !== socket.id) continue;
                run.holders.delete(name);
                lost = true;
            }
            for (const item of [...pending.values()]) {
                if (item.kind === 'tool' && item.runId === run.id && item.holderId === socket.id) {
                    item.resolve(new Error('Держатель инструмента отключился.'));
                }
            }
            if (lost) publishHeld(run);
        }
    }
```

In `receive`, next to `processing.claim`:

```javascript
        if (frame.type === 'tool.result') return toolResult(socket, frame);
```

Add `requestTool` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 test/hub.test.js`

Expected: PASS, including the previous hub tests. Approval from a non-owner still returns `not_owner`.

- [ ] **Step 5: Commit**

```bash
git add src/server/hub.js test/hub.test.js
git commit -m "$(cat <<'EOF'
feat: wait on the socket that holds a tool

EOF
)"
```

### Task 3: Dispatcher in createToolset

**Files:**
- Modify: `src/agent/tools.js`
- Create: `test/processing.test.js`

**Interfaces:**
- Consumes: `requestTool` is not called here. `processTool(name, args, signal)` returns `null` or `{ output: string, summary: string, changes?: { op: string, path: string }[] }`, or throws.
- Produces: `createToolset({ processTool = null, ... })`. For a processable name, `execute` awaits `processTool` only after `decide` allows the call. `null` or a missing function runs the local handler. A result skips the local handler. `stats().changes` gains `{ op, path }` with no `backupPath` for `write_file`, `replace_text`, and `delete_file` only.

- [ ] **Step 1: Write the failing test**

Create `test/processing.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createToolset } from '../src/agent/tools.js';
import { buildProjectMap, loadProjectMap } from '../src/agent/map.js';
import { defaults } from '../src/core/config.js';
import { CancelledError } from '../src/openai/errors.js';

async function rootFor(name) {
    return mkdtemp(path.join(os.tmpdir(), `ai-proc-${name}-`));
}

test('processing: null uses Node and a host result does not touch the disk', async () => {
    const root = await rootFor('null');
    try {
        const local = createToolset({
            root, config: defaults, names: ['write_file'], approvalLevel: 'all',
            processTool: async () => null,
        });
        const written = await local.execute({
            name: 'write_file', call_id: 'c1',
            arguments: JSON.stringify({ path: 'note.txt', content: 'local\n', overwrite: true }),
        });
        assert.equal(written.ok, true);
        assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'local\n');
        const remote = createToolset({
            root, config: defaults, names: ['write_file'], approvalLevel: 'all', editPaths: () => new Set(),
            processTool: async () => ({ output: 'remote', summary: 'r', changes: [{ op: 'create', path: 'other.txt' }] }),
        });
        const hosted = await remote.execute({
            name: 'write_file', call_id: 'c2',
            arguments: JSON.stringify({ path: 'other.txt', content: 'nope\n', overwrite: true }),
        });
        assert.equal(hosted.output, 'remote');
        assert.equal(await stat(path.join(root, 'other.txt')).catch(() => null), null);
        assert.deepEqual(remote.stats().changes, [{ op: 'create', path: 'other.txt' }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: replace_text changes refresh the project map', async () => {
    const root = await rootFor('map');
    try {
        await writeFile(path.join(root, 'lib.js'), 'export function hello() {}\n');
        await buildProjectMap(root);
        const toolset = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'all',
            processTool: async () => {
                await writeFile(path.join(root, 'lib.js'), 'export function goodbye() {}\n');
                return { output: 'Изменён lib.js', summary: '~ lib.js', changes: [{ op: 'edit', path: './lib.js' }] };
            },
        });
        const result = await toolset.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'lib.js', search: 'hello', replacement: 'goodbye', all: false }),
        });
        assert.equal(result.output, 'Изменён lib.js');
        assert.deepEqual(toolset.stats().changes, [{ op: 'edit', path: 'lib.js' }]);
        const loaded = await loadProjectMap(root);
        assert.ok(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'goodbye'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: bad changes warn and read_file drops them', async () => {
    const root = await rootFor('warn');
    try {
        await writeFile(path.join(root, 'a.txt'), 'hello\n');
        const warnings = [];
        const edits = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'all', emit: (event) => warnings.push(event),
            processTool: async () => ({
                output: 'kept', summary: 's',
                changes: [{ op: 'nope', path: 'a.js' }, { op: 'edit', path: '../out.js' }, { op: 'edit', path: '.backup/a.js' }, { op: 'edit', path: 'b.js' }],
            }),
        });
        const edited = await edits.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'a.js', search: 'a', replacement: 'b', all: false }),
        });
        assert.equal(edited.output, 'kept');
        assert.deepEqual(edits.stats().changes, [{ op: 'edit', path: 'b.js' }]);
        assert.ok(warnings.some((event) => event.message === 'Некорректная запись changes.'));
        assert.ok(warnings.some((event) => /вне рабочего каталога/.test(event.message)));
        assert.ok(warnings.some((event) => event.message === 'Запись в .backup запрещена: .backup/a.js'));
        const many = Array.from({ length: 101 }, (_, index) => ({ op: 'edit', path: `f${index}.js` }));
        warnings.length = 0;
        const bulk = createToolset({
            root, config: defaults, names: ['delete_file'], approvalLevel: 'all', emit: (event) => warnings.push(event),
            processTool: async () => ({ output: 'bulk', summary: 'b', changes: many }),
        });
        await bulk.execute({ name: 'delete_file', call_id: 'c2', arguments: JSON.stringify({ path: 'a.txt' }) });
        assert.equal(bulk.stats().changes.length, 100);
        assert.ok(warnings.some((event) => event.message === 'changes содержит больше 100 записей.'));
        const reader = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => ({ output: 'host-read', summary: 'h', changes: [{ op: 'edit', path: 'a.txt' }] }),
        });
        const read = await reader.execute({
            name: 'read_file', call_id: 'c3',
            arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }),
        });
        assert.equal(read.output, 'host-read');
        assert.deepEqual(reader.stats().changes, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: denial, cancellation, shell stats, and make_dir stay local', async () => {
    const root = await rootFor('gate');
    try {
        let calls = 0;
        const denied = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'ask', approve: async () => 'no',
            processTool: async () => { calls += 1; return { output: 'x', summary: 'y' }; },
        });
        const blocked = await denied.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'a.js', search: 'a', replacement: 'b', all: false }),
        });
        assert.equal(calls, 0);
        assert.equal(blocked.ok, false);
        const cancelled = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => { throw new CancelledError('stop'); },
        });
        await assert.rejects(
            cancelled.execute({ name: 'read_file', call_id: 'c2', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }) }),
            (error) => error instanceof CancelledError && error.message === 'stop',
        );
        const aborted = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => {
                const error = new Error('Отменено.');
                error.name = 'AbortError';
                throw error;
            },
        });
        await assert.rejects(
            aborted.execute({ name: 'read_file', call_id: 'c2b', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }) }),
            (error) => error instanceof CancelledError && error.message === 'Отменено.',
        );
        const broken = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => { throw new Error('boom'); },
        });
        const failed = await broken.execute({
            name: 'read_file', call_id: 'c3', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }),
        });
        assert.equal(failed.ok, false);
        assert.match(failed.output, /^Ошибка: boom/);
        const shell = createToolset({
            root, config: defaults, names: ['run_command'], approvalLevel: 'all',
            editPaths: () => new Set(),
            processTool: async () => ({ output: 'plain', summary: '0', changes: [{ op: 'edit', path: 'a.js' }] }),
        });
        const command = await shell.execute({
            name: 'run_command', call_id: 'c4',
            arguments: JSON.stringify({ command: 'echo hi', shell: '', cwd: null, timeout_seconds: null, reason: 'check' }),
        });
        assert.equal(command.output, 'plain');
        assert.deepEqual(shell.stats().commands, []);
        assert.deepEqual(shell.stats().changes, []);
        const dirs = createToolset({
            root, config: defaults, names: ['make_dir'], approvalLevel: 'all',
            processTool: async () => { calls += 1; return { output: 'no', summary: 'no' }; },
        });
        const made = await dirs.execute({ name: 'make_dir', call_id: 'c5', arguments: JSON.stringify({ path: 'sub' }) });
        assert.equal(made.ok, true);
        assert.equal(calls, 0);
        assert.equal((await stat(path.join(root, 'sub'))).isDirectory(), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/processing.test.js`

Expected: FAIL. The host `output` is not returned, or Node writes `other.txt`.

- [ ] **Step 3: Implement processTool**

In `src/agent/tools.js`, set `@changed` to `2026-10-17 Optional processTool replaces a processable handler.`

Above `createToolset`, add:

```javascript
const PROCESSABLE = new Set(['delete_file', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file']);
const WRITE_CHANGES = new Set(['write_file', 'replace_text', 'delete_file']);
const CHANGE_OPS = new Set(['create', 'overwrite', 'edit', 'delete']);
```

Add `processTool = null` to the `createToolset` parameter list. In the comment above the function, add: `processTool(name, args, signal) → null | { output, summary, changes? } — remote handler for a processable tool. null runs the local handler.`

Inside `createToolset`, after `notify` is defined, add:

```javascript
    /** Record host changes for a write tool and refresh the map. */
    async function applyRemoteChanges(changes) {
        const list = Array.isArray(changes) ? changes : [];
        if (list.length > 100) notify({ type: 'warning', message: 'changes содержит больше 100 записей.' });
        for (const change of list.slice(0, 100)) {
            if (!change || typeof change.path !== 'string' || !CHANGE_OPS.has(change.op)) {
                notify({ type: 'warning', message: 'Некорректная запись changes.' });
                continue;
            }
            try {
                const { rel } = await resolveInside(root, change.path, { forWrite: true, allowRoot: false });
                if (rel === '.backup' || rel.startsWith('.backup/')) throw new Error(`Запись в .backup запрещена: ${rel}`);
                stats.changes.push({ op: change.op, path: rel });
                try { await updateProjectMapPath(root, rel); }
                catch (error) { notify({ type: 'warning', message: `Карта проекта не обновлена: ${error.message}` }); }
            } catch (error) {
                notify({ type: 'warning', message: error.message });
            }
        }
    }
```

In `execute`, replace the block that starts at `signal?.throwIfAborted();` and calls `handlers[name]` with:

```javascript
        signal?.throwIfAborted();
        if (PROCESSABLE.has(name) && processTool) {
            let remote = null;
            try {
                remote = await processTool(name, args, signal);
            } catch (error) {
                if (signal?.aborted || error instanceof CancelledError || error?.name === 'AbortError') {
                    throw error instanceof CancelledError ? error : new CancelledError('Отменено.');
                }
                stats.errors++;
                return fail(errorMessage(error));
            }
            if (remote) {
                if (typeof remote.output !== 'string' || typeof remote.summary !== 'string') {
                    stats.errors++;
                    return fail('output и summary должны быть строками.');
                }
                if (WRITE_CHANGES.has(name)) await applyRemoteChanges(remote.changes);
                return { ok: true, output: remote.output, summary: remote.summary, durationMs: Date.now() - started, category };
            }
        }
        try {
            const result = await handlers[name](args);
            return { ok: true, ...result, durationMs: Date.now() - started, category };
        } catch (error) {
            if (signal?.aborted || error instanceof CancelledError) throw error;
            stats.errors++;
            return fail(errorMessage(error));
        }
```

Leave the rest of `execute` as it is. `CancelledError` is already imported in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/processing.test.js`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.js test/processing.test.js
git commit -m "$(cat <<'EOF'
feat: let a process host replace processable tools

EOF
)"
```

### Task 4: Wire the client run, summary, and README

**Files:**
- Modify: `src/commands/shared.js`, `src/commands/flow.js`, `src/commands/run.js`, `src/commands/serve.js`, `src/commands/ask.js`, `src/commands/chat.js`, `src/agent/team.js`, `README.md`
- Test: `test/processing.test.js`, `test/serve.test.js`

**Interfaces:**
- Consumes: `hub.requestTool(runId, name, args, signal)` and `createToolset({ processTool })`.
- Produces: `backupSummaryRows(changes, backupDir) => [label, value][]` from `src/commands/shared.js`. `ctx.processTool` on a client run calls `requestTool`. `runTeam({ processTool })` puts it on `toolBase`, which every `createToolset` in that file already spreads.

- [ ] **Step 1: Write the failing tests**

Append to `test/processing.test.js`:

```javascript
import { backupSummaryRows } from '../src/commands/shared.js';

test('processing: the backup row appears only when a change has a backup path', () => {
    const remote = backupSummaryRows([{ op: 'edit', path: 'a.js' }], '/tmp/backup');
    assert.deepEqual(remote, [['изменения', '~ a.js']]);
    const local = backupSummaryRows([{ op: 'edit', path: 'a.js', backupPath: '/tmp/backup/a.js' }], '/tmp/backup');
    assert.deepEqual(local, [['изменения', '~ a.js'], ['резервные копии', '/tmp/backup']]);
    assert.deepEqual(backupSummaryRows([], '/tmp/backup'), []);
});
```

Put that import with the other imports instead of below the tests.

Append to `test/serve.test.js`:

```javascript
test('processing: the owner answers write_file and the work directory stays unchanged', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-proc-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-proc-work-'));
    const server = await startMockServer({
        script: (body) => (body.input?.some((item) => item.type === 'function_call_output')
            ? { text: 'готово' }
            : { calls: [{ name: 'write_file', arguments: { path: 'note.txt', content: 'ok\u0007\n', overwrite: true } }] }),
    });
    const saved = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
        AI_MODEL: process.env.AI_MODEL, AI_AGENT_HOME: process.env.AI_AGENT_HOME,
    };
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = server.baseURL;
    process.env.AI_MODEL = 'mock-model';
    process.env.AI_AGENT_HOME = home;
    const handle = await startServe({ home, port: 0 });
    try {
        const frames = [];
        const owner = new WebSocket(handle.url);
        framesOf(owner, frames);
        await once(owner, 'open');
        owner.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
        await delay(30);
        owner.send(JSON.stringify({
            type: 'start', command: 'ask', prompt: 'создай note.txt', cwd: work, approve: 'ask', tools: 'fs', web: false,
            processing: ['write_file'],
        }));
        const approval = await waitFor(frames, (frame) => frame.type === 'approval.request');
        owner.send(JSON.stringify({ type: 'approve', requestId: approval.requestId, decision: 'yes' }));
        const request = await waitFor(frames, (frame) => frame.type === 'tool.request');
        assert.equal(request.name, 'write_file');
        assert.equal(request.args.content, 'ok\n');
        owner.send(JSON.stringify({
            type: 'tool.result', requestId: request.requestId, output: 'Создан note.txt', summary: '+ note.txt',
            changes: [{ op: 'create', path: 'note.txt' }],
        }));
        await waitFor(frames, (frame) => frame.type === 'run.ended' && frame.status === 'completed');
        await assert.rejects(stat(path.join(work, 'note.txt')));
        const result = frames.find((frame) => frame.type === 'run.event' && frame.event.type === 'result');
        assert.deepEqual(result.event.tools.changes, [{ op: 'create', path: 'note.txt' }]);
        const summary = frames.find((frame) => frame.type === 'run.event' && frame.event.type === 'summary');
        assert.equal(summary.event.rows.some((row) => row[0] === 'изменения'), true);
        assert.equal(summary.event.rows.some((row) => row[0] === 'резервные копии'), false);
        owner.close();
    } finally {
        await handle.close();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await server.close();
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});
```

Add `stat` to the existing `node:fs/promises` import in `test/serve.test.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-name-pattern "processing:" test/processing.test.js test/serve.test.js`

Expected: FAIL. `backupSummaryRows` is missing, and the serve test times out waiting for `tool.request` because Node handles `write_file` locally.

- [ ] **Step 3: Wire the host and the summary**

In `src/commands/shared.js`, export `backupSummaryRows` from the `@exports` line and add it after `describeChanges`:

```javascript
/**
 * Summary rows for file changes. The backup directory is listed only when a change kept a local copy.
 * @param {Array<{ op?: string, path: string, backupPath?: string | null }> | null | undefined} changes
 * @param {string | null | undefined} backupDir
 * @returns {Array<[string, string]>}
 * @exports
 * @ai.hint pure
 */
export function backupSummaryRows(changes, backupDir) {
    if (!changes?.length) return [];
    const rows = [['изменения', describeChanges({ changes })]];
    if (changes.some((change) => change.backupPath)) rows.push(['резервные копии', backupDir]);
    return rows;
}
```

In `src/commands/flow.js`, replace `describeChanges` in the shared import with `backupSummaryRows`. Replace the changes spread in `renderer.summary` with:

```javascript
            ...backupSummaryRows(stats?.changes, ctx.backupDir),
```

In `src/commands/run.js`, replace `describeChanges` in the shared import with `backupSummaryRows`. Replace the team summary's changes spread with:

```javascript
            ...backupSummaryRows(result.changes, ctx.backupDir),
```

In `runSingleFlow`'s `createToolset` call, add `processTool: ctx.processTool`. In `runTeam`, add `processTool = null` to the parameter list and add `processTool` to `toolBase`. The delegate, worker, collector, and reviewer toolsets already spread `toolBase`. In `runTeamFlow`'s `runTeam` call, add `processTool: ctx.processTool`.

In `src/commands/ask.js` and `src/commands/chat.js`, add `processTool: ctx.processTool` to the `createToolset` call.

In `src/commands/serve.js`, add this field to the `ctx` object inside `commandRunner`:

```javascript
            processTool: (name, args, signal) => hub.requestTool(run.id, name, args, signal),
```

In `README.md`, after the paragraph that ends with `Наблюдатели получают события и не могут подтверждать действия.`, add:

```markdown
Сокет может забрать исполнение части инструментов клиентского запуска. В `start` поле `processing` — массив имён, которые сразу берёт владелец: `list_files`, `read_file`, `search_files`, `write_file`, `replace_text`, `delete_file`, `run_command`, `run_script`. Другой сокет после `hello` шлёт `processing.claim` с `runId` и `tools`. Одно имя держит один сокет. Повторный claim этого сокета заменяет его список, а занятое имя переходит к новому сокету. Прежнему уходит `processing.released`. Подписчики видят снимок `processing.held`.

После подтверждения держателю уходит `tool.request` (`runId`, `requestId`, `name`, `args`). Ответ — `tool.result` с `output`, `summary` и необязательным `changes` (`op`: `create`, `overwrite`, `edit`, `delete`, и `path`). Поле `error` завершает вызов ошибкой инструмента. Пустой список и неназванное имя выполняет Node. Захват на запуск из терминала (`--serve`) отклоняется.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 test/processing.test.js test/serve.test.js test/hub.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/shared.js src/commands/flow.js src/commands/run.js src/commands/serve.js src/commands/ask.js src/commands/chat.js src/agent/team.js README.md test/processing.test.js test/serve.test.js
git commit -m "$(cat <<'EOF'
feat: route client-run tools through the processing socket

EOF
)"
```
