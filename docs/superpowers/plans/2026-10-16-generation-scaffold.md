# Generation scaffold implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generation profile wraps the customer task in an English scaffold contract, and `run_command` merges `npx` / `npm create` / `npm init` output without replacing existing or named files.

**Architecture:** `src/generate/scaffold.js` owns the stack, `package.json` shape, recommendations, wrapper sentences, and the pure merge. `buildGenerationBrief` renders that into the task, the operator instructions, and `.ai/generation.json`. `run_command` runs a scaffold in a temp directory and copies only the paths the pure merge allows.

**Tech Stack:** Node.js 26 ESM, `node:test`, no new npm dependencies.

## Global Constraints

- The wrapper runs only when `prepareTeamInvocation` sets `wantsProfile`. Do not call `buildGenerationBrief` for a plain edit.
- The npx guard runs for every `run_command`, including runs that are not a generation profile.
- Node.js 26, `"type": "module"`, `engines.node` `>=26`. Versions in a generated manifest are `*` until `npm install` rewrites them. Do not invent version numbers.
- The npm `name` is the working-directory basename when it matches `^[a-z0-9][a-z0-9._-]*$` and is at most 214 characters. Otherwise `app`.
- Web kinds `landing`, `site`, and `app` use Vite, SCSS, and the platform ECMAScript edition. Chrome 157 Beta flags stay off. `measured` stays `null`.
- `site` lists `about.html` immediately after `index.html`. `app` lists `server.js`, which serves `dist/` after `vite build`. `landing` and `site` have no server.
- Backend stays on `node:http`, `127.0.0.1`, port `PORT` or 3000, with no dependencies until a recommendation includes them.
- Prompt framing added by this program is English. The customer text stays verbatim. CLI help, renderer lines, approval previews, and thrown operator errors stay Russian. Team report headings `## План`, `## Шаг`, and `## Ревью` stay Russian.
- `index.js` does not re-export scaffold helpers.
- `web_search` is not enabled by the generation profile. `run_script` is not rewritten. pnpm and yarn creates are not scaffolds.
- Approval still runs in `decide` before the `run_command` handler. The guard does not skip it.

---

## File structure

- Create `src/generate/scaffold.js` — stack, manifest, recommendations, documents, wrapper, command classification, merge, temp-dir guard.
- Modify `src/generate/brief.js` — build the task and instructions from the scaffold module.
- Modify `src/agent/tools.js` — `scaffoldTask` and the guard inside `run_command`.
- Modify `src/commands/run.js` — pass `scaffoldTask`; English stdin fence.
- Modify `src/agent/team.js` — pass `scaffoldTask` on `toolBase`.
- Modify `src/commands/ask.js` — English stdin fence.
- Modify `src/core/attachments.js` — English file fence and shared `stdinFence`.
- Test `test/scaffold.test.js` — merge, classification, and the injected guard.
- Modify `test/generate.test.js` — brief assertions and the `ai gen landing` planner text.
- Modify `test/core.test.js` — file fence and stdin fence.

### Task 1: Stack and package.json

**Files:**
- Create: `src/generate/scaffold.js`
- Test: `test/scaffold.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `filesForKind(kind) -> string[]`, `npmPackageName(basename) -> string`, `buildPackageManifest({ kind, name, libraries }) -> object`, `stackText(kind, platform) -> string`. `libraries` items are `{ name, kind, include }`. `kind` of a library is `css`, `icons`, `runtime`, `types`, or `tool`.

- [ ] **Step 1: Write the failing test**

Create `test/scaffold.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesForKind, npmPackageName, buildPackageManifest, stackText } from '../src/generate/scaffold.js';

const platform = { id: 'chrome-157-beta', ecma: { edition: 2026 } };

test('web and backend file lists', () => {
    assert.deepEqual(filesForKind('landing'), [
        'package.json', 'vite.config.js', 'index.html', 'src/main.js', 'src/styles.scss', 'scripts/generate.js',
        '.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md',
    ]);
    const site = filesForKind('site');
    assert.equal(site[site.indexOf('index.html') + 1], 'about.html');
    assert.ok(filesForKind('app').includes('server.js'));
    assert.deepEqual(filesForKind('backend'), [
        'package.json', 'server.js', 'scripts/generate.js', '.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md',
    ]);
    assert.deepEqual(filesForKind(null), []);
});

