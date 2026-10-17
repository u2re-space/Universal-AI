# Agent Processing API

**Date:** 2026-10-17
**Status:** approved for planning

## Goal

During a client run started on `ai serve`, an authenticated socket can execute selected agent tools in place of Node. The model still calls the same tool names. The host returns the same `{ output, summary }` the model already sees, plus an optional list of file changes. The agent records those changes and refreshes the project map.

The first consumers are a test socket in this repository. A VS Code extension and an SSH host are later clients of this contract.

## Non-goals

- A VS Code extension, an SSH host, or any other product that implements the host.
- Replacing Node for a terminal run attached with `--serve` (role `publisher`). Those tools keep running in the terminal process.
- Primitive filesystem operations. The host implements a whole tool.
- Agent-side `.backup` copies for a result that came from a host.
- `make_dir` and every tool outside the list below.
- A processing timer. A call waits until a result, a disconnect, or cancellation of the run.
- Binding outside `127.0.0.1`, TLS, or a new frame size. The existing 1 MiB incoming limit and `sanitizeValue` on send stay as they are.

## Processable tools

A claim may name only these tools:

`delete_file`, `list_files`, `read_file`, `replace_text`, `run_command`, `run_script`, `search_files`, `write_file`

Unclaimed names, and every other tool, keep their current Node handlers. The hub does not check whether the run's `tools` flag enabled a name. A claimed name that the run never calls simply sits unused.

## Architecture

`execute` in `src/agent/tools.js` already asks for approval, then calls the local handler. After a permitted call, and only for a processable name, it asks an optional `processTool(name, args, signal)`.

- A missing `processTool`, or a `null` result, runs the local handler, including its backup and its own map update.
- A result object is the tool result. The local handler does not run. No `.backup` copy is made. `labelOutsideEdit` is not applied. The host's `output` is what the model sees.
- A thrown error becomes the usual tool failure (`ok: false`, output `Ошибка: …`), except cancellation, which still propagates.

`src/commands/serve.js` sets `ctx.processTool` only for a run created by `start`. That function calls `hub.requestTool`. `ask`, `chat`, the single-agent path in `run`, and `runTeam` pass `ctx.processTool` into every `createToolset` they build. With the option omitted, those commands behave as they do today.

Approval is unchanged. `decide` runs before `processTool`. A denied call never reaches the hub. `approval.request` still goes only to the run owner.

## Claim registry

Each client run keeps `holders`: a map from tool name to socket id. A name has one holder. A socket may hold several names. Claims on different runs do not affect each other.

Any socket that has completed `hello`, including a publisher, may claim names on a client run. The owner claims by listing names. There is no implicit claim.

A claim replaces that socket's whole set on that run:

- Names in the new list move to this socket. The previous holder is told which of its names moved.
- Names this socket no longer lists return to Node.
- An in-flight `tool.request` stays with the socket that was sent that `requestId`. Later calls use the new holder.
- Several calls for one name may be in flight together. Each has its own `requestId`.

The holder is chosen synchronously at the start of `requestTool`, and `tool.request` is sent before that function yields. A claim that arrives after the send does not move that call.

`start.processing` is the owner's claim, validated before the run is opened. On success it is applied before `onStart`, so the first model call already sees it.

## Wire protocol

Frames are JSON objects on the existing bus. A bad frame keeps the socket open and uses the existing error shape `{ "type": "error", "code", "message" }`. Messages are Russian. New cases use the existing codes `invalid_start`, `bad_request`, and `unknown_run`.

Outgoing frames go through the current `sanitizeValue` send path. The host executes the `args` it received. Incoming `tool.result` strings are stored as the tool output.

### Claim on start

```json
{ "type": "start", "command": "run", "prompt": "…", "cwd": "C:/work", "processing": ["read_file", "replace_text"] }
```

`processing` is an optional array of unique processable names. It is added to the accepted `start` fields. A missing field or an empty array creates no claim and sends no processing frames. Any other invalid value sends `invalid_start` and does not open a run. The check stops at the first problem, in this order: `processing должен быть массивом.`, then `Имя инструмента повторяется: <name>.`, then `Инструмент недоступен для захвата: <name>.`

A valid non-empty list opens the run, claims those names for the owner, then sends `processing.claimed` to the owner and publishes `processing.held`. `onStart` runs after that.

