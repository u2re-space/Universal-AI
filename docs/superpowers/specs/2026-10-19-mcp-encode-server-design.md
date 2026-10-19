# MCP encode server

**Date:** 2026-10-19
**Status:** approved for planning

## Goal

`ai run`, `ai gen`, and `ai chat` can host an MCP server that exposes the file and shell tools directly to a model. While that server is on and connected, the file-encoder role stays in the team and becomes the executor of the server: it runs `encode` and the eight tools, and it does not call the encoder model. The encoder model and `executeFileCommands` remain the path when the server is off or not connected.

## Non-goals

- Replacing the desktop encoder (`screenshot`, `click`, `type`, `ahk`, `delegate_role` with role `encoder`).
- Mounting this server inside `ai serve`. That process has many runs, and an MCP call does not name a run. `ai serve` keeps its existing per-run processing bus.
- A second tool registry. Client tools are the Agent Processing claims already defined in `docs/superpowers/specs/2026-10-17-agent-processing-design.md`.
- Calling tools whose names are outside the eight processable tools during `encode`.
- Falling back to the encoder after a direct `read_file`, `write_file`, `run_command`, or other tool error.
- A TypeScript compile step. Node 26 runs the `.ts` files by type stripping. The files use erasable syntax only.
- Binding outside `127.0.0.1`, a token, or stdio for this listener. `ai chat` already owns stdin.

## Switch

`agent.encode` is `encoder` or `mcp`. The default is `encoder`. Any other value fails configuration with exit code 2 and opens no port. The message is `agent.encode: encoder | mcp`.

`encoder` is today's file path. The encoder model returns `fs:read`, `fs:write`, and `fs:list`. `executeFileCommands` runs that batch. No listener starts, and stderr does not print MCP or Processing lines.

`mcp` starts the listener in `ai run`, `ai gen`, and `ai chat` before the command does its work, and closes it when the process ends. `ai gen` is the `ai run` handler, so one start covers both.

## Server

The listener is Streamable HTTP from `@modelcontextprotocol/node`, on `127.0.0.1` and an ephemeral port. A second socket on the same host speaks the processing claim frames. Stderr prints two lines once:

```text
MCP: <url returned by the transport>
Processing: ws://127.0.0.1:<port>
```

There is no token. A connection that is not from `127.0.0.1` is refused. If either bind fails, the command exits 2 and does not start its work. The message is `Не удалось открыть MCP-сервер: <message>`.