test('package name and manifest versions', () => {
    assert.equal(npmPackageName('Widget'), 'widget');
    assert.equal(npmPackageName('My App'), 'app');
    const web = buildPackageManifest({ kind: 'landing', name: 'widget', libraries: [] });
    assert.equal(web.name, 'widget');
    assert.equal(web.private, true);
    assert.equal(web.type, 'module');
    assert.equal(web.engines.node, '>=26');
    assert.equal(web.scripts.dev, 'vite');
    assert.equal(web.scripts.build, 'vite build');
    assert.equal(web.scripts.preview, 'vite preview');
    assert.equal(web.scripts.test, 'node --test');
    assert.equal(web.scripts.generate, 'node scripts/generate.js');
    assert.equal(web.devDependencies.vite, '*');
    assert.equal(web.devDependencies.sass, '*');
    assert.equal(web.dependencies, undefined);
    assert.deepEqual(web.generate, { command: '', protect: [] });
    const backend = buildPackageManifest({
        kind: 'backend', name: 'api', libraries: [{ name: 'fastify', kind: 'runtime', include: true }],
    });
    assert.equal(backend.scripts.start, 'node server.js');
    assert.equal(backend.dependencies.fastify, '*');
    assert.equal(backend.devDependencies, undefined);
    assert.match(stackText('landing', platform), /Vite, SCSS/);
    assert.match(stackText('landing', platform), /2026/);
    assert.match(stackText('backend', platform), /node:http/);
    assert.match(stackText('app', platform), /dist\//);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: FAIL with `Cannot find module` for `../src/generate/scaffold.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/generate/scaffold.js`:

```javascript
/**
 * @file src/generate/scaffold.js
 * @module generate/scaffold
 * @purpose Stack, package.json, recommendations, and the safe scaffold merge for generation.
 * @depends node:path
 * @usedBy generate/brief, agent/tools
 * @exports filesForKind, npmPackageName, buildPackageManifest, stackText
 * @ai.tags generate
 * @ai.hint pure
 * @changed 2026-10-16 Scaffold contract for Vite, rules, and safe npx.
 */
import path from 'node:path';

const RULES = ['.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md'];
const WEB_TAIL = ['src/main.js', 'src/styles.scss', 'scripts/generate.js', ...RULES];

/**
 * Files the brief asks for when they are missing. `null` asks for none.
 * @param {string | null} kind
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function filesForKind(kind) {
    if (kind === 'landing') return ['package.json', 'vite.config.js', 'index.html', ...WEB_TAIL];
    if (kind === 'site') return ['package.json', 'vite.config.js', 'index.html', 'about.html', ...WEB_TAIL];
    if (kind === 'app') return ['package.json', 'vite.config.js', 'index.html', ...WEB_TAIL, 'server.js'];
    if (kind === 'backend') return ['package.json', 'server.js', 'scripts/generate.js', ...RULES];
    return [];
}

/**
 * A legal npm name, or `app`.
 * @param {string} basename
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function npmPackageName(basename) {
    const name = String(basename ?? '').trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214) return name;
    return 'app';
}

const WEB_SCRIPTS = Object.freeze({
    dev: 'vite', build: 'vite build', preview: 'vite preview', test: 'node --test', generate: 'node scripts/generate.js',
});
const BACKEND_SCRIPTS = Object.freeze({
    start: 'node server.js', test: 'node --test', generate: 'node scripts/generate.js',
});

/**
 * Manifest for a new project. Included libraries are added. Versions are `*`.
 * `css`, `tool`, and `types` go to devDependencies. `runtime` and `icons` go to dependencies.
 * @param {{ kind: string | null, name: string, libraries?: { name: string, kind: string, include: boolean }[] }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function buildPackageManifest({ kind, name, libraries = [] }) {
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    const scripts = { ...(web ? WEB_SCRIPTS : BACKEND_SCRIPTS) };
    const dev = {};
    const deps = {};
    if (web) { dev.vite = '*'; dev.sass = '*'; }
    for (const lib of libraries) {
        if (!lib?.include || typeof lib.name !== 'string') continue;
        const bucket = lib.kind === 'css' || lib.kind === 'tool' || lib.kind === 'types' ? dev : deps;
        if (!(lib.name in bucket) && !(lib.name in dev) && !(lib.name in deps)) bucket[lib.name] = '*';
    }
    const manifest = { name: npmPackageName(name), private: true, type: 'module', engines: { node: '>=26' }, scripts };
    if (Object.keys(deps).length) manifest.dependencies = deps;
    if (Object.keys(dev).length) manifest.devDependencies = dev;
    manifest.generate = { command: '', protect: [] };
    return manifest;
}

/**
 * English stack paragraph for the wrapper.
 * @param {string | null} kind
 * @param {{ id: string, ecma: { edition: number } }} platform
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stackText(kind, platform) {
    if (kind === 'backend') return 'Node.js 26, ESM, server.js on node:http, bind 127.0.0.1, port PORT or 3000. No dependencies unless a recommendation includes them.';
    if (kind === 'landing' || kind === 'site') return `Node.js 26, ESM, Vite, SCSS, ECMAScript ${platform.ecma.edition} (${platform.id}, experimental flags off). No Node server.`;
    if (kind === 'app') return `Node.js 26, ESM, Vite, SCSS, ECMAScript ${platform.ecma.edition} (${platform.id}, experimental flags off). server.js serves dist/ after vite build.`;
    return 'If this is web, PWA, or frontend, use Node.js 26, ESM, Vite, and SCSS. If it is a backend, use node:http on 127.0.0.1 and port PORT or 3000. Otherwise choose the files the request needs.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/generate/scaffold.js test/scaffold.test.js
git commit -m "$(cat <<'EOF'
feat: add the generation stack and package.json contract

EOF
)"
```

### Task 2: Recommendations

**Files:**
- Modify: `src/generate/scaffold.js`
- Test: `test/scaffold.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 besides the same module
- Produces: `recommendStack({ kind, prompt, references }) -> { libraries, templates, bases }`. Each library is `{ name, kind, reason, docs, types, include }`. `kind` is `css`, `icons`, `runtime`, `types`, or `tool`. `templates` items are `{ name, source, reason }`. `bases` items are `{ name, reason }`.

- [ ] **Step 1: Write the failing test**

Append to `test/scaffold.test.js`:

```javascript
import { recommendStack } from '../src/generate/scaffold.js';

function names(result, include) {
    return result.libraries.filter((item) => include === undefined || item.include === include).map((item) => item.name);
}

test('Tilda recommends SCSS and Lucide and does not include a CSS framework', () => {
    const result = recommendStack({
        kind: 'landing',
        prompt: 'Повтори макет Tilda Publishing',
        references: { images: ['landing.png'], files: [], templates: ['templates/base'], examples: ['https://css-tricks.com/'] },
    });
    assert.equal(names(result, true).some((name) => /tailwind|bootstrap|bulma|open-props/.test(name)), false);
    const lucide = result.libraries.find((item) => item.name === 'lucide');
    assert.equal(lucide.include, false);
    assert.equal(lucide.kind, 'icons');
    assert.equal(result.templates.some((item) => item.source === 'templates/base'), true);
    assert.equal(result.bases.some((item) => item.name === 'vite-scss'), true);
});

test('Tailwind is included and Express replaces Fastify', () => {
    const tw = recommendStack({ kind: 'landing', prompt: 'Use Tailwind', references: {} });
    assert.ok(names(tw, true).includes('tailwindcss'));
    assert.ok(names(tw, true).includes('@tailwindcss/vite'));
    const express = recommendStack({ kind: 'backend', prompt: 'Express API with validation', references: {} });
    assert.ok(names(express, true).includes('express'));
    assert.ok(names(express, true).includes('@types/express'));
    assert.equal(names(express, true).includes('fastify'), false);
    const plain = recommendStack({ kind: 'backend', prompt: 'api', references: {} });
    assert.deepEqual(names(plain, true), []);
    const validated = recommendStack({ kind: 'backend', prompt: 'JSON API with validation and plugins', references: {} });
    assert.ok(names(validated, true).includes('fastify'));
    const files = recommendStack({ kind: 'backend', prompt: 'Serve files over CORS', references: {} });
    assert.ok(names(files, true).includes('@fastify/static'));
    assert.ok(names(files, true).includes('@fastify/cors'));
    const unknown = recommendStack({ kind: 'app', prompt: 'Use `some-ui-kit`', references: {} });
    const kit = unknown.libraries.find((item) => item.name === 'some-ui-kit');
    assert.equal(kit.include, true);
    assert.equal(kit.docs, null);
    assert.equal(kit.types, null);
});
```

Merge the import into the existing import from Task 1 instead of a second import.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: FAIL with `recommendStack is not a function` or a missing export.

- [ ] **Step 3: Write minimal implementation**

Append to `src/generate/scaffold.js` and add `recommendStack` to the file-card `@exports`:

```javascript
const KNOWN = Object.freeze({
    tailwindcss: { kind: 'css', docs: 'https://tailwindcss.com/docs', types: null },
    '@tailwindcss/vite': { kind: 'tool', docs: 'https://tailwindcss.com/docs/installation/using-vite', types: null },
    bootstrap: { kind: 'css', docs: 'https://getbootstrap.com/docs/', types: null },
    bulma: { kind: 'css', docs: 'https://bulma.io/documentation/', types: null },
    'open-props': { kind: 'css', docs: 'https://open-props.style/', types: null },
    lucide: { kind: 'icons', docs: 'https://lucide.dev/guide/', types: null },
    '@fortawesome/fontawesome-free': { kind: 'icons', docs: 'https://fontawesome.com/docs', types: null },
    heroicons: { kind: 'icons', docs: 'https://heroicons.com/', types: null },
    '@phosphor-icons/web': { kind: 'icons', docs: 'https://phosphoricons.com/', types: null },
    '@tabler/icons': { kind: 'icons', docs: 'https://tabler.io/icons', types: null },
    'material-symbols': { kind: 'icons', docs: 'https://fonts.google.com/icons', types: null },
    fastify: { kind: 'runtime', docs: 'https://fastify.dev/docs/latest/', types: null },
    '@fastify/static': { kind: 'runtime', docs: 'https://github.com/fastify/fastify-static', types: null },
    '@fastify/cors': { kind: 'runtime', docs: 'https://github.com/fastify/fastify-cors', types: null },
    express: { kind: 'runtime', docs: 'https://expressjs.com/', types: '@types/express' },
    hono: { kind: 'runtime', docs: 'https://hono.dev/docs/', types: null },
    koa: { kind: 'runtime', docs: 'https://koajs.com/', types: '@types/koa' },
    '@types/express': { kind: 'types', docs: 'https://www.npmjs.com/package/@types/express', types: null },
    '@types/koa': { kind: 'types', docs: 'https://www.npmjs.com/package/@types/koa', types: null },
});

const CSS_PACKS = [
    { test: /tailwind/i, names: ['tailwindcss', '@tailwindcss/vite'] },
    { test: /bootstrap/i, names: ['bootstrap'] },
    { test: /bulma/i, names: ['bulma'] },
    { test: /open\s*props/i, names: ['open-props'] },
];
const ICON_PACKS = [
    { test: /font\s*awesome|fontawesome/i, name: '@fortawesome/fontawesome-free' },
    { test: /heroicons?/i, name: 'heroicons' },
    { test: /phosphor/i, name: '@phosphor-icons/web' },
    { test: /tabler/i, name: '@tabler/icons' },
    { test: /material symbols|material icons/i, name: 'material-symbols' },
];
const SERVERS = [
    { test: /\bexpress\b/i, name: 'express' },
    { test: /\bhono\b/i, name: 'hono' },
    { test: /\bkoa\b/i, name: 'koa' },
];

/**
 * One catalog row as a library entry.
 * @param {string} name
 * @param {string} reason
 * @param {boolean} include
 * @returns {object}
 * @ai.hint pure
 */
function library(name, reason, include) {
    const known = KNOWN[name] ?? { kind: 'runtime', docs: null, types: null };
    return { name, kind: known.kind, reason, docs: known.docs, types: known.types, include };
}

/**
 * Recommend libraries, templates, and bases from the task text. No network.
 * @param {{ kind: string | null, prompt?: string, references?: { images?: string[], files?: string[], templates?: string[], examples?: string[] } }} request
 * @returns {{ libraries: object[], templates: object[], bases: object[] }}
 * @exports
 * @ai.hint pure
 */
export function recommendStack({ kind, prompt = '', references = {} }) {
    const refs = {
        images: references.images ?? [], files: references.files ?? [],
        templates: references.templates ?? [], examples: references.examples ?? [],
    };
    const hay = [prompt, ...refs.images, ...refs.files, ...refs.templates, ...refs.examples].join('\n');
    const libraries = [];
    const seen = new Set();
    /** Push a package once. */
    const add = (name, reason, include) => {
        if (seen.has(name)) return;
        seen.add(name);
        const row = library(name, reason, include);
        libraries.push(row);
        if (include && row.types && !seen.has(row.types)) add(row.types, `Types for ${name}.`, true);
    };
    for (const match of hay.matchAll(/https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[a-z0-9-~][\w.-]*\/)?[a-z0-9-._~]+)/gi)) {
        add(match[1], 'Named on npm.', true);
    }
    for (const match of String(prompt).matchAll(/`(@?[a-z0-9][\w.-]*(?:\/[a-z0-9][\w.-]*)?)`/gi)) {
        const token = match[1];
        if (path.extname(token)) continue;
        add(token, 'Named by the customer.', true);
    }
    for (const pack of CSS_PACKS) if (pack.test.test(hay)) for (const name of pack.names) add(name, 'Matched the design name.', true);
    const icon = ICON_PACKS.find((pack) => pack.test.test(hay));
    if (icon) add(icon.name, 'Matched the icon design.', true);
    else if (kind === 'landing' || kind === 'site' || kind === 'app') add('lucide', 'Default web icon recommendation.', false);
    for (const match of String(prompt).matchAll(/https?:\/\/[^\s)]+/gi)) {
        const url = match[0].replace(/[.,]$/, '');
        if (/npmjs\.com\/package\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        libraries.push({ name: url, kind: 'tool', reason: 'Named link.', docs: url, types: null, include: false });
    }
    const server = SERVERS.find((pack) => pack.test.test(hay));
    if (server) add(server.name, 'Named server library.', true);
    else if (kind === 'backend') {
        if (/\b(router|routes?|plugins?|validation|middleware)\b|валидац|плагин|маршрут/i.test(hay)) add('fastify', 'The task needs a router, plugins, or validation.', true);
        if (/\bstatic files?\b|\bserves? files?\b|отдач/i.test(hay)) add('@fastify/static', 'The task serves files.', true);
        if (/\bcors\b/i.test(hay)) add('@fastify/cors', 'The task mentions CORS.', true);
    }
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    const templates = [
        ...refs.templates.map((source) => ({ name: source, source, reason: 'named template' })),
        ...refs.examples.map((source) => ({ name: source, source, reason: 'named example' })),
    ];
    const bases = [{ name: web ? 'vite-scss' : 'node-http', reason: web ? 'default web skeleton' : 'default backend server' }];
    if (/shadcn/i.test(hay)) bases.push({ name: 'shadcn', reason: 'named component base' });
    if (/\bradix\b/i.test(hay)) bases.push({ name: 'radix', reason: 'named component base' });
    return { libraries, templates, bases };
}
```

`path.extname` requires `import path from 'node:path'`. Keep that import. The recursive `add` for types calls `add` while `seen` is updated first, so `@types/express` is not added twice. `library('@types/express')` has `types: null`, so it does not recurse.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/generate/scaffold.js test/scaffold.test.js
git commit -m "$(cat <<'EOF'
feat: recommend scaffold libraries from the task text

EOF
)"
```

### Task 3: English wrapper and brief

**Files:**
- Modify: `src/generate/scaffold.js`
- Modify: `src/generate/brief.js`
- Modify: `test/generate.test.js`
- Test: `test/scaffold.test.js`

**Interfaces:**
- Consumes: `filesForKind`, `stackText`, `recommendStack`
- Produces: `scaffoldScript() -> string`, `stackDocuments(kind, platform) -> Record<string, string>`, `kindRules(kind, recommendations) -> string`, `renderGenerationTask({ kind, prompt, platform, recommendations, name }) -> string`. `name` defaults to `app`. Brief `manifest.outputs` is `filesForKind(kind)`. `manifest.stack` is `{ kind, text }`. `manifest.recommendations` is the `recommendStack` object. `KIND_RULES` is removed. `buildGenerationBrief` accepts optional `name` and passes `path.basename` of the working directory from `run.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/scaffold.test.js`:

```javascript
import { scaffoldScript, renderGenerationTask } from '../src/generate/scaffold.js';

test('generate script is standalone English and the wrapper quotes the customer', () => {
    const source = scaffoldScript();
    assert.match(source, /The skeleton is already written/);
    assert.match(source, /node_modules/);
    assert.match(source, /if \(!\(key in current\[section\]\)\)/);
    assert.doesNotMatch(source, /from ['"]\.\.\/src/);
    const task = renderGenerationTask({
        kind: 'landing',
        prompt: 'Повтори макет',
        platform,
        recommendations: recommendStack({ kind: 'landing', prompt: 'Повтори макет', references: {} }),
    });
    assert.match(task, /Plan the work before changing files/);
    assert.match(task, /When web_search is available/);
    assert.match(task, /scripts\/generate\.js/);
    assert.match(task, /The skeleton is already written/);
    assert.equal(task.includes('Повтори макет'), false);
});
```

In `test/generate.test.js`, replace the landing output and instruction assertions:

```javascript
    assert.deepEqual(brief.manifest.outputs, [
        'package.json', 'vite.config.js', 'index.html', 'src/main.js', 'src/styles.scss', 'scripts/generate.js',
        '.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md',
    ]);
    assert.match(brief.task, /87%/);
    assert.match(brief.task, /landing\.png/);
    assert.match(brief.task, /templates\/base/);
    assert.match(brief.task, /https:\/\/css-tricks\.com\//);
    assert.match(brief.task, /Plan the work before changing files/);
    assert.match(brief.task, /```md\nПовтори макет Tilda Publishing\n```/);
    assert.match(brief.task, /lucide/);
    assert.match(brief.task, /"vite": "\*"/);
    assert.doesNotMatch(brief.task, /tailwindcss/);
    assert.equal(brief.manifest.measured, null);
    assert.equal(brief.manifest.stack.kind, 'landing');
    assert.equal(brief.manifest.recommendations.libraries.some((item) => item.name === 'lucide'), true);
```

Replace `assert.match(brief.instructions, /No framework, no bundler, no npm/);` with:

```javascript
    assert.doesNotMatch(brief.instructions, /No framework, no bundler, no npm/);
    assert.match(brief.instructions, /Vite, SCSS/);
    assert.match(brief.instructions, /Do not pass --force/);
```

Keep the backend assertions for `node:http` and `127.0.0.1`. Add:

```javascript
    assert.equal(backend.manifest.recommendations.libraries.some((item) => item.include && item.name === 'fastify'), false);
```

In the `ai gen landing` process test, after `assert.match(planner, /87%/);` add:

```javascript
        assert.match(planner, /Plan the work before changing files/);
        assert.match(planner, /Customer task:/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 test/scaffold.test.js test/generate.test.js`

Expected: FAIL because `renderGenerationTask` is missing and the landing brief still lists `index.html` and `styles.css` only.

- [ ] **Step 3: Write minimal implementation**

Append to `src/generate/scaffold.js`:

```javascript
/**
 * Source of scripts/generate.js for a generated project. It does not import this repository.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function scaffoldScript() {
    return [
        "import { spawn } from 'node:child_process';",
        "import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';",
        "import os from 'node:os';",
        "import path from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        "",
        "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
        "const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));",
        "const command = typeof pkg.generate?.command === 'string' ? pkg.generate.command.trim() : '';",
        "const protect = new Set([...(Array.isArray(pkg.generate?.protect) ? pkg.generate.protect : [])].map((item) => String(item).replace(/\\\\/g, '/')));",
        "if (!command) {",
        "    process.stdout.write('The skeleton is already written.\\n');",
        "    process.exit(0);",
        "}",
        "const temp = await mkdtemp(path.join(os.tmpdir(), 'scaffold-'));",
        "let code = 1;",
        "try {",
        "    const child = spawn(command, { cwd: temp, shell: true, stdio: 'inherit', windowsHide: true });",
        "    code = await new Promise((resolve) => child.once('close', resolve)) ?? 1;",
        "    if (code !== 0) {",
        "        /* a failed generator copies nothing */",
        "    } else {",
        "        const files = [];",
        "        const walk = async (dir) => {",
        "            for (const entry of await readdir(dir, { withFileTypes: true })) {",
        "                if (entry.name === 'node_modules' || entry.name === '.git') continue;",
        "                const abs = path.join(dir, entry.name);",
        "                if (entry.isDirectory()) await walk(abs);",
        "                else files.push(path.relative(temp, abs).replace(/\\\\/g, '/'));",
        "            }",
        "        };",
        "        await walk(temp);",
        "        for (const rel of files) {",
        "            if (rel === 'package.json' || protect.has(rel)) continue;",
        "            const dest = path.join(root, rel);",
        "            if (await stat(dest).then(() => true).catch(() => false)) continue;",
        "            await mkdir(path.dirname(dest), { recursive: true });",
        "            await copyFile(path.join(temp, rel), dest);",
        "        }",
        "        const incomingPath = path.join(temp, 'package.json');",
        "        if (await stat(incomingPath).then(() => true).catch(() => false) && !protect.has('package.json')) {",
        "            const dest = path.join(root, 'package.json');",
        "            const have = await stat(dest).then(() => true).catch(() => false);",
        "            if (!have) await copyFile(incomingPath, dest);",
        "            else {",
        "                let current;",
        "                try { current = JSON.parse(await readFile(dest, 'utf8')); } catch { current = null; }",
        "                if (current && typeof current === 'object' && !Array.isArray(current)) {",
        "                    const incoming = JSON.parse(await readFile(incomingPath, 'utf8'));",
        "                    for (const section of ['scripts', 'dependencies', 'devDependencies']) {",
        "                        const prior = current[section] && typeof current[section] === 'object' ? current[section] : {};",
        "                        const extra = incoming[section] && typeof incoming[section] === 'object' ? incoming[section] : {};",
        "                        current[section] = { ...prior };",
        "                        for (const [key, value] of Object.entries(extra)) if (!(key in current[section])) current[section][key] = value;",
        "                    }",
        "                    await writeFile(dest, JSON.stringify(current, null, 2) + '\\n');",
        "                }",
        "            }",
        "        }",
        "    }",
        "} finally {",
        "    await rm(temp, { recursive: true, force: true });",
        "}",
        "process.exit(code);",
        "",
    ].join('\n');
}

/**
 * English rule and skill bodies.
 * @param {string | null} kind
 * @param {{ id: string, ecma: { edition: number } }} platform
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function stackDocuments(kind, platform) {
    return {
        '.rules/stack.md': `# Stack\n\n${stackText(kind, platform)}\n`,
        '.rules/files.md': '# Files\n\nRead existing files. Do not overwrite them. A scaffold command copies only missing paths and adds absent package.json keys.\n',
        '.skills/scaffold/SKILL.md': '# Scaffold\n\nWrite the skeleton with file tools. Run npm run generate only when package.json generate.command names a generator. The script copies missing files and skips node_modules.\n',
    };
}