### Claim on a running client run

```json
{ "type": "processing.claim", "runId": "…", "tools": ["write_file"] }
```

The hub validates the whole list, then applies it. A failed check changes nothing.

| Condition | Code | Message |
| --- | --- | --- |
| `runId` is not a running run | `unknown_run` | `Запуск не найден или уже завершён.` |
| The run's source is `terminal` | `bad_request` | `Захват доступен только для клиентского запуска.` |
| `tools` is not an array | `bad_request` | `tools должен быть массивом.` |
| A name is repeated | `bad_request` | `Имя инструмента повторяется: <name>.` |
| A name is not processable | `bad_request` | `Инструмент недоступен для захвата: <name>.` |

An empty `tools` array is valid and releases every name that socket holds on that run.

The claimer receives the set it holds after the claim, in the order it sent:

```json
{ "type": "processing.claimed", "runId": "…", "tools": ["write_file"] }
```

A socket that lost names receives only those names, sorted:

```json
{ "type": "processing.released", "runId": "…", "tools": ["read_file"] }
```

The claimer does not receive `processing.released` for names it dropped itself. A claim that leaves every holder the same still replies `processing.claimed`.

Subscribers then receive one snapshot of every name currently held on the run, sorted:

```json
{ "type": "run.event", "runId": "…", "event": { "type": "processing.held", "tools": ["read_file", "write_file"] } }
```

`tool.request` is not a run event. A late subscriber gets no replay. Only sockets already subscribed, including the owner, see `processing.held`. `processing.held` goes out through the existing `publish` path, so a publisher socket still does not receive it. A publisher that holds names does receive `processing.claimed` and `processing.released`, because those are sent directly.

### Tool call

```json
{ "type": "tool.request", "runId": "…", "requestId": "…", "name": "replace_text", "args": { "path": "src/a.js" } }
```

`args` is the object `execute` parsed. The frame goes only to the holder chosen for this call.

Success:

```json
{ "type": "tool.result", "requestId": "…", "output": "Изменён src/a.js", "summary": "~ src/a.js", "changes": [{ "op": "edit", "path": "src/a.js" }] }
```

`output` and `summary` are strings. `changes` may be omitted. When present it has at most 100 items. Each item is an object whose `op` is `create`, `overwrite`, `edit`, or `delete`, and whose `path` is a string. Extra fields are ignored.

Failure:

```json
{ "type": "tool.result", "requestId": "…", "error": "Файл не найден" }
```

A string `error` whose trim is not empty is a tool failure. `output` on that frame is ignored. The model receives the normal failure text, and the run continues. A missing `error`, or a string that trims to empty, is a success frame and must include `output` and `summary`.

These frames do not resolve the wait, and the sender gets `bad_request`:

| Condition | Message |
| --- | --- |
| Unknown `requestId`, or a request that was already finished | `Неизвестный requestId.` |
| The sender is not the socket that received this `requestId` | `Этот requestId адресован другому сокету.` |
| `error` is present and is not a string | `error должен быть строкой.` |
| Success frame without string `output` and string `summary` | `output и summary должны быть строками.` |
| `changes` is not an array, has more than 100 items, or an item is not `{ op, path }` as above | `changes: op create, overwrite, edit или delete и path-строка.` |

The waiting socket can send a corrected `tool.result`.

## Dispatcher

`requestTool(runId, name, args, signal)` returns `null` when that run exists and has no holder for `name`. Otherwise it returns `{ output, summary, changes }`. `changes` is always an array; it is empty when the host omitted it. A call for a run that is already gone rejects with `Error('Запуск не найден.')` unless the signal is already aborted, in which case it rejects with the abort error below.

It rejects with `Error('Держатель инструмента отключился.')` when that holder disconnects and does not own the run. It rejects with the hub's existing abort error when `signal` aborts or `finish` drops the wait. `execute` turns an abort error, or an already aborted signal, into `CancelledError` and rethrows it. The model does not receive a tool failure for cancellation. A normal completion does not leave a tool call in flight, because the command awaits the tool before it returns.

`execute` applies `changes` only for `write_file`, `replace_text`, and `delete_file`. On other tools the array is discarded and the call still succeeds.

