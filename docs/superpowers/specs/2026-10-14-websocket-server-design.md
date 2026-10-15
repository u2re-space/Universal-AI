# WebSocket server mode

`ai serve` is a local event bus. Terminal commands keep doing their work and publish events into it. WebSocket clients can start their own `ask`, `run`, `chat`, and `image` runs on that same bus and answer approval prompts themselves. Watchers can subscribe to either kind of run.

The process stays on Node.js built-in modules. Node 26 has a WebSocket client and no WebSocket server, so the server is a small protocol on `node:http`.

## Non-goals

- Binding outside `127.0.0.1`.
- TLS (`wss://`).
- Replacing `ai jobs` / `--detach`.
- Binary frames or raw image bytes on the socket. Paths and URLs are loaded on the machine that executes the run, through the existing attachment code.
- A fixed cap on concurrent runs.

## Architecture

`ai serve` listens on `127.0.0.1` and an ephemeral port (`--port` pins one). It keeps a run list in memory. Each run has an id, a source (`client` or `terminal`), a command, a title, a working directory, a status, and an owner socket. The server assigns every id.

A terminal command attaches with `--serve`. That process still calls the model, uses tools, draws the terminal, and asks for approval there. It connects as a publisher, registers one run, and forwards the same events `emit` already produces. Closing the terminal removes that run from the bus. The terminal's work does not move into the server process.

A WebSocket client starts work inside the server process. The server calls the existing `ask`, `run`, `image`, or `chat` function. Approval prompts and `ask_user` questions go only to the connection that started the run. Tools wait for that client's answer. Other subscribers receive events and cannot approve them.

On startup the server writes `~/.ai-agent/serve.json` (the config home, mode `0600`):

```json
{ "pid": 123, "url": "ws://127.0.0.1:54321", "token": "<64 hex chars>", "startedAt": "<ISO>" }
```

The token is 32 random bytes, hex-encoded. It is never written to the log. `--serve` with no URL reads this file. A client must send the token in its first message.

Catalog frames (`ready`, `run.started`, `run.ended`) go to every socket that has completed `hello`. The full event stream of a client run goes to that run's owner and to sockets that subscribed. Subscribers of a terminal run receive the events the publisher forwards. A publisher does not get its own events echoed back.

## Wire protocol

JSON text frames. One object per frame. Strings are passed through the existing `sanitizeValue` helper before they are sent, so the stream matches `ai --json` and contains no raw base64 image payloads.

The server answers client pings, sends a ping every 30 seconds, and closes a socket that has been silent for 90 seconds. Those control frames are not visible to the hub.

### Join

Client:

```json
{ "type": "hello", "role": "client", "token": "…" }
```

Publisher (one run per socket):

```json
{ "type": "hello", "role": "publisher", "token": "…", "command": "run", "title": "run add tests", "cwd": "C:/work" }
```

`command` is `ask`, `run`, `chat`, or `image`. `title` is a short label. `cwd` must already be a directory.

The server replies:

```json
{ "type": "ready", "runs": [ { "id": "…", "source": "terminal", "command": "run", "title": "…", "cwd": "…", "status": "running", "startedAt": "…" } ] }
```

A publisher then also receives `run.started` for the run just created. The publisher socket owns that run. It does not receive its own events echoed back; it gets `ready`, `run.started`, `run.ended`, and `error` only.

A bad token, a non-object first frame, or any frame before `hello` produces an `error` frame with code `unauthorized` and the socket is closed with close code 1008.

### Client starts work

```json
{
  "type": "start",
  "command": "ask",
  "prompt": "…",
  "cwd": "C:/work",
  "approve": "ask",
  "model": "gpt-6.1-sol"
}
```

`prompt` is required for `ask`, `run`, and `image`. For `chat` it is optional and, when present, is the first user message. `cwd` defaults to the server's working directory and must already exist. `approve` is `ask`, `read`, `write`, or `all`. When omitted, client runs use `ask`.

Other accepted fields, matching CLI flags: `effort`, `summary`, `instructions`, `images`, `files`, `detail`, `out`, `session`, `store`, `web`, `imagesTool`, `tools`, `noTools`, `maxTurns`, `budgetUsd`, `budgetTokens`, `maxOutputTokens`, `temperature`, `verbosity`, `shell`, `stream`, `size`, `quality`, `format`, `imageBackground`, `partials`, `imageModel`, `count`, `schema`, `role`, `single`, `team`, `memory`. Unknown fields are rejected. `background`, `detach`, and `job` are rejected. `images` and `files` are arrays of paths or URLs, resolved on the server against `cwd`. `role` is an array of `name=model[:effort]` strings. `schema` is a path to a JSON schema file.