/**
 * Operator contract for one kind.
 * @param {string | null} kind
 * @param {{ libraries: { name: string, include: boolean }[] }} recommendations
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function kindRules(kind, recommendations) {
    const fastify = recommendations.libraries.some((item) => item.name === 'fastify' && item.include);
    const lines = [];
    if (kind === 'backend') {
        lines.push('Node.js 26 ESM. Bind 127.0.0.1. Port from PORT or 3000.');
        lines.push(fastify ? 'Use fastify and the companion packages marked include.' : 'Use node:http. Do not add Fastify unless the recommendation includes it.');
    } else if (kind === 'landing' || kind === 'site' || kind === 'app') {
        lines.push('Vite, SCSS, and ESM. Node.js 26.');
        lines.push(kind === 'app' ? 'server.js serves dist/ after vite build.' : 'No Node server.');
    } else lines.push('Choose the files the request needs.');
    lines.push('Read existing .rules/ and .skills/. Create missing stack files. Do not overwrite them.');
    lines.push('Add absent package.json keys only. Keep existing script bodies and versions.');
    lines.push('Do not pass --force or -f to a scaffold command. Do not chain a scaffold command with &&, ||, ;, |, or redirection.');
    return lines.join('\n');
}

/**
 * English task wrapper. Fidelity, references, and the customer fence are added by the brief.
 * @param {{ kind: string | null, prompt?: string, platform: object, recommendations: object }} request
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderGenerationTask({ kind, prompt = '', platform, recommendations, name = 'app' }) {
    void prompt;
    const files = filesForKind(kind);
    const docs = stackDocuments(kind, platform);
    const libs = recommendations.libraries.map((item) => {
        const docsUrl = item.docs ? ` Docs: ${item.docs}.` : '';
        const types = item.types ? ` Types: ${item.types}.` : '';
        const confirm = item.docs == null && item.include ? ' Confirm docs and types with web_search when that tool is enabled.' : '';
        return `- ${item.name} (${item.kind}, ${item.include ? 'include' : 'recommend'}): ${item.reason}${docsUrl}${types}${confirm}`;
    });
    return [
        'Plan the work before changing files.',
        'Produce an action plan, a file tree, the stack, the components or modules to recreate or reuse, and the standards to follow.',
        'Prepare scripts for testing, for initial generation, and for installing packages.',
        'List the recommended libraries. Choose them from the mockup, the attached image, and the design name, with CSS and icons first.',
        'When the customer names a library or a link, include it, and include its documentation and its type package when they exist.',
        'When web_search is available, use it to confirm documentation and type packages.',
        'After the plan, initialize the project and implement the application or its prototype.',
        '',
        'Stack:',
        stackText(kind, platform),
        '',
        files.length ? 'Create these files when they are missing:' : 'Create the files the request needs.',
        ...files.map((file) => `- ${file}`),
        '',
        'Recommendations:',
        ...(libs.length ? libs : ['- (none)']),
        '',
        'Write the Vite and SCSS skeleton with file tools when the stack is web. When scripts/generate.js is missing, write the source block below it unchanged.',
        '```js',
        scaffoldScript(),
        '```',
        'When .rules/stack.md, .rules/files.md, or .skills/scaffold/SKILL.md is missing, write these bodies unchanged:',
        ...Object.entries(docs).flatMap(([file, body]) => [`##### ${file}`, body.trimEnd()]),
        'Run npx or npm run generate only for a named generator or template.',
        'Read .rules/ and .skills/ when they exist. Create the missing stack files and follow them. Do not overwrite them.',
        'Do not overwrite an existing file. A scaffold command copies only missing paths and adds absent package.json keys.',
        '',
        'package.json for a new project. Versions stay *. When the file already exists, add absent keys only:',
        '```json',
        JSON.stringify(buildPackageManifest({ kind, name, libraries: recommendations.libraries }), null, 2),
        '```',
    ].join('\n');
}
```

Replace `src/generate/brief.js` using the imports and function body below. Delete `KIND_RULES`. The file card `@exports` is `GENERATION_KINDS, KIND_OUTPUTS, buildGenerationBrief, writeGenerationManifest`. `@depends` includes `generate/scaffold`. `@changed 2026-10-16 English scaffold wrapper.`

`KIND_OUTPUTS`:

```javascript
export const KIND_OUTPUTS = Object.freeze({
    landing: Object.freeze(filesForKind('landing')),
    site: Object.freeze(filesForKind('site')),
    backend: Object.freeze(filesForKind('backend')),
    app: Object.freeze(filesForKind('app')),
});
```

Inside `buildGenerationBrief`, after `refs` is built:

```javascript
    const recommendations = recommendStack({ kind, prompt, references: refs });
    const outputs = kind ? [...filesForKind(kind)] : [];
    const manifest = {
        kind, prompt, fidelity: contract.fidelity, creativity: contract.creativity, measured: null,
        method: 'unmeasured', reason: contract.reason, platform: platform.id, experimentalFlags: false,
        references: refs, outputs, stack: { kind, text: stackText(kind, platform) }, recommendations,
    };
```

The task array becomes:

```javascript
    const task = [
        renderGenerationTask({ kind, prompt, platform, recommendations, name }),
        '',
        `Fidelity target: ${contract.fidelity}%. Measured match: unmeasured. Do not invent a percentage.`,
        `Creativity for elements that are not in the references: ${contract.creativity}%.`,
        '',
        listed.length ? 'References:' : 'References: none attached.',
        ...listed,
        '',
        'A contract file .ai/generation.json is already written. You may add the paths you created. Leave measured null.',
        ...(refs.images.length ? ['', 'Reference images are mockups. Recreate their photographs, illustrations, and textures with generate_image, or change a reference file with edit_image. If the only image tool is image_generation, use that. Point the page at the new files. Do not use a reference image as the page background or as a screenshot of the whole layout. Type, controls, and layout are HTML and CSS.'] : []),
        '',
        'Customer task:',
        '',
        '```md',
        prompt.trim() || '(no text; follow the references)',
        '```',
    ].join('\n');
    const instructions = [
        platformInstructions(platform),
        '',
        kindRules(kind, recommendations),
        '',
        fidelityInstructions(contract),
        ...(refs.images.length ? ['', 'The worker must create each artwork region with generate_image or edit_image before the page is finished. The saved image paths belong in the HTML and CSS.'] : []),
    ].join('\n');
```

Add `name = 'app'` to the `buildGenerationBrief` parameter list. In `src/commands/run.js`, import `path` from `node:path` and pass `name: path.basename(ctx.cwd)` into `buildGenerationBrief`.

Import `filesForKind`, `stackText`, `recommendStack`, `renderGenerationTask`, and `kindRules` from `./scaffold.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 test/scaffold.test.js test/generate.test.js`

Expected: PASS. The process test still records `measured: null`.

- [ ] **Step 5: Commit**

```bash
git add src/generate/scaffold.js src/generate/brief.js test/scaffold.test.js test/generate.test.js
git commit -m "$(cat <<'EOF'
feat: wrap generation tasks with the English scaffold contract

EOF
)"
```

### Task 4: Pure scaffold merge

**Files:**
- Modify: `src/generate/scaffold.js`
- Test: `test/scaffold.test.js`

**Interfaces:**
- Consumes: nothing beyond this module
- Produces: `pathsNamedInTask(text) -> string[]`, `isScaffoldCommand(command) -> boolean`, `scaffoldCommandError(command) -> void` (throws `Error` with message `Run one scaffold command. Do not use --force, -f, or a compound command.`), `planScaffoldMerge({ incoming, existing, task, existingPackageText, incomingPackageText, protect }) -> { copy, skip, packageJson }`. `packageJson.action` is `absent`, `copy`, `merge`, `invalid`, or `skip`. `packageJson.added` is `section.key` strings. `packageJson.text` is present only for `merge`.

- [ ] **Step 1: Write the failing test**

Append to `test/scaffold.test.js`:

```javascript
import { isScaffoldCommand, scaffoldCommandError, planScaffoldMerge } from '../src/generate/scaffold.js';

test('scaffold commands are classified before spawn', () => {
    assert.equal(isScaffoldCommand('npx vite'), false);
    assert.equal(isScaffoldCommand('npm install'), false);
    assert.equal(isScaffoldCommand('npx --yes create-vite@latest .'), true);
    assert.equal(isScaffoldCommand('npm create vite@latest client'), true);
    assert.equal(isScaffoldCommand('npm init -y'), true);
    assert.throws(() => scaffoldCommandError('npx create-vite@latest . --force'), /Run one scaffold command/);
    assert.throws(() => scaffoldCommandError('npx create-vite@latest . && npm install'), /Run one scaffold command/);
    assert.doesNotThrow(() => scaffoldCommandError('npx vite'));
    assert.doesNotThrow(() => scaffoldCommandError('npx --yes create-vite@latest .'));
});

test('merge keeps existing files, named paths, and package.json scripts', () => {
    const plan = planScaffoldMerge({
        incoming: ['index.html', 'src/main.js', 'node_modules/left.js', 'package-lock.json', 'package.json'],
        existing: ['index.html', 'package.json', 'package-lock.json'],
        task: 'Write `src/main.js` from the mockup.',
        existingPackageText: JSON.stringify({ scripts: { test: 'node --test test/old.test.js' }, devDependencies: { vite: '*' } }),
        incomingPackageText: JSON.stringify({ scripts: { test: 'node --test', generate: 'node scripts/generate.js' }, devDependencies: { sass: '*' } }),
        protect: [],
    });
    assert.ok(plan.skip.includes('index.html'));
    assert.ok(plan.skip.includes('src/main.js'));
    assert.ok(plan.skip.includes('node_modules/left.js'));
    assert.ok(plan.skip.includes('package-lock.json'));
    assert.equal(plan.copy.includes('src/main.js'), false);
    assert.equal(plan.packageJson.action, 'merge');
    assert.ok(plan.packageJson.added.includes('scripts.generate'));
    assert.ok(plan.packageJson.added.includes('devDependencies.sass'));
    const merged = JSON.parse(plan.packageJson.text);
    assert.equal(merged.scripts.test, 'node --test test/old.test.js');
    const broken = planScaffoldMerge({
        incoming: ['package.json'], existing: ['package.json'], task: '',
        existingPackageText: '{', incomingPackageText: '{}', protect: [],
    });
    assert.equal(broken.packageJson.action, 'invalid');
    assert.equal(broken.packageJson.text, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: FAIL on the missing exports.

- [ ] **Step 3: Write minimal implementation**

Append to `src/generate/scaffold.js`:

```javascript
const NAMED_FILE = /(?:^|[\s"'`(])((?:\.rules|\.skills)\/[\w./-]+|(?:[\w.-]+\/)*[\w.-]+\.(?:html|js|mjs|cjs|scss|css|json|md))\b/g;

/**
 * Relative paths named in the customer task.
 * @param {string} text
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function pathsNamedInTask(text) {
    const found = new Set();
    const source = String(text ?? '');
    const keep = (token) => {
        const rel = token.trim().replace(/\\/g, '/').replace(/^\.\//, '');
        if (!rel || rel.includes('..')) return;
        found.add(rel);
    };
    for (const match of source.matchAll(/`([^`\n]+)`/g)) {
        const token = match[1];
        if (token.startsWith('.rules/') || token.startsWith('.skills/') || path.extname(token)) keep(token);
    }
    for (const match of source.matchAll(NAMED_FILE)) keep(match[1]);
    return [...found];
}

const SCAFFOLD_START = /(?:^|&&|\|\||;|\n)\s*(?:npm\s+init\b|npm\s+create\b|npm\s+exec\s+(?:--yes\s+|--no-install\s+)*create-|npx\s+(?:--yes\s+|--no-install\s+)*(?:create-|@[A-Za-z0-9._-]+\/create-))/;

/**
 * True when the command string is, or contains, a project scaffold.
 * @param {string} command
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isScaffoldCommand(command) {
    return SCAFFOLD_START.test(String(command ?? '').trim());
}

/**
 * Throw when a scaffold command is compound or forced. Other commands return.
 * @param {string} command
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function scaffoldCommandError(command) {
    const text = String(command ?? '').trim();
    if (!isScaffoldCommand(text)) return;
    if (/&&|\|\||;|\||\n|>>?/.test(text) || /(^|\s)--force(?=\s|$)/.test(text) || /(^|\s)-f(?=\s|$)/.test(text)) {
        throw new Error('Run one scaffold command. Do not use --force, -f, or a compound command.');
    }
}

/**
 * Decide which scaffold files may be copied. Does not touch the disk.
 * @param {{ incoming: string[], existing: string[], task?: string, existingPackageText?: string, incomingPackageText?: string, protect?: string[] }} request
 * @returns {{ copy: string[], skip: string[], packageJson: { action: string, added: string[], text?: string } }}
 * @exports
 * @ai.hint pure
 */
