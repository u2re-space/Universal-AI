# WebSocket Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ai serve`, a localhost WebSocket bus that runs client-started `ask` / `run` / `chat` / `image` work and publishes events from terminal commands attached with `--serve`.

**Architecture:** A built-in WebSocket protocol on `node:http` carries JSON text frames. A hub tracks runs, subscribers, and approval promises. `ai serve` turns a `start` frame into the existing command context. `--serve` wraps `emit` and publishes from the terminal process, which keeps its own tools and approval prompts.

**Tech Stack:** Node.js 26 ESM, `node:http`, `node:crypto`, `node:test`, the global `WebSocket` client. No npm dependencies.

## Global Constraints

- Node.js built-in modules only. No SDK and no dependencies.
- The server binds `127.0.0.1` only. No TLS.
- Token is 32 random bytes, hex-encoded (64 chars), stored in `<config home>/serve.json` with mode `0600`, and never printed.
- JSON text frames only. Maximum frame size is 1 MiB (1_048_576 bytes).
- Server ping interval is 30 seconds. A socket silent for 90 seconds is closed.
- Binary frames close with 1003. Fragmented frames and invalid UTF-8 close with 1007. Oversize frames send `too_large` and close with 1009. A bad token sends `unauthorized` and closes with 1008.
- Protocol `message` strings are Russian. Error `code` values are the English snake_case names in the spec.
- `ai serve` exit codes: 0 clean signal shutdown, 2 already running / port taken / bad arguments, 1 unexpected throw.
- Client-run exit codes follow the CLI: 0 success, 1 failed or unfinished, 2 usage or configuration, 130 cancelled.
- Do not replace `ai jobs` or `--detach`.

---

## File structure

- Create `src/server/protocol.js` — HTTP upgrade, frame codec, ping, idle timeout. No runs or tokens.
- Create `src/server/hub.js` — run list, auth, fan-out, approval and input promises. No sockets and no model calls.
- Create `src/server/publish.js` — terminal WebSocket client used by `--serve`.
- Create `src/commands/serve.js` — `ai serve`: file, dispatch, command adapter.
- Create `test/protocol.test.js`, `test/hub.test.js`, `test/serve.test.js`.
- Modify `src/cli.js` — `serve` command, `--serve`, `--port`, emit wrapper.
- Modify `index.js` — export `listenProtocol` and `createHub`.
- Modify `README.md` — command and flag documentation.

### Task 1: WebSocket protocol

**Files:**
- Create: `src/server/protocol.js`
- Create: `test/protocol.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces:
  - `listenProtocol({ port = 0, host = '127.0.0.1', onConnection, pingIntervalMs = 30_000, idleMs = 90_000, maxFrameBytes = 1_048_576 }) → Promise<{ url: string, port: number, close: () => Promise<void> }>`
  - `onConnection(conn)` where `conn.send(text: string): void`, `conn.close(code?: number): void`, and `conn` is an `EventEmitter` emitting `'message'` (string) and `'close'` (code number).
  - `export const MAX_FRAME_BYTES = 1_048_576`

- [ ] **Step 1: Write the failing test**

Create `test/protocol.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { listenProtocol, MAX_FRAME_BYTES } from '../src/server/protocol.js';