The connection that sends `start` becomes the owner and is subscribed to the new run. The server emits `run.started` to every authenticated socket.

### Chat input and cancel

`chat` stays open until the slash command exits it, the owner cancels it, or the owner socket closes.

```json
{ "type": "input", "runId": "…", "text": "next line" }
```

One `input` frame is one completed message. The terminal's trailing-`\` and `"""` continuations still apply inside `chat` if a single frame uses them; clients send the finished text in one frame.

```json
{ "type": "cancel", "runId": "…" }
```

`cancel` aborts the run's `AbortController`. Only the owner may send `input` or `cancel`.

### Approvals

Only the owner receives control frames:

```json
{ "type": "approval.request", "runId": "…", "requestId": "…", "name": "write_file", "category": "write", "preview": "…" }
{ "type": "question.request", "runId": "…", "requestId": "…", "question": "…" }
```

`requestId` is unique on the server. The owner answers:

```json
{ "type": "approve", "requestId": "…", "decision": "yes" }
{ "type": "answer", "requestId": "…", "text": "…" }
```

`decision` is `yes`, `no`, `always`, or `abort`. Tools wait until that answer arrives or the owner socket closes. There is no separate approval timer. If the owner disconnects, a pending decision resolves as `abort` and the run is cancelled.

Watchers of a client run receive a normal event so they can see the pause:

```json
{ "type": "run.event", "runId": "…", "event": { "type": "approval.pending", "name": "write_file", "category": "write" } }
{ "type": "run.event", "runId": "…", "event": { "type": "question.pending", "question": "…" } }
```

They do not receive `approval.request` or `question.request`. Their `approve` and `answer` frames are rejected with `not_owner`.

Publisher runs do not synthesize these control frames. The terminal asks locally. Watchers see only the events the terminal already emits.

### Watching

```json
{ "type": "subscribe", "runId": "<id>" }
{ "type": "subscribe", "runId": "*" }
{ "type": "unsubscribe", "runId": "<id>" }
```

`*` subscribes to every current and future run. `unsubscribe` with `runId: "*"` clears that. A new subscriber receives only events published after the subscribe frame; there is no replay. The `ready` list is how a late client learns which runs already exist. Subscribers receive:

```json
{ "type": "run.event", "runId": "…", "event": { "type": "tool.exec.start", "name": "read_file" } }
{ "type": "run.ended", "runId": "…", "status": "completed", "exitCode": 0 }
```

`run.started` and `run.ended` also go to every authenticated socket, including sockets that have not subscribed. `status` is `completed`, `failed`, `cancelled`, or `detached`.

### Publisher stream

The publisher omits `runId`; the socket already owns one run.

```json
{ "type": "event", "event": { "type": "stage.start", "stage": "plan" } }
{ "type": "end", "status": "completed", "exitCode": 0 }
```

`status` on `end` is `completed`, `failed`, or `cancelled`. If the publisher socket closes without `end`, watchers receive `run.ended` with status `cancelled` and exit code 130.

### Errors

A socket that fails `hello` is closed. Every later mistake keeps the socket open and sends:

```json
{ "type": "error", "code": "invalid_start", "message": "…" }
```

Messages are Russian, matching the CLI. Codes:

| Code | When |
| --- | --- |
| `unauthorized` | Bad or missing token. Socket closed, close code 1008. |
| `bad_request` | Malformed JSON, a frame that is not an object, or a missing field. |
| `unknown_type` | `type` is not one of the frames above. |
| `conflict` | A second `hello` on the same socket. |
| `invalid_start` | Unknown command, missing prompt for `ask` / `run` / `image`, unknown field, rejected field, or `cwd` that is not an existing directory. No run is created. |
| `not_owner` | `approve`, `answer`, `input`, or `cancel` from a socket that does not own the run. |
| `unknown_run` | `subscribe`, `unsubscribe`, `input`, or `cancel` for an id that is not running. `approve` or `answer` for an unknown `requestId` uses `bad_request`. |
| `too_large` | Frame over 1 MiB. Socket closed, close code 1009. |

A binary data frame closes the socket with close code 1003. Fragmented messages and non-UTF-8 text close it with 1007. One socket has one role for its whole life.

## Modules

### `src/server/protocol.js`

Speaks WebSocket over an `node:http` upgrade. Accepts the handshake (`Sec-WebSocket-Accept` via `node:crypto`), unmasks client frames, and yields complete text messages. Responds to ping with pong, sends the server ping interval, and enforces the 1 MiB limit. No knowledge of runs, tokens, or the model.

### `src/server/hub.js`