export function planScaffoldMerge({ incoming, existing, task = '', existingPackageText = '', incomingPackageText = '', protect = [] }) {
    const named = new Set([...pathsNamedInTask(task), ...protect.map((item) => String(item).replace(/\\/g, '/'))]);
    const have = new Set(existing.map((item) => item.replace(/\\/g, '/')));
    const copy = [];
    const skip = [];
    for (const raw of incoming) {
        const rel = raw.replace(/\\/g, '/');
        if (rel.split('/').some((part) => part === 'node_modules' || part === '.git')) { skip.push(rel); continue; }
        if (rel === 'package.json') continue;
        if (rel === 'package-lock.json') { (have.has(rel) ? skip : copy).push(rel); continue; }
        if (have.has(rel) || named.has(rel)) skip.push(rel);
        else copy.push(rel);
    }
    let packageJson = { action: 'absent', added: [] };
    if (!incoming.some((item) => item.replace(/\\/g, '/') === 'package.json')) return { copy, skip, packageJson };
    if (!have.has('package.json')) {
        packageJson = named.has('package.json') ? { action: 'skip', added: [] } : { action: 'copy', added: [] };
        if (packageJson.action === 'skip') skip.push('package.json');
        return { copy, skip, packageJson };
    }
    let current;
    try { current = JSON.parse(existingPackageText); }
    catch { return { copy, skip, packageJson: { action: 'invalid', added: [] } }; }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return { copy, skip, packageJson: { action: 'invalid', added: [] } };
    let incomingJson;
    try { incomingJson = JSON.parse(incomingPackageText); }
    catch { return { copy, skip, packageJson: { action: 'invalid', added: [] } }; }
    const next = { ...current };
    const added = [];
    for (const section of ['scripts', 'dependencies', 'devDependencies']) {
        const prior = current[section] && typeof current[section] === 'object' && !Array.isArray(current[section]) ? current[section] : {};
        const extra = incomingJson?.[section] && typeof incomingJson[section] === 'object' && !Array.isArray(incomingJson[section]) ? incomingJson[section] : {};
        const merged = { ...prior };
        for (const [key, value] of Object.entries(extra)) {
            if (!(key in merged)) { merged[key] = value; added.push(`${section}.${key}`); }
        }
        if (Object.keys(merged).length) next[section] = merged;
    }
    return { copy, skip, packageJson: { action: 'merge', added, text: `${JSON.stringify(next, null, 2)}\n` } };
}
```

`SCAFFOLD_START` has the `g` flag omitted on purpose. Do not add `g`, or `test` will alternate. `NAMED_FILE` has `g`. Reset is not required because `matchAll` uses a fresh iterator. If a later call to `matchAll` on the same regex is reused, `matchAll` sets `lastIndex`. Create the match from `new RegExp(NAMED_FILE.source, 'g')` inside the function if a test ever sees a dropped second path. Do that inside `pathsNamedInTask` so the regex is local:

```javascript
    for (const match of source.matchAll(new RegExp(NAMED_FILE.source, 'g'))) keep(match[1]);