function once(target, event) {
  return new Promise((resolve, reject) => {
    const ok = (...args) => { cleanup(); resolve(args.length <= 1 ? args[0] : args); };
    const fail = (error) => { cleanup(); reject(error); };
    const cleanup = () => { target.removeEventListener?.(event, ok); target.removeEventListener?.('error', fail); };
    target.addEventListener(event, ok);
    target.addEventListener?.('error', fail);
  });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('text frames round-trip through the HTTP upgrade', async () => {
  let received = '';
  const server = await listenProtocol({
    onConnection(conn) { conn.on('message', (text) => { received = text; conn.send(`echo:${text}`); }); },
  });
  try {
    const ws = new WebSocket(server.url);
    await once(ws, 'open');
    ws.send('привет');
    const reply = await once(ws, 'message');
    assert.equal(received, 'привет');
    assert.equal(String(reply.data), 'echo:привет');
    ws.close();
  } finally {
    await server.close();
  }
});

test('a binary frame closes with 1003', async () => {
  const server = await listenProtocol({ onConnection() {} });
  try {
    const ws = new WebSocket(server.url);
    await once(ws, 'open');
    ws.send(new Uint8Array([1, 2, 3]));
    const event = await once(ws, 'close');
    assert.equal(event.code, 1003);
  } finally {
    await server.close();
  }
});

test('pings keep a quiet socket open and a socket with no ping dies at the idle limit', async () => {
  const alive = await listenProtocol({ pingIntervalMs: 30, idleMs: 200, onConnection() {} });
  const dead = await listenProtocol({ pingIntervalMs: 0, idleMs: 80, onConnection() {} });
  try {
    const ws = new WebSocket(alive.url);
    await once(ws, 'open');
    await delay(250);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    const idle = new WebSocket(dead.url);
    await once(idle, 'open');
    const event = await once(idle, 'close');
    assert.equal(event.code, 1001);
  } finally {
    await alive.close();
    await dead.close();
  }
});

test('a single text frame larger than 1 MiB closes with 1009', async () => {
  const server = await listenProtocol({ onConnection() {} });
  try {
    const socket = await new Promise((resolve, reject) => {
      const client = net.connect(server.port, '127.0.0.1', () => {
        const key = randomBytes(16).toString('base64');
        client.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.includes(Buffer.from('\r\n\r\n'))) return;
        client.off('data', onData);
        resolve(client);
      };
      client.on('data', onData);
      client.on('error', reject);
    });
    const length = MAX_FRAME_BYTES + 1;
    const head = Buffer.alloc(14);
    head[0] = 0x81;
    head[1] = 0xFF;
    head.writeBigUInt64BE(BigInt(length), 2);
    head.writeUInt32BE(0, 10);
    const bytes = await new Promise((resolve) => {
      const parts = [];
      socket.on('data', (chunk) => parts.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(parts)));
      socket.write(head);
    });
    assert.ok(bytes.includes(Buffer.from('too_large')), bytes.toString('utf8'));
    const closeAt = bytes.indexOf(Buffer.from([0x88]));
    assert.ok(closeAt >= 0);
    assert.equal(bytes.readUInt16BE(closeAt + 2), 1009);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/protocol.test.js`

Expected: FAIL. `listenProtocol` is not defined (module not found or export missing).

- [ ] **Step 3: Write the implementation**

Create `src/server/protocol.js`:

```javascript
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_FRAME_BYTES = 1_048_576;
const decoder = new TextDecoder('utf-8', { fatal: true });

function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  const len = data.length;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function attachSocket(socket, { onConnection, pingIntervalMs, idleMs, maxFrameBytes }) {
  const conn = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let alive = true;
  let last = Date.now();
  const touch = () => { last = Date.now(); };
  const shutdown = (code) => {
    if (!alive) return;
    alive = false;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    try { socket.write(encodeFrame(0x8, payload)); } catch { /* already gone */ }
    socket.end();
    conn.emit('close', code);
  };
  conn.send = (text) => { if (alive) socket.write(encodeFrame(0x1, Buffer.from(String(text)))); };
  conn.close = (code = 1000) => shutdown(code);
  const fail = (code, text) => {
    if (text && alive) conn.send(text);
    shutdown(code);
  };
  const onData = (chunk) => {
    if (!alive) return;
    touch();
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!alive || buffer.length < 2) return;
      const b0 = buffer[0];
      const b1 = buffer[1];
      if ((b0 & 0x70) !== 0) return fail(1002);
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const declared = buffer.readBigUInt64BE(2);
        if (declared > BigInt(maxFrameBytes)) return fail(1009, JSON.stringify({ type: 'error', code: 'too_large', message: 'Кадр больше 1 МиБ.' }));
        length = Number(declared);
        offset = 10;
      }
      if (!fin || opcode === 0) return fail(1007);
      if (!masked) return fail(1002);
      if (length > maxFrameBytes) return fail(1009, JSON.stringify({ type: 'error', code: 'too_large', message: 'Кадр больше 1 МиБ.' }));
      if ((opcode & 0x8) !== 0 && length > 125) return fail(1002);
      const width = offset + 4 + length;
      if (buffer.length < width) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, width));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(width);
      if (opcode === 0x1) {
        let text;
        try { text = decoder.decode(payload); }
        catch { return fail(1007); }
        conn.emit('message', text);
      } else if (opcode === 0x2) return fail(1003);
      else if (opcode === 0x8) return shutdown(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
      else if (opcode === 0x9) socket.write(encodeFrame(0xA, payload));
      else if (opcode === 0xA) touch();
      else return fail(1002);
    }
  };
  socket.on('data', onData);
  socket.on('close', () => { if (alive) { alive = false; conn.emit('close', 1006); } });
  socket.on('error', () => shutdown(1006));
  const ping = pingIntervalMs > 0 ? setInterval(() => { if (alive) socket.write(encodeFrame(0x9, Buffer.alloc(0))); }, pingIntervalMs) : null;
  const idle = setInterval(() => { if (alive && Date.now() - last > idleMs) shutdown(1001); }, Math.max(15, Math.min(idleMs, 1000)));
  ping?.unref?.();
  idle.unref?.();
  const stop = () => { clearInterval(ping); clearInterval(idle); };
  conn.on('close', stop);
  socket.on('close', stop);
  onConnection(conn);
}

