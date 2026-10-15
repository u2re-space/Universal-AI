# Workspace scanner for Node.js and frontend runs

**Date:** 2026-10-15
**Status:** approved for implementation (user asked to skip further questions and implement)

## Goal

`ai run` and `ai gen` (team and single) look at a Node.js or frontend working directory before any edit or generation. A local scanner, not a model call, runs before the first answer, the encoder, and the planner. It puts project config into the shared context and lists files those configs resolve, so later roles edit the real paths.

The desktop `scanner` role is unchanged. It still only looks at the screen. This scanner does not add a fourteenth model role.

## When it runs

The working directory is a workspace when any of these files exists:

- `package.json`
- `tsconfig.json`
- `jsconfig.json`
- `index.html` at the project root

Otherwise the scanner stays silent. `ai ask`, cursor completion, and the structure command do not run it.

Kind:

- `node-frontend` when `package.json` and root `index.html` both exist
- `frontend` when root `index.html` exists without `package.json`, or only `jsconfig.json` / `tsconfig.json` exists
- `node` when `package.json` exists and root `index.html` does not

A Node project with `tsconfig.json` and no `index.html` is `node`. Its config is still sent.

## What goes into the context

Each piece is clipped to 8 KiB in the prompt. Parsing reads up to 256 KiB.

- `package.json` text. Its `imports` field is also an import map.
- `tsconfig.json` when it exists. Otherwise `jsconfig.json`. Comments and trailing commas are accepted. One relative `extends` is read for `baseUrl` and `paths` when the child file omits them. The child wins when it sets them. `tsconfig.json` wins when both config files exist.
- Import maps from `package.json` `imports`, from an inline `<script type="importmap">` in root `index.html`, and from a `src` on that tag when it is relative or site-root (`/importmap.json`).
- Root `index.html` entries (module and classic script `src`, stylesheet `href`) always. The body is included when the file is at most 8 KiB, or when the task mentions the page (`index.html`, `html`, `importmap`, `страниц`, `вёрст`, `верст`, `landing`, `frontend`). A larger file that is not about the page contributes entries and the import map only.
- A short alias list from `compilerOptions.paths` and from every import map.
- Scanner files: at most 24 relative paths, each `edit` or `read`, with a reason.

Resolution order for a specifier:

1. Relative (`./`, `../`) from the importing file, or from the project root when the specifier comes from HTML or the task.
2. Node `package.json` `imports` (`#` keys, one `*` pattern, conditions). Frontend and node-frontend prefer `browser`, then `import`, then `default`. Node prefers `import`, then `node`, then `default`.
3. HTML import map: exact key, then the longest prefix that ends with `/`.
4. `compilerOptions.paths`: the longest matching key, then `baseUrl` when the specifier contains a slash and nothing else matched.
5. A project-relative path such as `src/app.js`.

Candidates try `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.json`, and `index` files with those extensions. The first candidate that is a real file is kept. Paths that escape the root or enter `node_modules` are dropped.

Files:

- A path or specifier named in the task is `edit` when the task is a change or a generation, and `read` otherwise.
- Package entry points (`main`, `module`, string `browser`, relative `exports`) and root `index.html` script targets are `read` (`точка входа`).
- One level of imports from those entry files is `read` (`импорт точки входа`).
- Local import-map targets are `read` (`цель import map`), at most 8.
- Root `index.html` is `edit` when the task names that file.

The same file list is merged in front of the task-map draft the planner already sees. Edit marks from the scanner stay ahead of draft marks. The encoder prompt gets the same workspace block, because the encoder does not read the shared context document.

## Flow

1. Team mode loads the project map, then the scanner.
2. On a hit it emits `stage.start` / `stage.done` with stage `scan` and role `scanner`, and stores the text as shared context `Workspace scan` at priority 8.
3. The first answer, the planner, and the encoder all see that text. Single mode prepends the same text to the task.
4. A scanner failure is a warning. The run continues without the block.
5. No new flag and no new model role.

## Units

| Unit | Responsibility |
| --- | --- |
| `src/agent/workspace-scan.js` | Detect the workspace, parse configs, resolve specifiers, format the prompt block |
| `src/agent/team.js` | Run the scanner before the answer, merge files into the draft, show the block to the encoder |
| `src/commands/run.js` | Same block on the single-agent task |
| `src/roles/planner.js` | Tell the planner to use the scan |
| `src/roles/encoder.js` | Tell the file encoder to prefer scanned paths |
| `src/ui/renderer.js` | Stage label `сканер` |

## Tests

`node --test`, no network.

`test/workspace-scan.test.js` covers JSON with comments, HTML import maps, `paths`, `#` imports, prefix import maps, a missing workspace, `jsconfig.json` when `tsconfig.json` is absent, a large `index.html` omitted unless the task is about the page, and draft merge order.

`test/team.test.js` covers a frontend directory: the scan stage is first, the answer and the encoder see `package.json` and the resolved file, and a plan route shows the same block to the planner. Directories without those markers do not gain a scan stage.