```

Remove the `g` flag from the `NAMED_FILE` constant and keep the `new RegExp` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/generate/scaffold.js test/scaffold.test.js
git commit -m "$(cat <<'EOF'
feat: plan scaffold copies without replacing named files

EOF
)"
```

### Task 5: Temp-dir guard on run_command

**Files:**
- Modify: `src/generate/scaffold.js`
- Modify: `src/agent/tools.js` (createToolset signature near the parameter list, and `run_command`)
- Modify: `src/commands/run.js` (the `createToolset` call in `runSingleFlow`)
- Modify: `src/agent/team.js` (`toolBase` near the `runTeam` setup)
- Test: `test/scaffold.test.js`

**Interfaces:**
- Consumes: `scaffoldCommandError`, `planScaffoldMerge`, `resolveInside` from `src/agent/paths.js`
- Produces: `scaffoldTarget(command) -> string`, `retargetScaffold(command, tempDir) -> { command, cwd, from, destination }`, `guardScaffold({ command, root, task, run, protect }) -> Promise<object>`. `run({ command, cwd })` returns `{ exitCode, timedOut, cancelled, stdout, stderr }`. The result adds `copied`, `skipped`, and `added`.

- [ ] **Step 1: Write the failing test**

Append to `test/scaffold.test.js`:

```javascript
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { guardScaffold } from '../src/generate/scaffold.js';

test('guard copies only missing files and skips a failed scaffold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-scaffold-dest-'));
    try {
        await writeFile(path.join(root, 'index.html'), 'OLD');
        await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ scripts: { test: 'node --test test/old.test.js' } })}\n`);
        let spawned = 0;
        const ok = await guardScaffold({
            command: 'npx create-vite@latest .',
            root,
            task: 'Keep index.html.',
            run: async ({ cwd, command }) => {
                spawned += 1;
                assert.match(command, /scaffold/);
                assert.equal(command.includes(root), false);
                await mkdir(path.join(cwd, 'scaffold', 'node_modules'), { recursive: true });
                await mkdir(path.join(cwd, 'scaffold', 'src'), { recursive: true });
                await writeFile(path.join(cwd, 'scaffold', 'index.html'), 'NEW');
                await writeFile(path.join(cwd, 'scaffold', 'src', 'main.js'), 'export {}\n');
                await writeFile(path.join(cwd, 'scaffold', 'node_modules', 'x.js'), '');
                await writeFile(path.join(cwd, 'scaffold', 'package.json'), JSON.stringify({ scripts: { test: 'changed', generate: 'node scripts/generate.js' }, devDependencies: { sass: '*' } }));
                return { exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '' };
            },
        });
        assert.equal(spawned, 1);
        assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), 'OLD');
        assert.equal(await readFile(path.join(root, 'src', 'main.js'), 'utf8'), 'export {}\n');
        assert.equal(await stat(path.join(root, 'node_modules')).then(() => true).catch(() => false), false);
        const merged = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
        assert.equal(merged.scripts.test, 'node --test test/old.test.js');
        assert.equal(merged.scripts.generate, 'node scripts/generate.js');
        assert.equal(merged.devDependencies.sass, '*');
        assert.ok(ok.copied.includes('src/main.js'));
        assert.ok(ok.added.includes('scripts.generate'));
        const before = await readFile(path.join(root, 'index.html'), 'utf8');
        await guardScaffold({
            command: 'npx create-vite@latest .', root, task: '',
            run: async ({ cwd }) => {
                await mkdir(path.join(cwd, 'scaffold'), { recursive: true });
                await writeFile(path.join(cwd, 'scaffold', 'fresh.js'), 'nope');
                return { exitCode: 1, timedOut: false, cancelled: false, stdout: '', stderr: '' };
            },
        });
        assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), before);
        assert.equal(await stat(path.join(root, 'fresh.js')).then(() => true).catch(() => false), false);
        let called = false;
        await assert.rejects(() => guardScaffold({
            command: 'npx create-vite@latest ../outside', root, task: '', run: () => { called = true; },
        }), /Путь вне рабочего каталога/);
        assert.equal(called, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 test/scaffold.test.js`

Expected: FAIL because `guardScaffold` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/generate/scaffold.js`. Add imports `mkdtemp`, `rm`, `readFile`, `writeFile`, `mkdir`, `readdir`, `copyFile`, `stat` from `node:fs/promises`, plus `os` from `node:os`. Import `resolveInside` from `../agent/paths.js`. Update `@depends` to `node:path, node:fs/promises, node:os, agent/paths`.

```javascript
/**
 * The directory token a scaffold will create. `.` when the command omits one.
 * @param {string} command
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function scaffoldTarget(command) {
    const raw = String(command ?? '').trim().split(/\s+/);
    let i = 0;
    const skipFlags = () => { while (raw[i] === '--yes' || raw[i] === '--no-install' || raw[i]?.startsWith('-')) i += 1; };
    if (raw[0] === 'npx') { i = 1; skipFlags(); i += 1; }
    else if (raw[0] === 'npm' && raw[1] === 'init') { i = 2; skipFlags(); }
    else if (raw[0] === 'npm' && (raw[1] === 'create' || raw[1] === 'exec')) { i = 2; skipFlags(); i += 1; }
    const token = raw[i];
    if (!token || token === '--' || token.startsWith('-')) return '.';
    return token;
}

/**
 * Point the scaffold at a folder inside `tempDir`.
 * @param {string} command
 * @param {string} tempDir
 * @returns {{ command: string, cwd: string, from: string, destination: string }}
 * @exports
 * @ai.hint pure
 */
export function retargetScaffold(command, tempDir) {
    const target = scaffoldTarget(command);
    const destination = target === '.' ? '.' : target.replace(/\\/g, '/');
    const from = destination === '.' ? 'scaffold' : destination.split('/').pop();
    let replaced = false;
    const next = String(command).trim().split(/\s+/).map((token) => {
        if (!replaced && token === target) { replaced = true; return from; }
        return token;
    });
    return { command: next.join(' '), cwd: tempDir, from, destination };
}

/**
 * List files under `dir` as posix paths. Skip node_modules and .git.
 * @param {string} dir
 * @param {string} base
 * @returns {Promise<string[]>}
 * @ai.hint io
 */
async function walkFiles(dir, base) {
    const found = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return found; }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        const rel = path.posix.join(base, entry.name);
        if (entry.isDirectory()) found.push(...await walkFiles(abs, rel));
        else if (entry.isFile()) found.push(rel);
    }
    return found;
}

/**
 * Run a scaffold in a temp directory and copy the planned files into `root`.
 * A failure, timeout, or cancel copies nothing. The temp directory is always removed.
 * @param {{ command: string, root: string, task?: string, protect?: string[], run: Function }} request
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function guardScaffold({ command, root, task = '', protect = [], run }) {
    scaffoldCommandError(command);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'ai-scaffold-'));
    try {
        const plan = retargetScaffold(command, temp);
        if (plan.destination !== '.') await resolveInside(root, plan.destination, { forWrite: true });
        const result = await run({ command: plan.command, cwd: temp });
        const empty = { ...result, copied: [], skipped: [], added: [] };
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) return empty;
        const produced = path.join(temp, plan.from);
        const fromDir = await stat(produced).then((info) => (info.isDirectory() ? produced : temp)).catch(() => temp);
        const incoming = await walkFiles(fromDir, '');
        const destRoot = plan.destination === '.' ? root : path.join(root, plan.destination);
        const existing = await walkFiles(destRoot, '');
        const existingPackageText = await readFile(path.join(destRoot, 'package.json'), 'utf8').catch(() => '');
        const incomingPackageText = await readFile(path.join(fromDir, 'package.json'), 'utf8').catch(() => '');
        const decided = planScaffoldMerge({ incoming, existing, task, existingPackageText, incomingPackageText, protect });
        for (const rel of decided.copy) {
            const dest = path.join(destRoot, rel);
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(path.join(fromDir, rel), dest);
        }
        if (decided.packageJson.action === 'copy') {
            await mkdir(destRoot, { recursive: true });
            await copyFile(path.join(fromDir, 'package.json'), path.join(destRoot, 'package.json'));
        } else if (decided.packageJson.action === 'merge') {
            await writeFile(path.join(destRoot, 'package.json'), decided.packageJson.text);
        }
        return { ...result, copied: decided.copy, skipped: decided.skip, added: decided.packageJson.added };
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}
```

In `src/agent/tools.js`, add `scaffoldTask = ''` to the `createToolset` parameter list. Import `guardScaffold` and `isScaffoldCommand` from `../generate/scaffold.js`. At the start of `run_command`, after the empty-command check and after `cwd` is resolved:

```javascript
            if (isScaffoldCommand(args.command)) {
                const result = await guardScaffold({
                    command: args.command, root: cwd, task: scaffoldTask,
                    run: (options) => runCommand({ ...options, timeoutMs, maxOutputBytes: limits.maxCommandOutputBytes, signal, shell }),
                });
                stats.commands.push({ command: args.command, exitCode: result.exitCode, durationMs: result.durationMs });
                const report = commandReport(result, timeoutMs, limits);
                const extra = [`Copied: ${result.copied.join(', ') || '(none)'}`, `Skipped: ${result.skipped.join(', ') || '(none)'}`, `package.json added: ${result.added.join(', ') || '(none)'}`];
                return { output: `${report.output}\n${extra.join('\n')}`, summary: report.summary, ok: report.ok };
            }
```

`cwd` for a scaffold is the project directory the command named. `guardScaffold` uses that path as `root` so a command `cwd` of `client` merges inside `client`. Pass `root: cwd`, not the toolset root, because `resolveInside` already constrained `cwd`.

In `src/commands/run.js`, add `scaffoldTask: task` to the `createToolset` call in `runSingleFlow`.

In `src/agent/team.js`, add `scaffoldTask: task` to the `toolBase` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 test/scaffold.test.js test/generate.test.js test/exec.test.js`

Expected: PASS. `test/exec.test.js` still passes because ordinary commands do not enter the guard.

- [ ] **Step 5: Commit**

```bash
git add src/generate/scaffold.js src/agent/tools.js src/commands/run.js src/agent/team.js test/scaffold.test.js
git commit -m "$(cat <<'EOF'
feat: merge scaffold commands without overwriting files

EOF
)"
```

### Task 6: English prompt fences

**Files:**
- Modify: `src/core/attachments.js`
- Modify: `src/commands/run.js`
- Modify: `src/commands/ask.js`
- Modify: `test/core.test.js`

**Interfaces:**
- Consumes: nothing from the scaffold module
- Produces: `stdinFence(text) -> string` from `src/core/attachments.js`. The file fence is `--- File: <path> (<size>) ---` and `--- End of file: <path> ---`.

- [ ] **Step 1: Write the failing test**

In `test/core.test.js`, extend the text attachment assertion:

```javascript
        assert.match(text.part.text, /--- File: notes\.md /);
        assert.match(text.part.text, /--- End of file: notes\.md ---/);