/** Listen on 127.0.0.1 and accept WebSocket upgrades. pingIntervalMs 0 disables pings. */
export function listenProtocol({ port = 0, host = '127.0.0.1', onConnection, pingIntervalMs = 30_000, idleMs = 90_000, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  if (host !== '127.0.0.1') return Promise.reject(new Error('WebSocket-сервер слушает только 127.0.0.1.'));
  const sockets = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Требуется WebSocket.\n');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const connection = String(req.headers.connection ?? '');
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !/upgrade/i.test(connection) || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    attachSocket(socket, { onConnection, pingIntervalMs, idleMs, maxFrameBytes });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        port: address.port,
        close: () => new Promise((done) => {
          for (const sock of sockets) sock.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
```

Append to `index.js`:

```javascript
export { listenProtocol } from './src/server/protocol.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/protocol.test.js`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/server/protocol.js test/protocol.test.js index.js
git commit -m "feat: add a localhost WebSocket protocol on node:http"
```

### Task 2: Run hub

**Files:**
- Create: `src/server/hub.js`
- Create: `test/hub.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: nothing from Task 1. Outgoing frames are plain objects. The serve command serializes them.
- Produces `createHub({ token, onStart, createId, now })`:
  - `connect({ send(frame), close(code) }) → socket`
  - `receive(socket, frame) → Promise<void>`
  - `disconnect(socket) → void`
  - `publish(runId, event) → void` fans `{ type: 'run.event', runId, event }` out to client subscribers and the client owner. Publishers never receive `run.event`.
  - `requestApproval(runId, { name, category, preview }, signal) → Promise<'yes'|'no'|'always'|'abort'>`
  - `requestQuestion(runId, question, signal) → Promise<string|null>`
  - `waitInput(runId, signal) → Promise<string>`
  - `finish(runId, status, exitCode) → void`
  - `shutdown() → void` cancels client runs (status `cancelled`, exit 130) and marks publisher runs `detached` (exit 0).

- [ ] **Step 1: Write the failing test**

Create `test/hub.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/server/hub.js';

function pair() {
  const frames = [];
  const transport = { frames, send(frame) { frames.push(frame); }, close(code) { this.code = code; } };
  return transport;
}

test('a wrong token is rejected and the socket is closed', async () => {
  const hub = createHub({ token: 'secret' });
  const transport = pair();
  const socket = hub.connect(transport);
  await hub.receive(socket, { type: 'hello', role: 'client', token: 'nope' });
  assert.equal(transport.frames[0].code, 'unauthorized');
  assert.equal(transport.code, 1008);
});

test('subscribers receive events, a non-owner cannot approve, and owner drop aborts the run', async () => {
  let started;
  const hub = createHub({
    token: 'secret',
    createId: (() => { let n = 0; return () => `id${++n}`; })(),
    onStart(run) { started = run; return new Promise(() => {}); },
  });
  const ownerT = pair();
  const watchT = pair();
  const owner = hub.connect(ownerT);
  const watch = hub.connect(watchT);
  await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
  await hub.receive(watch, { type: 'hello', role: 'client', token: 'secret' });
  await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd() });
  const runId = started.id;
  await hub.receive(watch, { type: 'subscribe', runId });
  hub.publish(runId, { type: 'text.delta', text: 'a' });
  assert.ok(watchT.frames.some((frame) => frame.type === 'run.event' && frame.event.text === 'a'));
  const approval = hub.requestApproval(runId, { name: 'write_file', category: 'write', preview: 'p' });
  assert.ok(watchT.frames.some((frame) => frame.type === 'run.event' && frame.event.type === 'approval.pending'));
  assert.equal(watchT.frames.some((frame) => frame.type === 'approval.request'), false);
  await hub.receive(watch, { type: 'approve', requestId: 'id-missing' });
  const request = ownerT.frames.find((frame) => frame.type === 'approval.request');
  await hub.receive(watch, { type: 'approve', requestId: request.requestId, decision: 'yes' });
  assert.ok(watchT.frames.some((frame) => frame.type === 'error' && frame.code === 'not_owner'));
  hub.disconnect(owner);
  assert.equal(await approval, 'abort');
  assert.ok(watchT.frames.some((frame) => frame.type === 'run.ended' && frame.runId === runId && frame.status === 'cancelled' && frame.exitCode === 130));
});

test('ready lists a publisher run and the publisher is not echoed its own event', async () => {
  const hub = createHub({ token: 'secret', createId: () => 'pub1' });
  const pubT = pair();
  const clientT = pair();
  const pub = hub.connect(pubT);
  const client = hub.connect(clientT);
  await hub.receive(client, { type: 'hello', role: 'client', token: 'secret' });
  await hub.receive(pub, { type: 'hello', role: 'publisher', token: 'secret', command: 'run', title: 'run x', cwd: process.cwd() });
  assert.equal(pubT.frames.find((frame) => frame.type === 'ready').runs[0].id, 'pub1');
  await hub.receive(client, { type: 'subscribe', runId: 'pub1' });
  await hub.receive(pub, { type: 'event', event: { type: 'stage.start', stage: 'plan' } });
  assert.ok(clientT.frames.some((frame) => frame.type === 'run.event' && frame.event.stage === 'plan'));
  assert.equal(pubT.frames.some((frame) => frame.type === 'run.event'), false);
  hub.disconnect(pub);
  assert.ok(clientT.frames.some((frame) => frame.type === 'run.ended' && frame.status === 'cancelled' && frame.exitCode === 130));
});
```

The second test's `approve` with `requestId: 'id-missing'` must happen after `requestApproval`, so a real request exists and the missing id is `bad_request`, while the watcher's approve of the real id is `not_owner`. Assert both:

```javascript
assert.ok(watchT.frames.some((frame) => frame.code === 'bad_request'));
assert.ok(watchT.frames.some((frame) => frame.code === 'not_owner'));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/hub.test.js`

Expected: FAIL. Cannot find `src/server/hub.js`.

- [ ] **Step 3: Write the implementation**

Create `src/server/hub.js` with the behavior below. Use `randomUUID` from `node:crypto` as the default `createId`. Use `new Date().toISOString` as the default `now`.

Socket ids come from `randomUUID()`, not from `createId`. `createId` is only for run ids and approval `requestId`s. `connect` stores `{ id: randomUUID(), send, close, role: null, authed: false, subs: new Set(), all: false, runId: null }`. A client may own several runs. `disconnect` cancels every running run whose `ownerId` is that socket. A terminal socket's `runId` is its single run. Catalog frames are `{ type: 'run.started', run }` and `{ type: 'run.ended', runId, status, exitCode }`, where `run` is `{ id, source, command, title, cwd, status, startedAt }`. For `chat`, queue a non-empty `frame.prompt` on the run's input queue before calling `onStart`.

`receive` rules:

- Non-object frame: `{ type: 'error', code: 'bad_request', message: 'Кадр должен быть JSON-объектом.' }`.
- No `type` string: same `bad_request`.
- Before `authed`, only `hello` is legal. Anything else is `unauthorized`, then `close(1008)`.
- `hello.token !== token`: `{ type: 'error', code: 'unauthorized', message: 'Неверный токен.' }` and `close(1008)`.
- Already `authed`: `{ type: 'error', code: 'conflict', message: 'Повторный hello.' }`.
- `hello.role === 'client'`: set `authed`, `role`, send `{ type: 'ready', runs: <public running runs> }`.
- `hello.role === 'publisher'`: require `command` in `ask|run|chat|image`, `title` string, and `cwd` string. On failure send `bad_request` and stay unauthenticated. On success create a running terminal run owned by this socket, set `socket.runId`, send `ready`, then broadcast `{ type: 'run.started', run }`. Do not call `onStart`.
- `hello.role` anything else: `bad_request`.

Public run shape: `{ id, source, command, title, cwd, status, startedAt }`. `source` is `client` or `terminal`.

`start` (client role only; a publisher sending `start` gets `bad_request`):

- Allowed keys: `type`, `command`, `prompt`, `cwd`, `approve`, and the mapped option names `effort`, `summary`, `instructions`, `images`, `files`, `detail`, `out`, `session`, `store`, `web`, `imagesTool`, `tools`, `noTools`, `maxTurns`, `budgetUsd`, `budgetTokens`, `maxOutputTokens`, `temperature`, `verbosity`, `shell`, `stream`, `size`, `quality`, `format`, `imageBackground`, `partials`, `imageModel`, `count`, `schema`, `role`, `single`, `team`, `memory`.
- Keys `background`, `detach`, `job` or any other key: `{ type: 'error', code: 'invalid_start', message: 'Недопустимое поле <name>.' }`. No run.
- `command` not in `ask|run|chat|image`: `invalid_start`, message `Неизвестная команда.`
- Missing `prompt` for `ask`, `run`, or `image`: `invalid_start`, message `Укажите prompt.`
- `cwd` when present must be a string. The hub does not touch the filesystem. `serve` checks the directory before calling the model and calls `finish` itself if this validation is done outside. Do the directory check in `serve` (Task 4) before `onStart` runs work, but have the hub accept `cwd` as a string here. If `cwd` is present and not a string, `invalid_start`.
- `approve` when present must be `ask`, `read`, `write`, or `all`.
- Create the run (`source: 'client'`, status `running`, `controller: new AbortController()`), `socket.subs.add(run.id)`, broadcast `{ type: 'run.started', run }`. If `command === 'chat'` and `prompt` is a non-empty string, queue it for `waitInput` before `onStart`. Then `void Promise.resolve(onStart?.(run, frame)).catch((error) => { publish { type: 'warning', message: error.message }; finish(run.id, 'failed', error.exitCode ?? 1); })`.
- Default `onStart` is `async () => {}`. Tests that pass `onStart` returning a hanging promise keep the run running.

`subscribe`: `runId === '*'` sets `socket.all = true`. Otherwise if the id is not a running run, `{ type: 'error', code: 'unknown_run', message: 'Запуск не найден или уже завершён.' }`. A publisher may subscribe; it still does not receive `run.event` (the fan-out filter is by `socket.role === 'publisher'`).

`unsubscribe`: `runId === '*'` sets `socket.all = false`. Otherwise delete `socket.subs` entry. Unknown id: `unknown_run`.

`event` from a publisher: `publish(socket.runId, frame.event)`. If `frame.event` is not a plain object, `bad_request`. From a client: `bad_request`.

`end` from the owning publisher: `finish(socket.runId, frame.status, frame.exitCode)`. `status` must be `completed`, `failed`, or `cancelled`. Default exit code 0 for `completed`, else 1. From anyone else: `bad_request`.

`cancel` and `input`: only `socket.id === run.ownerId`. Else if the run is running and the sender is not the owner, `{ type: 'error', code: 'not_owner', message: 'Кадр может отправить только владелец запуска.' }`. If the run is not running, `unknown_run`. `cancel` aborts `run.controller` and `finish(id, 'cancelled', 130)`. `input` pushes text onto the run's queue and resolves the oldest `waitInput` waiter.

`approve` / `answer`: look up `requestId` in the pending map. Missing: `{ type: 'error', code: 'bad_request', message: 'Неизвестный requestId.' }`. Pending run owner is not this socket: `not_owner`. `approve` decision must be `yes|no|always|abort` or `bad_request`. Resolve the promise and delete the pending entry.

`publish(runId, event)` broadcasts `{ type: 'run.event', runId, event }` only to sockets where `role !== 'publisher'` and (`socket.all` or `socket.subs.has(runId)`). Catalog frames `run.started` and `run.ended` go to every `authed` socket, including publishers.

`requestApproval` publishes `{ type: 'approval.pending', name, category }` through `publish` (so watchers see it and the owner does too, as a run event), then `owner.send({ type: 'approval.request', runId, requestId, name, category, preview })`. `requestQuestion` does the same with `question.pending` and `question.request`. Both honor `signal` by resolving `'abort'` or `null` respectively. `requestId` comes from `createId`.

`waitInput` queues a waiter. If text is already queued, resolve immediately with the oldest text. On `signal` abort, reject an `Error` whose `name` is `AbortError` and `code` is `ABORT_ERR`.

`finish` is a no-op when the run is missing or not `running`. It sets status, broadcasts `run.ended` with `{ type: 'run.ended', runId, status, exitCode }`, rejects leftover input waiters with `AbortError`, resolves leftover approvals for that run with `'abort'` and questions with `null`, then deletes the run.

`disconnect`: drop the socket, then for every running run with `ownerId === socket.id` abort a client run's controller and `finish` it as `cancelled` / 130. That resolves pending approvals with `'abort'`.

`shutdown`: for every running client run, abort the controller and `finish(..., 'cancelled', 130)`. For every running terminal run, `finish(..., 'detached', 0)` without requiring the publisher socket to close.

`broadcast` calls `socket.send` inside try/catch and ignores a throw.

Unknown `type`: `{ type: 'error', code: 'unknown_type', message: 'Неизвестный тип кадра: <type>.' }`.

Append to `index.js`:

```javascript
export { createHub } from './src/server/hub.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/hub.test.js`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/server/hub.js test/hub.test.js index.js
git commit -m "feat: add a WebSocket run hub with owner-only approvals"
```

### Task 3: `ai serve` session file, hello, and subscribe

**Files:**
- Create: `src/commands/serve.js`
- Create: `test/serve.test.js`
- Modify: `src/cli.js`

**Interfaces:**
- Consumes: `listenProtocol` from Task 1 and `createHub` from Task 2.
- Produces:
  - `export async function serve(ctx) → number` blocking until `ctx.signal` aborts, then shutting the hub down and deleting `serve.json`.
  - `export async function startServe({ home, port = 0, token, onStart, signal }) → Promise<{ url, token, port, file, close }>`
  - `export function pidAlive(pid) → boolean`
  - CLI command name `serve`. `--port` is a string option used only by this command. `serve` is not in `NEEDS_API_KEY`.

- [ ] **Step 1: Write the failing test**

Create `test/serve.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { startServe, pidAlive } from '../src/commands/serve.js';

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, (value) => resolve(value));
    target.addEventListener('error', () => reject(new Error('socket error')));
  });
}
const framesOf = (ws, bucket) => ws.addEventListener('message', (event) => bucket.push(JSON.parse(String(event.data))));

