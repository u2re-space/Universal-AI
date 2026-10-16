# Generation scaffold: package.json, rules, skills, safe npx, recommendations

**Date:** 2026-10-16
**Status:** approved for planning

## Goal

When `ai gen` or `ai run` builds a generation profile, the model receives an English wrapper before the customer task. The wrapper is assembled from code: stack, file tree, `package.json`, `.rules/`, `.skills/`, and library recommendations. A scaffold command (`npx create-…`, `npm create`, `npm init`) cannot replace files that already exist or paths the customer task names.

This replaces the generation rule "no framework, no bundler, no npm" in `docs/superpowers/specs/2026-10-15-mcp-generate-design.md`. Fidelity stays unmeasured. The platform profile stays Chrome 157 Beta with flags off.

## When it runs

The wrapper is added only when `prepareTeamInvocation` sets `wantsProfile`: a generation kind, `--fidelity`, `--creativity`, `--platform`, or `--example`. A plain `ai run` that is editing an existing project does not get this wrapper.

The npx guard is not limited to that profile. `run_command` applies it whenever the command is a project scaffold, because that command writes files by itself.

## Prompt language

Text this program adds around a user prompt, an attachment, or stdin, before that content is sent to a model, is English. The customer's own words stay verbatim, in the language they used.

Existing fences change with this work:

- `src/commands/run.js` and `src/commands/ask.js`: `--- stdin ---` … `--- end stdin ---`
- `src/core/attachments.js`: `--- File: <path> (<size>) ---` … `--- End of file: <path> ---`

Operator-facing text stays Russian: CLI help, renderer lines, approval previews, and error messages. Tool descriptions that the model sees stay as they are except for the fences above. The final team report headings (`## План`, `## Шаг`, `## Ревью`) stay Russian because they are the operator's result, not a prompt wrapper.

## Stack

`src/generate/scaffold.js` is the source for the stack, the file list, `package.json`, recommendations, and the wrapper sentences. `buildGenerationBrief` calls it. The wrapper text is not a second copy of those facts.

Node.js 26 and `"type": "module"` apply to every kind. `engines.node` is `>=26`. The npm `name` is the working-directory basename when it is a legal npm name, otherwise `app`. Versions are `*` until `npm install` rewrites them. The agent does not invent version numbers.

### Web (`landing`, `site`, `app`)

Vite, SCSS, and the ECMAScript edition of the platform profile (Chrome 157 Beta, experimental flags off).

`package.json` is `private: true` and has scripts `dev` (`vite`), `build` (`vite build`), `preview` (`vite preview`), `test` (`node --test`), and `generate` (`node scripts/generate.js`). Dev dependencies that are included: `vite`, `sass`. Installation is `npm install`. There is no separate install script.

Files the brief asks for when they are missing:

- `package.json`
- `vite.config.js`
- `index.html`
- `src/main.js`
- `src/styles.scss`
- `scripts/generate.js`
- `.rules/stack.md`
- `.rules/files.md`
- `.skills/scaffold/SKILL.md`

`site` also lists `about.html` next to `index.html`. `app` also lists `server.js`, which serves `dist/` after `vite build`. `landing` and `site` have no server.

The agent writes this skeleton with file tools. `scaffoldScript()` returns the exact source of `scripts/generate.js`. When that file is missing, the wrapper includes the source and tells the model to write it unchanged. `npx` and `npm run generate` are for a named generator or template, not for the default skeleton.

### Backend

`server.js` uses `node:http`, binds `127.0.0.1`, and reads `PORT` or 3000. Scripts are `start` (`node server.js`), `test`, and `generate`. The default manifest has no dependencies.

`fastify` is included when the recommendation says the task needs a router, plugins, or validation. `@fastify/static` is included when the task serves files. `@fastify/cors` is included when the task mentions CORS. A named server library (Express, Hono, Koa, or another package the customer wrote) is included instead of Fastify.

Backend files when missing: `package.json`, `server.js`, `scripts/generate.js`, `.rules/stack.md`, `.rules/files.md`, `.skills/scaffold/SKILL.md`.