```

Add:

```javascript
import { stdinFence } from '../src/core/attachments.js';

test('stdin fence is English', () => {
    assert.equal(stdinFence('hello'), '--- stdin ---\nhello\n--- end stdin ---');
});
```

Put the import on the existing attachments import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 test/core.test.js`

Expected: FAIL. The file part still contains `Конец файла`, and `stdinFence` is missing.

- [ ] **Step 3: Write minimal implementation**

In `src/core/attachments.js`, replace the text part with:

```javascript
        part: { type: 'input_text', text: `--- File: ${relative} (${formatBytes(buffer.length)}) ---\n${text}\n--- End of file: ${relative} ---` },
```

Add:

```javascript
/**
 * English fence around stdin that is context rather than the prompt itself.
 * @param {string} text
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stdinFence(text) {
    return `--- stdin ---\n${text}\n--- end stdin ---`;
}
```

Add `stdinFence` to the file-card `@exports`.

In `src/commands/run.js` and `src/commands/ask.js`, import `stdinFence` from `../core/attachments.js` and replace the stdin part with `stdinFence(stdinText)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 test/core.test.js test/scaffold.test.js test/generate.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/attachments.js src/commands/run.js src/commands/ask.js test/core.test.js
git commit -m "$(cat <<'EOF'
fix: frame stdin and file prompts in English

EOF
)"
```