test('serve writes serve.json, answers hello, and removes the file on close', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-'));
  const handle = await startServe({ home, token: 'a'.repeat(64) });
  try {
    const file = JSON.parse(await readFile(path.join(home, 'serve.json'), 'utf8'));
    assert.equal(file.url, handle.url);
    assert.equal(file.token, 'a'.repeat(64));
    assert.equal(file.pid, process.pid);
    const mode = (await stat(path.join(home, 'serve.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(pidAlive(file.pid), true);
    const ws = new WebSocket(handle.url);
    const frames = [];
    framesOf(ws, frames);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', role: 'client', token: 'a'.repeat(64) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames[0].type, 'ready');
    ws.close();
  } finally {
    await handle.close();
    await rm(home, { recursive: true, force: true });
  }
  await assert.rejects(readFile(path.join(home, 'serve.json'), 'utf8'));
});
```

`handle.close()` in this task only needs to shut the listener and delete the file. The assertion `rejects(readFile)` runs after `rm(home)`, so it passes even if the file was already deleted. Also assert inside `finally`, before `rm`, that the file is already gone:

```javascript
await handle.close();
await assert.rejects(readFile(path.join(home, 'serve.json'), 'utf8'));
await rm(home, { recursive: true, force: true });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/serve.test.js`

Expected: FAIL. Cannot find `src/commands/serve.js`.

- [ ] **Step 3: Write the minimal serve command**

Create `src/commands/serve.js` exporting `pidAlive`, `startServe`, and `serve`.

`pidAlive`:

```javascript
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
```

`startServe({ home, port = 0, token = randomBytes(32).toString('hex'), onStart, signal })`:

- `file = path.join(home, 'serve.json')`.
- If the file exists and its `pid` is alive, throw `UsageError` (`Не удалось запустить: сервер уже работает (pid <pid>).`). `UsageError` comes from `./shared.js`.
- If the file exists and the pid is dead, continue and overwrite it.
- `const hub = createHub({ token, onStart })`.
- `const listener = await listenProtocol({ port, host: '127.0.0.1', onConnection })`. If listen fails with `error.code === 'EADDRINUSE'`, throw `UsageError` (`Порт ${port} занят.`).
- `onConnection`: wrap `conn.send` so the hub's `send` does `conn.send(JSON.stringify(sanitizeValue(frame)))`. `sanitizeValue` is from `../ui/sanitize.js`. Chain incoming messages so one frame finishes `receive` before the next starts. `JSON.parse` failure sends `{ type: 'error', code: 'bad_request', message: 'Некорректный JSON.' }`. `conn` `'close'` calls `hub.disconnect(socket)`.
- Write `serve.json` with `{ pid: process.pid, url: listener.url, token, startedAt: new Date().toISOString() }`, `mode: 0o600`, after `mkdir(home, { recursive: true })`.
- `process.stderr.write(`WebSocket: ${listener.url}\nФайл: ${file}\n`)`. Do not write `token`.
- `close` calls `hub.shutdown()`, `listener.close()`, and `rm(file, { force: true })`.
- If `signal` aborts, call `close` once.

`serve(ctx)`:

- Read `ctx.values.port`. Missing means port 0. Present means `Number`; if it is not an integer 0..65535, throw `UsageError` (`--port: 0..65535`).
- `const handle = await startServe({ home: ctx.config.home, port, signal: ctx.signal })`.
- Return a promise that resolves with `0` when `ctx.signal` aborts. `startServe` already closes on that signal. Resolve after `handle.close` has been called by the signal handler (guard with a flag so `close` runs once). If `startServe` throws `UsageError`, let it propagate so `cli.js` maps it to exit 2.

Wire `src/cli.js`:

- Import `serve` from `./commands/serve.js`.
- Add `serve` to `COMMANDS` after `config: configCommand`. Do not add it to `NEEDS_API_KEY` or `DETACHABLE`.
- Add `port: { type: 'string' }` to `OPTIONS`.
- In `HELP`, add a line under the command list: `  ai serve [--port <n>]         локальная шина WebSocket (127.0.0.1; токен в ~/.ai-agent/serve.json)`.
- In the "Прочее" section add: `  --port <n>             порт для ai serve (0 — свободный)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/serve.test.js`

Expected: PASS, 1 test. stderr from the test process contains `WebSocket: ws://127.0.0.1:` and does not contain the 64-character token. The existing suite is unchanged; run it only in Task 6.

- [ ] **Step 5: Commit**

```powershell
git add src/commands/serve.js src/cli.js test/serve.test.js
git commit -m "feat: add ai serve with a token file and hello handshake"
```

### Task 4: Client-started runs and approvals

**Files:**
- Modify: `src/commands/serve.js`
- Modify: `test/serve.test.js`

**Interfaces:**
- Consumes: `startServe({ onStart })` from Task 3. This task replaces the default `onStart` inside `startServe` so `serve(ctx)` runs real commands. Tests can still pass `onStart` to bypass commands; when `onStart` is omitted, `startServe` uses the command runner built here.
- Produces: a `start` frame with `command: 'ask'|'run'|'chat'|'image'` executes that command. The owner socket receives `approval.request` / `question.request`. `input` feeds `chat`.

- [ ] **Step 1: Write the failing test**

Append to `test/serve.test.js`. Import `startMockServer` from `./helpers/mock-server.js`.

```javascript
test('ask over the socket waits for the owner approval and ignores a watcher', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-ask-'));
  const work = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-work-'));
  const server = await startMockServer({
    script: (body) => (body.input?.some((item) => item.type === 'function_call_output')
      ? { text: 'готово' }
      : { calls: [{ name: 'write_file', arguments: { path: 'note.txt', content: 'ok\n', overwrite: true } }] }),
  });
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    AI_MODEL: process.env.AI_MODEL, AI_AGENT_HOME: process.env.AI_AGENT_HOME,
  };
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = server.baseURL;
  process.env.AI_MODEL = 'mock-model';
  process.env.AI_AGENT_HOME = home;
  const handle = await startServe({ home });
  try {
    const ownerFrames = [];
    const watchFrames = [];
    const owner = new WebSocket(handle.url);
    const watch = new WebSocket(handle.url);
    framesOf(owner, ownerFrames);
    framesOf(watch, watchFrames);
    await once(owner, 'open');
    await once(watch, 'open');
    owner.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
    watch.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
    await delay(30);
    watch.send(JSON.stringify({ type: 'subscribe', runId: '*' }));
    owner.send(JSON.stringify({ type: 'start', command: 'ask', prompt: 'создай note.txt', cwd: work, approve: 'ask', tools: 'fs' }));
    const request = await waitFor(ownerFrames, (frame) => frame.type === 'approval.request');
    watch.send(JSON.stringify({ type: 'approve', requestId: request.requestId, decision: 'yes' }));
    await waitFor(watchFrames, (frame) => frame.code === 'not_owner');
    assert.ok(watchFrames.some((frame) => frame.type === 'run.event' && frame.event.type === 'approval.pending'));
    assert.equal(watchFrames.some((frame) => frame.type === 'approval.request'), false);
    owner.send(JSON.stringify({ type: 'approve', requestId: request.requestId, decision: 'yes' }));
    await waitFor(ownerFrames, (frame) => frame.type === 'run.ended' && frame.status === 'completed');
    assert.equal(await readFile(path.join(work, 'note.txt'), 'utf8'), 'ok\n');
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(frames, pred) {
  for (let i = 0; i < 100; i++) {
    const found = frames.find(pred);
    if (found) return found;
    await delay(20);
  }
  throw new Error(`frame not seen: ${JSON.stringify(frames)}`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/serve.test.js`

Expected: FAIL. The first test still passes. The new test fails because `start` creates no run (or `onStart` is a no-op) and `approval.request` never arrives.

- [ ] **Step 3: Implement the command runner**

In `startServe`, when `onStart` is omitted, use an internal `runClientCommand({ baseEnv: process.env, home, signal })`.

Map frame fields to CLI `values` with this object:

```javascript
const FIELD_MAP = {
  effort: 'effort', summary: 'summary', instructions: 'instructions', images: 'image', files: 'file',
  detail: 'detail', out: 'out', session: 'session', store: 'store', web: 'web', imagesTool: 'images',
  tools: 'tools', noTools: 'no-tools', maxTurns: 'max-turns', budgetUsd: 'budget-usd', budgetTokens: 'budget-tokens',
  maxOutputTokens: 'max-output-tokens', temperature: 'temperature', verbosity: 'verbosity', shell: 'shell',
  stream: 'stream', size: 'size', quality: 'quality', format: 'format', imageBackground: 'image-background',
  partials: 'partials', imageModel: 'image-model', count: 'count', schema: 'schema', role: 'role',
  single: 'single', team: 'team', memory: 'memory',
};
const AS_STRING = new Set(['max-turns', 'budget-usd', 'budget-tokens', 'max-output-tokens', 'temperature', 'partials', 'count']);
```

Build `values` so `overridesFrom` sees the same types the CLI produces. Copy `approve` through (default `'ask'`). Numeric fields become strings. `stream: false` stays boolean. Leave `memory`, `store`, `web`, `single`, `team`, `no-tools` as booleans.

Load config with `loadConfig({ overrides: overridesFrom(values), env: process.env, ensureHome: false })`. `cwd` is `path.resolve(frame.cwd ?? process.cwd())`. If `stat` says it is not a directory, `publish` nothing new; `finish(run.id, 'failed', 2)` after publishing `{ type: 'warning', message: 'Каталог не найден: <cwd>' }`. The hub has already created the run before `onStart`, so this is the directory check.

Renderer: `createRenderer({ mode: 'json', stdout, stderr, stdin })`. `stdout` is a `Writable` that splits on `\n`, `JSON.parse`s each line, and calls `hub.publish(run.id, parsed)`. `stderr` is a `Writable` that discards chunks. `stdin` is an empty `Readable`. Wrap the returned renderer:

- `get interactive() { return true; }`
- `approve(request, opts) { return hub.requestApproval(run.id, request, opts?.signal); }`
- `ask(question, opts) { return hub.requestQuestion(run.id, question, opts?.signal); }`
- `readline() { return { question(_prompt, opts) { return hub.waitInput(run.id, opts?.signal); } }; }`

Spreading the renderer object invokes getters. Define the `interactive` getter on the wrapper after the spread so it stays `true`.

Command table: `{ ask, run, chat, image }` imported from the existing command modules. Context:

```javascript
{
  argv: [], values, positionals: frame.prompt ? [frame.prompt] : [], config, renderer, cwd,
  controller: run.controller, signal: run.controller.signal, emit: renderer.handle, reporter: null, backupDir: null,
  setTurnController() {},
  turnSignal: () => run.controller.signal,
}
```

No API key: publish `{ type: 'warning', message: 'Не задан OPENAI_API_KEY.' }` and `finish(run.id, 'failed', 2)` before calling the command. `ask`, `run`, `chat`, and `image` all need a key.

Call the command. Map its return code with: `0 → completed`, `130 → cancelled`, `2 → failed`, anything else → `failed`, and pass the code as `exitCode`. `UsageError` inside the command already returns through `cli.js` today; here it will throw. Catch it, publish `{ type: 'warning', message: error.message }`, and `finish` with exit code `error.exitCode ?? 1` and status `failed` (use `cancelled` when the code is 130). Ignore a second `finish` (the hub already no-ops).

`chat` reads lines only from `readline()`, not from `positionals`. The hub already queues a non-empty `chat` prompt before `onStart`, so the first `question()` returns it. `positionals` for `chat` stay empty. `ask`, `run`, and `image` receive `positionals: [frame.prompt]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/serve.test.js`

Expected: PASS, 2 tests. `note.txt` contains `ok\n`.

- [ ] **Step 5: Commit**

```powershell
git add src/commands/serve.js src/server/hub.js test/serve.test.js
git commit -m "feat: run ask, run, chat, and image from a WebSocket client"
```

### Task 5: Terminal publisher (`--serve`)

**Files:**
- Create: `src/server/publish.js`
- Modify: `src/cli.js`
- Modify: `test/serve.test.js`
- Test: `test/serve.test.js` (`splitServeUrl` and `assertLoopback` live in `src/server/publish.js`).

**Interfaces:**
- Consumes: a running `startServe` bus and the global `WebSocket`.
- Produces:
  - `splitServeUrl(argv) → { argv, serveUrl }`
  - `assertLoopback(url) → URL` throws `UsageError` when the protocol is not `ws:` or the host is not `127.0.0.1` or `localhost`.
  - `readServeFile(home) → Promise<{ url, token, pid }>`
  - `attachPublisher({ home, url, command, title, cwd }) → Promise<{ event(event), end(status, exitCode), close() }>`
  - CLI: `--serve` boolean. A following `ws://…` argument is lifted by `splitServeUrl` before `parseArgs`. `ai serve --serve` throws `UsageError` with message `ai serve --serve нельзя сочетать.`.

- [ ] **Step 1: Write the failing test**

Append to `test/serve.test.js`:

```javascript
import { splitServeUrl, assertLoopback, attachPublisher } from '../src/server/publish.js';

test('splitServeUrl lifts only a ws URL that follows --serve', () => {
  assert.deepEqual(splitServeUrl(['run', 'x', '--serve']), { argv: ['run', 'x', '--serve'], serveUrl: null });
  assert.deepEqual(splitServeUrl(['run', '--serve', 'ws://127.0.0.1:9', '--yes']), { argv: ['run', '--serve', '--yes'], serveUrl: 'ws://127.0.0.1:9' });
  assert.throws(() => assertLoopback('wss://127.0.0.1:9'), /127\.0\.0\.1/);
  assert.throws(() => assertLoopback('ws://example.com:9'), /127\.0\.0\.1/);
  assert.equal(assertLoopback('ws://localhost:9').hostname, 'localhost');
});

test('attachPublisher registers a terminal run and forwards an event', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-pub-'));
  const handle = await startServe({ home, token: 'b'.repeat(64) });
  const watchFrames = [];
  try {
    const watch = new WebSocket(handle.url);
    framesOf(watch, watchFrames);
    await once(watch, 'open');
    watch.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
    const publisher = await attachPublisher({ home, command: 'run', title: 'run demo', cwd: process.cwd() });
    const started = await waitFor(watchFrames, (frame) => frame.type === 'run.started' && frame.run.source === 'terminal');
    watch.send(JSON.stringify({ type: 'subscribe', runId: started.run.id }));
    publisher.event({ type: 'stage.start', stage: 'plan' });
    await waitFor(watchFrames, (frame) => frame.type === 'run.event' && frame.event.stage === 'plan');
    await publisher.end('completed', 0);
    await waitFor(watchFrames, (frame) => frame.type === 'run.ended' && frame.status === 'completed' && frame.exitCode === 0);
    watch.close();
  } finally {
    await handle.close();
    await rm(home, { recursive: true, force: true });
  }
});
```

`run.started` is `{ type: 'run.started', run }` with the public run object from Task 2. `ready.runs` uses the same object shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/serve.test.js`

Expected: FAIL on the new tests. `splitServeUrl` is not exported.

- [ ] **Step 3: Implement the publisher and the CLI flag**

Create `src/server/publish.js`:

```javascript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeValue } from '../ui/sanitize.js';
import { UsageError } from '../commands/shared.js';

export function splitServeUrl(argv) {
  const out = [];
  let serveUrl = null;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--serve' && typeof next === 'string' && /^wss?:\/\//.test(next)) {
      serveUrl = next;
      out.push('--serve');
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return { argv: out, serveUrl };
}

export function assertLoopback(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new UsageError(`Некорректный адрес --serve: ${value}`); }
  if (url.protocol !== 'ws:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new UsageError('Адрес --serve должен быть ws://127.0.0.1 или ws://localhost.');
  }
  return url;
}