The run list. Checks the token, assigns ids, remembers the owner, tracks subscribers, and fans out catalog frames and run events. An approval wait is a promise stored under `requestId`. `createHub({ token })` returns that object and does not open a socket. Used by tests directly.

### `src/commands/serve.js`

The `ai serve` command. Binds the port, writes and removes `serve.json`, accepts sockets, and dispatches frames.

A `start` frame builds the same context the CLI builds. The base config is the server's `loadConfig` result. Fields on the frame are applied with the existing override path for that run only and are not written back to disk. The run's `cwd` is the frame's `cwd`. Camel-case frame fields are mapped onto the `values` object commands already read (`images` → `values.image`, `imagesTool` → `values.images`, `noTools` → `values['no-tools']`, `maxTurns` → `values['max-turns']`, and the same way for the other flags). Run ids come from `node:crypto` `randomUUID`.

`ai serve` itself does not require `OPENAI_API_KEY`. A client command that needs a key fails that run with the same usage error the CLI would print, delivered as a `run.event` warning plus `run.ended` status `failed` and exit code 2.

The renderer for a client run is `createRenderer({ mode: 'json', stdout })` where `stdout` is a line sink: each JSON line is published through the hub as `run.event`. The server terminal does not print those events. A wrapper around that renderer replaces three behaviors:

- `interactive` is true, so `chat` accepts the session.
- `approve` and `ask` send `approval.request` / `question.request` to the owner, publish the watcher `approval.pending` / `question.pending` events, and wait on the hub. An aborted signal resolves `approve` as `abort` and `ask` as `null`.
- `readline().question()` ignores the painted prompt and resolves with the next `input` frame for this run.

`ctx.emit` is `renderer.handle`, so tool and team events travel through the same sink.

### `src/server/publish.js`

The terminal side of `--serve`. Connects with the global `WebSocket` client, sends the publisher `hello`, waits for `ready`, then wraps `emit`:

```js
(event) => { renderer.handle(event); socket.send(JSON.stringify({ type: 'event', event: sanitizeValue(event) })); }
```

On process exit it sends `end` when the socket is still open. It refuses any URL whose host is not `127.0.0.1` or `localhost`, so the token is not sent off the machine.

### CLI

`src/cli.js` registers the `serve` command and a `--serve` flag. `--port <n>` applies only to `ai serve`.

`--serve` takes an optional URL. A pre-pass lifts a following `ws://…` argument out of argv before `parseArgs`, because `node:util` cannot express an optional option value. `ai run "…" --serve` reads `serve.json`. `ai run "…" --serve ws://127.0.0.1:54321` uses that URL. `ai serve --serve` is a usage error (exit 2).

`index.js` exports `createHub` and the protocol listener so tests can drive them without spawning the CLI.

## Failure and lifetime

If `serve.json` names a pid that is still running (`process.kill(pid, 0)` does not throw), the new `ai serve` exits 2 and leaves the file in place. A stale file is replaced. If the port is taken, the process exits 2. On a successful bind the process prints the URL and the `serve.json` path to stderr, and does not print the token.

On SIGINT or SIGTERM the server aborts client-started runs, closes every socket, and deletes `serve.json`. Subscribers receive `run.ended` with status `cancelled` for runs the server owned, and `detached` for runs it was only watching. A publishing terminal keeps running and keeps its local approval prompts.

Exit codes of `ai serve`: 0 on a clean signal shutdown, 2 when the server is already running, the port is taken, or the arguments are wrong, 1 on an unexpected throw.

Client-run exit codes follow the CLI: 0 success, 1 failed or unfinished, 2 usage or configuration, 130 cancelled.

## Tests

Protocol tests use the built-in `WebSocket` client against a listener on `127.0.0.1` with port 0: handshake, a text frame round-trip, ping/pong, a binary frame closed with 1003, and a frame over 1 MiB closed with 1009.

Hub tests call `createHub` with no network: a wrong token is rejected, a subscriber receives a published event, a non-owner `approve` is rejected, and dropping the owner resolves the pending approval as `abort` and marks the run cancelled.

One CLI test starts `ai serve` on a random port with the existing mock model server and `AI_AGENT_HOME` pointed at a temp directory. A publisher socket registers a run and its forwarded event is visible to a subscriber. A client socket `start`s an `ask` with `tools: "fs"` and `approve: "ask"`; the mock model requests `write_file`. The owner receives `approval.request` and answers `yes`. A second socket, subscribed only, sees `approval.pending` and `run.event`, and its own `approve` frame receives `not_owner`. Both sockets then observe `run.ended`.

## Docs

`README.md` and the `ai --help` text gain `ai serve [--port n]` and `--serve [ws://127.0.0.1:port]`, including the token file path and that approval of client runs is answered on the socket that started the run.