### Rules and skills

`.rules/` holds one Markdown file per rule. `.skills/scaffold/SKILL.md` is the scaffold skill. Their body is English, because a later agent reads them as instructions.

If a file in that list already exists, the brief tells the model to read it and leave it unchanged. The npx merge skips it as well. Missing files are created for the chosen stack.

## Recommendations

`recommendStack({ kind, prompt, references })` is pure. It does not use the network. The result is stored on the manifest as `recommendations` and rendered into the wrapper.

Order:

1. Packages and http(s) URLs named in the prompt, attached file names, and `--example`. A known package includes its docs URL and its types package when the catalog has them. An unknown name stays in the list with `docs: null` and `types: null`, and the wrapper says to confirm them with `web_search` when that tool is enabled.
2. CSS. Match the design name, mockup filename, and example URL against Tailwind, Bootstrap, Bulma, and Open Props. A match is included. Tailwind includes `tailwindcss` and `@tailwindcss/vite`. No match means plain SCSS and no CSS library. A product name such as Tilda is a visual reference, not an npm package.
3. Icons. The web default recommendation is Lucide. Font Awesome, Heroicons, Phosphor, Tabler, or Material Symbols replace it when named or when the design name selects them. An icon package is included only when it was named or selected by the design. The default Lucide entry is a recommendation the plan may adopt.
4. Template and base. The web base is the Vite + SCSS skeleton above. `references.templates` and `--example` stay samples. Names such as shadcn or Radix are component bases, not automatic dependencies.
5. Backend, as specified in the stack section.

Each library has `name`, `kind` (`css`, `icons`, `runtime`, `types`, `tool`), `reason`, `docs`, `types`, and `include` (`true` or `false`). Only `include: true` is written into `package.json`.

`web_search` is not turned on by the generation profile. The wrapper tells the planner to use it when it is already available.

## package.json merge

`buildPackageManifest(request)` returns the object for a new project. When a `package.json` already exists, neither the model instructions nor the npx merge replace it. Absent scripts, `dependencies`, and `devDependencies` keys are added. An existing script body or version stays. A file that is not valid JSON is left untouched and reported.

## npx guard

`run_command` calls `guardScaffold` before `runCommand` when `isScaffoldCommand` matches. The toolset receives the current task string as `scaffoldTask` from `run.js` and `team.js`.

A command is a scaffold when the whole trimmed string is one of:

- `npm init`
- `npm create`
- `npm exec create-…`
- `npx create-…`
- `npx @scope/create-…`

Optional tokens before the package are `--yes` and `--no-install`. `npx vite` and `npm install` are not scaffolds.

The command is rejected before spawn when it contains `&&`, `||`, `;`, `|`, a newline, or a redirection, or when it contains `--force` or a standalone `-f`. The error text tells the model to run one scaffold command without those flags. Approval still runs first. The guard does not skip it.

On acceptance the command runs with its target rewritten into a temporary directory. `.` or the project root merges back into the working directory. A relative subdirectory merges into that directory. Paths outside the root are rejected by the existing path check.

Copy rules:

- Skip a path that already exists.
- Skip a path returned by `pathsNamedInTask(task)`. That set is backtick paths and bare filenames with an extension the scaffold knows (`.html`, `.js`, `.mjs`, `.cjs`, `.scss`, `.css`, `.json`, `.md`), plus any `.rules/` or `.skills/` path written in the task.
- Skip `node_modules` and `.git`.
- Copy `package-lock.json` only when the destination has none.
- Merge `package.json` as specified above.

A non-zero exit, a timeout, or a cancel copies nothing. The temporary directory is removed in every case. The tool result lists copied paths, skipped paths, and `package.json` keys added.

`scripts/generate.js` in the generated project repeats the same merge for a command stored at `generate.command`. An empty command prints that the skeleton is already written and exits 0. `generate.protect` is an extra skip list. The script does not import this repository. It exists so `npm run generate` outside the agent follows the same rule.