For each applied item, `execute` resolves the path with `resolveInside(root, path, { forWrite: true, allowRoot: false })` and rejects a path inside `.backup`, using the same messages the local writer uses. The stored record is `{ op, path }`, where `path` is the resolved relative path. There is no `backupPath`. The entry is appended to `stats.changes`, then `updateProjectMapPath(root, path)` runs. That function reads the local disk, which is its current behavior: a path with no local file drops that entry from an existing map.

These cases emit `{ "type": "warning", "message" }` and do not fail the tool. The model still receives `output`.

- A path that `resolveInside` or the `.backup` check rejects uses that function's message.
- An item whose `op` is not one of the four names, or whose `path` is not a string, uses `Некорректная запись changes.`
- More than 100 items uses `changes содержит больше 100 записей.` once, and only the first 100 are considered.
- A thrown `updateProjectMapPath` uses `Карта проекта не обновлена: <message>.`, the same warning the local handlers already emit.

Remote `run_command` and `run_script` do not append to `stats.commands`, and they do not pass through the local scaffold guard. The host owns the whole tool.

The single-agent summary in `src/commands/flow.js` and the team summary in `src/commands/run.js` show the backup-directory row when a listed change has a `backupPath`. Remote changes still appear in the change list through `describeChanges`.

## Disconnect and cancellation

Owner disconnect, `cancel`, and an aborted run signal keep today's behavior: the run ends as `cancelled` with exit code 130. Pending tool calls on that run reject as cancellation. No `processing.held` frame is sent for a run that is ending.

Disconnect is applied per run. A run this socket owns is cancelled, and its pending tool calls reject as cancellation. On every other still-running client run where this socket is only a holder, its names return to Node, each of its in-flight calls rejects with `Держатель инструмента отключился.`, and subscribers receive a new `processing.held`.

There is no processing timeout.

## Files

- `src/server/hub.js` — `processing` on `start`, the claim registry, `requestTool`, result matching, release on disconnect.
- `src/agent/tools.js` — `processTool` argument and the change accounting after a remote result.
- `src/commands/serve.js` — install `ctx.processTool` for client runs.
- `src/commands/ask.js`, `src/commands/chat.js`, `src/commands/run.js`, `src/agent/team.js` — pass `processTool` into each `createToolset`.
- `src/commands/flow.js`, `src/commands/run.js` — backup-directory row only when a change has `backupPath`.
- `README.md` — the new frames next to the existing `ai serve` description.
- `test/hub.test.js`, `test/processing.test.js`, `test/serve.test.js`.

`index.js` needs no new export. `requestTool` is a method on the object `createHub` already returns.

## Tests

`node --test` stays the runner. No new dependencies.

`test/hub.test.js` uses the in-memory sockets:

- `start` with `processing` claims the owner's names before `onStart`. An invalid `processing` value is `invalid_start` and creates no run.
- A second socket claims a different name, and both holders remain.
- Stealing a name sends `processing.released` to the previous holder. The outstanding `requestId` still completes on the old socket. The next call goes to the new holder.
- A repeated claim replaces that socket's set. An empty `tools` array returns its names to Node.
- A bad name, a duplicate, and a claim on a publisher run answer `bad_request` and leave the registry unchanged.
- A subscriber sees `processing.held` and does not see `tool.request`.
- `tool.result` from the wrong socket, and a success frame without `output`, answer `bad_request` while the wait stays open. An `error` string fails the call.
- A non-owner holder disconnect returns its names to Node and fails its calls. Owner disconnect cancels the run.

`test/processing.test.js` calls `createToolset` directly:

- `null` from `processTool` reads a local file.
- A host result is returned when the file is not on disk.
- A `replace_text` change is stored in `stats().changes` and refreshes an existing project map. The fake writes the new bytes before returning, so the reindexed map shows those bytes.
- A path outside the root emits `warning` and preserves `output`.
- `changes` on `read_file` are not stored.
- A denied approval does not call `processTool`.
- A thrown error becomes a failed tool result. `CancelledError` propagates.

`test/serve.test.js` adds one real WebSocket case beside the existing mock model. The model requests `write_file`. The owner approves and answers `tool.request` with text that is not on disk. The run completes, the work directory has no new file, and the published `result` event lists that path in `tools.changes`.