`src/encode/server.ts` is the only module that imports `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, or `zod`. Tool arguments use Zod. `src/encode/encode.ts` imports neither the SDK nor Zod. JavaScript loads `encode.ts` with a dynamic import only when `agent.encode` is `mcp`.

The server registers nine tools when the switch is `mcp`: the eight processable names, plus `encode`.

## Eight tools

The names and fields match `createToolset`:

`list_files`, `read_file`, `search_files`, `write_file`, `replace_text`, `delete_file`, `run_command`, `run_script`

An in-process call and an MCP call use one function. The model loop in `ai run`, `ai gen`, and `ai chat` keeps receiving these names from `createToolset`. The handler is that function, not an HTTP call back into the same process. An outside client calls the same names through MCP.

The function checks the process registry. A held name runs on that holder. An unheld name runs on Node. The encoder model is not consulted. No `file_commands` document is built.

The in-process result is `{ output, summary }`. The MCP result is a text content block of `output`. A tool failure is an MCP tool error with that same text. The model loop sees the usual failed tool result and may continue. A direct tool failure does not switch the encoder role back into the file-command model.

`decide` runs before `write_file`, `replace_text`, `delete_file`, `run_command`, and `run_script`, for both callers. A denial is a failed tool result and does not change the disk. Read tools stay allowed the way they are today.

## encode

`encode` is the ninth tool, registered only while the switch is `mcp`.

Arguments:

- `text` — answer text with the `route:` line already removed
- `artifacts` — objects `{ id, body, hintLanguage, hintPath }`. `hintLanguage` and `hintPath` are strings or null
- `workspace` — scanner text, or `""`
- `directoryTree` — the directory listing text

The built-in function does not call a model. For each artifact it writes `body` to `hintPath` when `hintPath` is a non-empty relative path that `resolveInside` accepts inside the working directory. That path check is local. It does not call `read_file`, so a new file is not rejected for being absent.

The write uses the `write_file` holder when this process has one. Otherwise it uses Node. Either way `decide` runs first, as it does for a direct `write_file`. The bytes are the artifact body. A missing, empty, or out-of-root `hintPath` fails the whole call before any write in that call. A holder refusal or a throw on one artifact fails the whole call. Files already written by earlier artifacts in that call stay on disk. The successful `{ written: string[] }` is not returned.

On success the function returns `{ written: string[] }` in order. An MCP client receives that JSON as the text content of the tool result.

An outside server may implement the same tool with different judgment. This repository's function is the hint-path writer above.

## Registry

`ai run`, `ai gen`, and `ai chat` keep one registry for the process, not one registry per run. There is no `start` frame and no publisher role.

A client sends `hello`, then `processing.claim` with `tools`. The accepted names are the eight tools. Claim, replace, empty release, and `tool.request` / `tool.result` behave as in the processing spec, including a soft steal and in-flight calls finishing on the previous holder. `processing.claim` does not take a `runId`. The frames are `processing.claimed`, `processing.released`, and the subscriber event `processing.held`.

When a holder disconnects and the command is still running, its names return to Node and its in-flight calls fail with `Держатель инструмента отключился.` Cancelling the process, or leaving `ai chat`, closes both ports. An in-flight call interrupted by that shutdown is cancellation, not a tool error. The file-command model does not start.

## Encoder role

`encodeHandoff` has two callers: the route chosen after the first answer is `encode`, and a plan file action is `encode`. Both open `stage.start` with role `encoder`.

The listener is up in this process, which is what "connected" means here. The in-process caller is connected as soon as the listener has bound. The encoder role then does not call `roles.run('encoder')` and does not run `executeFileCommands`. It is the executor of this MCP server. Before any other work it calls `encode` with the answer, the artifacts, the workspace scan, and the directory tree. The eight tools stay available to the model and to an outside MCP client through the same executor. Success reports `written` and completes the stage. Failure completes the stage as failed. Files left by that attempt stay on disk. The file-command model does not start afterwards.

The listener is not up. The same stage is today's encoder: the model returns `fs:read`, `fs:write`, and `fs:list`, and `executeFileCommands` runs them.

A process abort during `encode` propagates `CancelledError`. The file-command model does not start. Direct failures of the eight tools also leave that model unused. The desktop encoder is unchanged.

## Dependencies

These are runtime dependencies:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/node`
- `zod` 4, the schema package `registerTool` accepts

No other JavaScript module imports them. There is no `tsc` build. `node` runs `src/encode/server.ts` and the dynamic import of `src/encode/encode.ts`.

## Tests

`node --test` stays the runner.

`test/encode.test.js` calls `encode` with a stand-in for read and write:

- One in-root hint path writes the body and returns that path.
- A null, empty, or out-of-root hint fails before any write.
- A write that throws after an earlier artifact was stored does not return `written`. The earlier file remains.
- A provided `write_file` holder receives the write, and Node does not create that file.

`test/encode-server.test.js` listens on `127.0.0.1` and speaks MCP. The tool list contains the eight names and `encode`. `read_file` returns the file text through Node when no holder exists. A processing client sends `hello`, claims `write_file`, and the next `encode` delivers `tool.request` to that client. Node does not create that file.

Configuration: `agent.encode: "nope"` exits 2 and opens no port.

Command behavior, with the mock model:

- `agent.encode: "mcp"` still opens the encode stage with role `encoder`. A successful `encode` does not call `roles.run('encoder')` or `executeFileCommands`. The reported file list is `written`.
- `agent.encode: "mcp"` and a failed `encode` finish that stage as failed. `roles.run('encoder')` and `executeFileCommands` are not called.
- `agent.encode: "encoder"` prints neither `MCP:` nor `Processing:`. The encoder model and `executeFileCommands` still run.

The desktop encoder is not covered.