## Wrapper shape

`buildGenerationBrief` puts this English text in `task`, then the existing fidelity lines, reference lines, and image rules. The customer text is last:

```text
Plan the work before changing files.
Produce an action plan, a file tree, the stack, the components or modules to recreate or reuse, and the standards to follow.
Prepare scripts for testing, for initial generation, and for installing packages.
List the recommended libraries. Choose them from the mockup, the attached image, and the design name, with CSS and icons first.
When the customer names a library or a link, include it, and include its documentation and its type package when they exist.
After the plan, initialize the project and implement the application or its prototype.

Stack:
<stack text>

Create these files when they are missing:
- <path>

Recommendations:
- <name> (<kind>): <reason>

Write the Vite and SCSS skeleton with file tools. When scripts/generate.js is missing, write the source block below it unchanged.
Run npx or npm run generate only for a named generator or template.
Read .rules/ and .skills/ when they exist. Create the missing stack files and follow them. Do not overwrite them.
Do not overwrite an existing file. A scaffold command copies only missing paths and adds absent package.json keys.

Customer task:

  ```md
<customer text, verbatim, or "(no text; follow the references)">
  ```
```

`instructions` carries the short contract: web stack or backend stack, conditional Fastify, the rules/skills rule, the package.json merge, and the rejection of `--force` and compound scaffold commands. `measured` stays `null`. The manifest gains `stack` and `recommendations`. `outputs` becomes the file list above.

## Errors

An unknown generation kind still throws. A failed scaffold copies nothing. An existing `package.json` that is not JSON is not rewritten. A scaffold command that is compound or forced throws before a process starts.

## Units

| Unit | Responsibility |
| --- | --- |
| `src/generate/scaffold.js` | Stack, manifest, recommendations, wrapper sentences, path extraction, scaffold detection, temp-dir merge |
| `src/generate/brief.js` | Assemble task, instructions, and manifest from the scaffold module |
| `src/agent/tools.js` | Pass `scaffoldTask` into `run_command` and apply the guard |
| `src/commands/run.js` | Pass the task into the single-agent toolset. English stdin fence |
| `src/agent/team.js` | Pass the task into the worker toolset |
| `src/commands/ask.js` | English stdin fence |
| `src/core/attachments.js` | English file fence |
| `scripts/generate.js` template | String in `scaffold.js` written into generated projects. Not a file of this repository |

Tests import `scaffold.js` directly. `index.js` keeps exporting `buildGenerationBrief` and does not re-export the scaffold helpers.

## Tests

`test/generate.test.js`:

- A Tilda mockup recommends SCSS and Lucide and does not include a CSS framework.
- The word Tailwind includes `tailwindcss`.
- A backend prompt with no router, plugins, or validation has no dependencies and the instructions name `node:http`.
- A backend prompt that needs validation or plugins includes `fastify`.
- A named Express package stays Express and does not add Fastify.
- A landing brief contains the customer text inside the `md` fence, `package.json`, `.rules/stack.md`, `.skills/scaffold/SKILL.md`, and the recommendation lines.
- The landing instructions do not contain `No framework, no bundler, no npm`.
- `measured` is `null`.

`test/scaffold.test.js`:

- Merge skips an existing `index.html` and a path named in the task.
- Merge keeps an existing script body and adds a missing devDependency.
- Merge does not copy `node_modules`.
- Invalid existing `package.json` is unchanged.
- `--force` and a command containing `&&` throw before spawn.
- `npx vite` is not a scaffold command.

The existing `ai gen landing` process test still writes `.ai/generation.json` with `measured: null` and the planner request contains `Customer task:` plus the wrapper sentence `Plan the work before changing files.`

## Out of scope

`run_script` is not rewritten. A script file that itself runs `npx create-` is an ordinary script. The generated `scripts/generate.js` is the supported generator entry. pnpm and yarn creates are not scaffolds. `web_search` stays off unless the operator enabled it. CLI messages stay Russian.
