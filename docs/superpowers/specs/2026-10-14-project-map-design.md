# Project map and search

`ai map` builds a durable index of the working directory. Runs and `search_files` use that index from RAM instead of walking the tree. Rules draft which files to read, edit, or scan. The planner confirms those marks in the plan it already writes.

Node.js built-in modules only. No parser package.

## Non-goals

- Watching the filesystem for edits made outside this process.
- A hard block on writing a file that is not marked `edit`.
- Symbol extraction for languages other than JavaScript, TypeScript, Python, Go, and Rust.
- Replacing `list_files`.
- Putting file contents in the JSON map. Text lives only in the RAM LRU.

## Disk map

Path: `<working directory>/.ai/map.json`. `.gitignore` gains `.ai/`. The indexer does not index `.ai`.

```json
{
  "version": 1,
  "builtAt": "<ISO>",
  "files": {
    "src/agent/fs-tools.js": {
      "bytes": 4120,
      "mtimeMs": 1710000000000,
      "imports": ["../util/text.js"],
      "symbols": [{ "name": "searchFiles", "kind": "function", "line": 90 }]
    }
  }
}
```

`files` keys are POSIX paths relative to the working directory. `kind` is `function`, `class`, or `export`.

`imports` lists other keys in `files`, not raw module names. JavaScript and TypeScript: a relative `import` or `require` (`./` or `../`) is resolved against the file’s directory, then tried as written and with `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, and `/index.js`. Python: `from .name import` and `from ..name import` become `name.py` in the package directory. A candidate that is not a key is omitted. Go and Rust files have `"imports": []`.

A line that matches an `export` or `pub` form is stored as `export`. Otherwise a `function` / `def` / `func` / `fn` form is `function`, and a `class` / `struct` / `enum` / `type name struct` form is `class`. One symbol per line.

| Extension | `function` | `class` | `export` |
| --- | --- | --- | --- |
| `.js` `.mjs` `.cjs` `.ts` `.tsx` | `function name` | `class name` | `export function`, `export class`, `export const name`, `export { name }` |
| `.py` | `def name` | `class name` | none |
| `.go` | `func name` | `type name struct` | none |
| `.rs` | `fn name` | `struct name`, `enum name` | `pub fn`, `pub struct`, `pub enum` |

Indexed files are UTF-8 text at most 1 MiB, not binary, not a protected secret name, and not under a noisy directory (`NOISY_DIRS` in `src/agent/paths.js`) or `.ai`. Larger or binary files are omitted. Symbols are extracted for `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.py`, `.go`, and `.rs`. Every other indexed file has `"symbols": []` and `"imports": []`.

`ai map` rewrites the file and replaces the RAM tables for that root. `ai map path` prints the absolute path, the file count, and the symbol count. Any other argument is a usage error (exit 2). The command does not need `OPENAI_API_KEY`.

A missing map, a file that is not JSON, or a file whose `version` is not 1 is built once at the start of `ai map` and at the start of `ai run`. It is not built on every write. If that build throws, the run continues without a map and emits a warning. The run does not fail.

After a successful `write_file`, `replace_text`, or `delete_file`, that one path is reindexed or removed, on disk and in RAM. If the map file is missing, the update is skipped. If the update throws, the edit still stands and a warning is emitted.

## RAM

One process holds one cache entry per working directory. The entry is the parsed map plus:

- path → file record
- symbol name (lower case) → `{ path, kind, line }[]`
- a text LRU capped at 32 MiB

The entry is reused while `.ai/map.json` has the same modification time the cache stored. After `ai map` or a one-path save, the cache stores the new modification time, so the next load in that process does not read the file again. `ai map` replaces the tables when the rebuild finishes. Two working directories do not share tables. `ai serve` keeps the entry for every run in that process.

The LRU stores UTF-8 text keyed by path and that file’s modification time. A content read that misses, or whose file modification time differs, reads the disk and stores the text. When adding a file would pass 32 MiB, the least recently used files are dropped until it fits. A file larger than 32 MiB is read and not stored.

## Search

`search_files` gains `scope`: `path`, `symbol`, `content`, or `all`. The strict tool schema requires `scope`. The description tells the model to pass `all` unless a narrower scope is enough. A missing `scope` in a non-strict call is treated as `all`. Any other value is a tool error and does not scan.

When the map is loaded:

- `path` returns map keys that contain the query (case-insensitive). No file bytes are read.
- `symbol` returns symbol-table hits as `path:line: kind name`. No file bytes are read.
- `content` reads text, through the LRU, for indexed files under the requested directory. It does not call `readdir`.
- `all` returns path hits, then symbol hits, then content hits. Content is limited to the files that already hit on path or symbol. When nothing hit, content covers every indexed text file under the directory.

Matches keep today’s shape `path:line: text` for content, truncated at 240 characters, and stop at `limits.maxSearchResults`. Binary files and files over 1 MiB are not content-scanned.

When the map cannot be loaded, `search_files` uses the existing directory walk and the first result line is `Карта проекта недоступна; поиск по дереву.`

## Task marks

Words are splits of the task on characters that are not letters or digits, lower-cased, length 3 or more. A path is also taken whole when the task string contains that relative path.

Draft, in this order, from the RAM tables:

| Role | Rule | Cap |
| --- | --- | --- |
| `edit` | A path segment, the full path, or a symbol name contains a task word, or the task contains the path | 12 |
| `read` | The file’s `imports` include an `edit` path, or an `edit` file’s `imports` include this path | 20 |
| `scan` | Another indexed file in the same directory as an `edit` file, and not already `edit` or `read` | 40 |

Ties break by path, ascending. The draft is plain text in the planner prompt. An empty draft (no map, or no hits) is the line `Task map draft: (empty)`.

`PLAN_SCHEMA` gains:

```json
"taskMap": {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "path": { "type": "string" },
      "role": { "type": "string", "enum": ["read", "edit", "scan"] },
      "reason": { "type": "string" }
    },
    "required": ["path", "role", "reason"],
    "additionalProperties": false
  }
}
```

After the plan returns, drop entries whose path is not in the map or whose role is not one of the three. The remaining list is the task map. An empty list is valid.

The collector brief lists `read` and `edit` paths before `filesOfInterest`. `scan` paths are inserted into the shared context as one section, `Symbols (scan)`, each line `path:line: kind name`, and those files are not read for that section. The worker prompt lists the marks. A successful write, replace, or delete of a path that is not marked `edit` still performs the edit. The tool result starts with `Не в карте правок (<path>): `.

`filesOfInterest` and `searchQueries` stay. The collector still runs when the task map is non-empty, even if those two arrays are empty, unless the plan is `trivial`.

## Modules

`src/agent/map.js` builds, loads, and saves the JSON, extracts symbols and relative imports, holds the RAM tables and the text LRU, and updates one path. It does not call the model.

`src/agent/task-map.js` builds the draft and filters a planner `taskMap`. It reads tables only through `map.js`.

`src/commands/map.js` implements `ai map` and `ai map path`.

`src/agent/tools.js` passes `scope` into search and calls the one-path update after a successful write, replace, or delete. `list_files` is unchanged.

`src/agent/schemas.js` adds `taskMap` to `PLAN_SCHEMA`. `src/agent/team.js` ensures a map at the start of a team run, renders the draft into the planner prompt, stores the filtered marks, and feeds the collector, the worker, and the scan section.

`src/cli.js` registers `map`. It is not in the set of commands that require an API key.

`index.js` exports `loadProjectMap` and `draftTaskMap`.

## Tests

`test/map.test.js` builds a fixture with a JavaScript file that has a function and a relative import, a Python file with a class, a binary file, and a file under `node_modules`. The map contains the two source files, the function, the class, and the resolved import. It does not contain the binary file or `node_modules`. A one-path update changes that file’s symbol and leaves the other file’s record in place. A second `loadProjectMap` in the same process, with an unchanged map modification time, does not read the JSON file again.

`test/task-map.test.js` checks the 12 / 20 / 40 caps and drops a planner path that is not in the map.

`test/cli.test.js` runs `ai map` and `ai map path` with no `OPENAI_API_KEY` and expects exit 0. The path command prints `.ai/map.json` and a file count.

`test/team.test.js` supplies a draft and a planner `taskMap` with one `read` file. The collector prompt contains that path.

## Docs

`README.md` and `ai --help` gain `ai map` and `ai map path`, the `.ai/map.json` location, and `search_files` `scope`. The help line states that task marks are a draft from the map confirmed by the planner, and that a write outside `edit` is allowed and labeled.