export async function readServeFile(home) {
  const file = path.join(home, 'serve.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new UsageError(`Нет запущенного ai serve. Ожидался ${file}.`); }
}

export async function attachPublisher({ home, url = null, command, title, cwd }) {
  const info = url ? { url, token: (await readServeFile(home)).token } : await readServeFile(home);
  if (url) assertLoopback(url);
  else assertLoopback(info.url);
  const ws = new WebSocket(info.url);
  const frames = [];
  ws.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new UsageError(`Не удалось подключиться к ${info.url}.`)));
  });
  ws.send(JSON.stringify({ type: 'hello', role: 'publisher', token: info.token, command, title, cwd }));
  const ready = await waitReady(frames);
  if (ready?.code === 'unauthorized') throw new UsageError('Токен ai serve не принят.');
  return {
    event(event) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', event: sanitizeValue(event) })); },
    end(status, exitCode) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end', status, exitCode })); },
    close() { ws.close(); },
  };
}

async function waitReady(frames) {
  for (let i = 0; i < 50; i++) {
    const found = frames.find((frame) => frame.type === 'ready' || frame.type === 'error');
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new UsageError('ai serve не ответил на hello.');
}
```

When `url` is passed, the token still comes from `serve.json` in `home`. The spec's `--serve ws://…` overrides the address only. Document that in a one-line comment above `attachPublisher`.

In `src/cli.js` `main`, before `parseArgs`:

```javascript
const split = splitServeUrl(argv);
argv = split.argv;
```

`main(argv = process.argv.slice(2))` reassigns the local binding. Use `let argvArg = argv` or parse `split.argv` directly: `parseArgs({ args: split.argv, ...})`.

Add `serve: { type: 'boolean', default: false }` to `OPTIONS`.

After the API-key check and before detach handling:

```javascript
if (values.serve && commandName === 'serve') throw new UsageError('ai serve --serve нельзя сочетать.');
let publisher = null;
if (values.serve) {
  publisher = await attachPublisher({
    home: config.home, url: split.serveUrl, command: commandName,
    title: `${commandName} ${rest.join(' ')}`.trim(), cwd,
  });
}
```

`split` must be in scope. Declare it next to `parseArgs`. Change `emit` to:

```javascript
const emit = (event) => { renderer.handle(event); publisher?.event(event); reporter?.event(event); };
```

In the `finally` of `main`, before `renderer.close()`:

```javascript
await publisher?.end(exitCode === 0 ? 'completed' : exitCode === 130 ? 'cancelled' : 'failed', exitCode)?.catch(() => {});
publisher?.close();
```

`exitCode` is already assigned on every return path inside `try` / `catch`. The `finally` runs after `return exitCode`, and `exitCode` is the outer `let`. Good.

Add to `HELP` under "Фон": `  --serve [ws://127.0.0.1:порт]  публиковать события этого запуска в ai serve`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-timeout=60000 test/serve.test.js test/hub.test.js test/protocol.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/server/publish.js src/cli.js test/serve.test.js
git commit -m "feat: publish terminal runs to ai serve with --serve"
```

### Task 6: CLI integration test and docs

**Files:**
- Modify: `test/serve.test.js`
- Modify: `README.md`
- Modify: `src/cli.js` HELP line for `ai serve` so it says the owning socket answers `approval.request`.

**Interfaces:**
- Consumes: the CLI binary `bin/ai.js`, `startServe` is not used. This task spawns `node bin/ai.js serve`.
- Produces: the spec's end-to-end test and the README command row plus a short section.

- [ ] **Step 1: Write the failing test**

Append the CLI spawn test below. Step 2 runs it before the README edit. Expected: FAIL until `run.started` includes `run` and the child stops on SIGINT, or PASS if Tasks 3–5 already did both. A passing Step 2 still continues to the README edit.

```javascript
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('ai serve CLI: publisher event, ask approval, watcher cannot approve', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-cli-'));
  const work = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-cli-work-'));
  const mock = await startMockServer({
    script: (body) => body.input?.some((item) => item.type === 'function_call_output')
      ? { text: 'готово' }
      : { calls: [{ name: 'write_file', arguments: { path: 'note.txt', content: 'ok\n', overwrite: true } }] },
  });
  const bin = fileURLToPath(new URL('../bin/ai.js', import.meta.url));
  const child = spawn(process.execPath, [bin, 'serve'], {
    cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: mock.baseURL, AI_MODEL: 'mock-model', AI_AGENT_HOME: home, NO_COLOR: '1' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const info = await waitForFile(path.join(home, 'serve.json'));
    assert.match(stderr, /WebSocket: ws:\/\/127\.0\.0\.1:/);
    assert.equal(stderr.includes(info.token), false);
    const owner = new WebSocket(info.url);
    const watch = new WebSocket(info.url);
    const publisher = new WebSocket(info.url);
    const ownerFrames = [], watchFrames = [], publisherFrames = [];
    framesOf(owner, ownerFrames);
    framesOf(watch, watchFrames);
    framesOf(publisher, publisherFrames);
    await Promise.all([once(owner, 'open'), once(watch, 'open'), once(publisher, 'open')]);
    const hello = (token, extra) => JSON.stringify({ type: 'hello', token, ...extra });
    owner.send(hello(info.token, { role: 'client' }));
    watch.send(hello(info.token, { role: 'client' }));
    publisher.send(hello(info.token, { role: 'publisher', command: 'run', title: 'run demo', cwd: work }));
    const published = await waitFor(publisherFrames, (frame) => frame.type === 'run.started');
    watch.send(JSON.stringify({ type: 'subscribe', runId: published.run.id }));
    publisher.send(JSON.stringify({ type: 'event', event: { type: 'stage.start', stage: 'plan' } }));
    await waitFor(watchFrames, (frame) => frame.event?.stage === 'plan');
    owner.send(JSON.stringify({ type: 'start', command: 'ask', prompt: 'создай note.txt', cwd: work, approve: 'ask', tools: 'fs' }));
    const started = await waitFor(ownerFrames, (frame) => frame.type === 'run.started' && frame.run.source === 'client');
    watch.send(JSON.stringify({ type: 'subscribe', runId: started.run.id }));
    const request = await waitFor(ownerFrames, (frame) => frame.type === 'approval.request');
    watch.send(JSON.stringify({ type: 'approve', requestId: request.requestId, decision: 'yes' }));
    await waitFor(watchFrames, (frame) => frame.code === 'not_owner');
    owner.send(JSON.stringify({ type: 'approve', requestId: request.requestId, decision: 'yes' }));
    await waitFor(ownerFrames, (frame) => frame.type === 'run.ended' && frame.runId === started.run.id && frame.status === 'completed');
    await waitFor(watchFrames, (frame) => frame.type === 'run.event' && frame.event.type === 'approval.pending');
    assert.equal(await readFile(path.join(work, 'note.txt'), 'utf8'), 'ok\n');
    publisher.send(JSON.stringify({ type: 'end', status: 'completed', exitCode: 0 }));
  } finally {
    child.kill('SIGINT');
    await once(child, 'exit');
    await mock.close();
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

async function waitForFile(file) {
  for (let i = 0; i < 50; i++) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch { await delay(40); }
  }
  throw new Error(`missing ${file}`);
}
```

`once(child, 'exit')` uses `child.once`, not `addEventListener`. Write a two-line `onceEvent(emitter, name)` for the process and keep `once` for WebSocket `EventTarget`s.

The mock must return `text: 'готово'` on the turn that contains `function_call_output`, otherwise the tool loop continues. The `script` above does that. `write_file` content must be exactly `ok\n`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=60000 test/serve.test.js`

Expected: PASS. If `run.started` has no `run` field, or SIGINT leaves the child running, fix that wiring and rerun this command until it passes.

- [ ] **Step 3: Document the command**

In `README.md`, add a row to the command block:

```
ai serve [--port <n>]        локальная шина WebSocket на 127.0.0.1
```

Add a subsection after the command list:

```markdown
### Локальная шина

`ai serve` слушает `ws://127.0.0.1:<порт>` и пишет адрес и токен в `~/.ai-agent/serve.json` (права `0600`). Токен в журнал не попадает.

Терминальная команда публикует свои события, не отдавая исполнение серверу:

```bash
ai run "добавь тест" --serve
ai run "добавь тест" --serve ws://127.0.0.1:8765
```

Клиент WebSocket после `hello` с токеном может отправить `start` (`ask`, `run`, `chat`, `image`) и подписаться на любой запуск. Подтверждения записи и команд для клиентского запуска приходят кадром `approval.request` тому сокету, который отправил `start`. Наблюдатели получают события и не могут подтверждать действия.

`ai jobs` и `--detach` не меняются.
```

In `src/cli.js` HELP, the `ai serve` line and the `--serve` line are already present from Tasks 3 and 5. Add the sentence that client approvals are answered on the owning socket, on the `ai serve` HELP line:

`  ai serve [--port <n>]         шина WebSocket на 127.0.0.1; клиент, отправивший start, отвечает на approval.request`

- [ ] **Step 4: Run the full suite**

Run: `node --test --test-timeout=60000 "test/*.test.js"`

Expected: PASS, including the previous 53 tests plus the protocol, hub, and serve tests. No skipped tests.

- [ ] **Step 5: Commit**

```powershell
git add test/serve.test.js README.md src/cli.js
git commit -m "docs: describe ai serve and cover it with a CLI test"
```
