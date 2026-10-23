/**
 * @file src/generate/scaffold.js
 * @module generate/scaffold
 * @purpose Stack, package.json, recommendations, and the safe scaffold merge for generation.
 * @depends node:path, node:fs/promises, node:os, agent/paths, agent/shell
 * @usedBy generate/brief, agent/tools, commands/run
 * @exports filesForKind, filesForStack, npmPackageName, buildPackageManifest, stackText, recommendStack, scaffoldScript, viteConfig, stackDocuments, kindRules, renderGenerationTask, preparedScaffoldFiles, writePreparedScaffold, ensureDependencies, pathsNamedInTask, isScaffoldCommand, scaffoldCommandError, planScaffoldMerge, scaffoldTarget, retargetScaffold, guardScaffold
 * @ai.tags generate
 * @ai.hint pure
 * @changed 2026-10-22 Web kinds load fonts and icons from a CDN.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { resolveInside } from '../agent/paths.js';
import { runCommand } from '../agent/shell.js';

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
 * File list for a kind after named libraries choose the source language.
 * Preact with TypeScript uses TSX modules and a matching SCSS module.
 * @param {{ kind: string | null, libraries?: { name: string, include: boolean }[] }} request
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function filesForStack({ kind, libraries = [] }) {
    const files = [...filesForKind(kind)];
    const included = new Set(libraries.filter((item) => item.include).map((item) => item.name));
    const ui = included.has('preact') || included.has('react');
    const typed = included.has('typescript');
    if (!ui && !typed) return files;
    const ext = typed ? (ui ? 'tsx' : 'ts') : 'jsx';
    const index = files.indexOf('src/main.js');
    if (index === -1) return files;
    const entry = `src/main.${ext}`;
    files[index] = entry;
    if (ui) files.splice(index + 1, 0, `src/app.${ext}`, 'src/app.scss');
    return files;
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
 * @param {{ name: string, include: boolean }[]} [libraries]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stackText(kind, platform, libraries = []) {
    const included = new Set(libraries.filter((item) => item.include).map((item) => item.name));
    let text;
    if (kind === 'backend') text = 'Node.js 26, ESM, server.js on node:http, bind 127.0.0.1, port PORT or 3000. No dependencies unless a recommendation includes them.';
    else if (kind === 'landing' || kind === 'site') text = `Node.js 26, ESM, Vite, SCSS, ECMAScript ${platform.ecma.edition} (${platform.id}, experimental flags off). No Node server.`;
    else if (kind === 'app') text = `Node.js 26, ESM, Vite, SCSS, ECMAScript ${platform.ecma.edition} (${platform.id}, experimental flags off). server.js serves dist/ after vite build.`;
    else text = 'If this is web, PWA, or frontend, use Node.js 26, ESM, Vite, and SCSS. If it is a backend, use node:http on 127.0.0.1 and port PORT or 3000. Otherwise choose the files the request needs.';
    if (included.has('preact') && included.has('typescript')) text += ' Write the interface as Preact TSX modules. Each component has a matching SCSS module. Do not implement the UI as h() calls in src/main.js.';
    else if (included.has('preact')) text += ' Write the interface as Preact JSX modules. Each component has a matching SCSS module. Do not implement the UI as h() calls in src/main.js.';
    else if (included.has('typescript')) text += ' Source modules are TypeScript.';
    if (included.has('fastify')) text += ' The server uses fastify.';
    return text;
}

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
    preact: { kind: 'runtime', docs: 'https://preactjs.com/guide/v10/getting-started', types: null },
    '@preact/preset-vite': { kind: 'tool', docs: 'https://preactjs.com/guide/v10/getting-started#vite', types: null },
    '@preact/signals': { kind: 'runtime', docs: 'https://preactjs.com/guide/v10/signals', types: null },
    typescript: { kind: 'tool', docs: 'https://www.typescriptlang.org/docs/', types: null },
    sass: { kind: 'tool', docs: 'https://sass-lang.com/documentation/', types: null },
    vite: { kind: 'tool', docs: 'https://vite.dev/guide/', types: null },
    beercss: { kind: 'css', docs: 'https://www.beercss.com/', types: null },
    '@material/material-color-utilities': { kind: 'runtime', docs: 'https://github.com/material-foundation/material-color-utilities', types: null },
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
const URL_PACKAGES = [
    { test: /github\.com\/preactjs\/preact(?:\/|$)/i, names: ['preact', '@preact/preset-vite'] },
    { test: /github\.com\/preactjs\/signals(?:\/|$)/i, names: ['@preact/signals'] },
    { test: /typescriptlang\.org/i, names: ['typescript'] },
    { test: /github\.com\/sass\/sass(?:\/|$)/i, names: ['sass'] },
    { test: /vite\.dev(?:\/|$)/i, names: ['vite'] },
    { test: /github\.com\/fastify\/fastify(?:\/|$)/i, names: ['fastify'] },
    { test: /beercss\.com/i, names: ['beercss'] },
    { test: /github\.com\/google\/material-design-icons(?:\/|$)/i, names: ['material-symbols'] },
    { test: /github\.com\/material-foundation\/material-color-utilities(?:\/|$)/i, names: ['@material/material-color-utilities'] },
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
        const mapped = URL_PACKAGES.find((pack) => pack.test.test(url));
        if (mapped) {
            seen.add(url);
            for (const name of mapped.names) add(name, 'Named by the customer.', true);
            continue;
        }
        seen.add(url);
        libraries.push({ name: url, kind: 'tool', reason: 'Named link.', docs: url, types: null, include: false });
    }
    if (seen.has('fastify') && kind === 'app') add('@fastify/static', 'The app server serves the built files.', true);
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
 * Vite config for a generated web project. The platform profile owns the target strings.
 * @param {{ vite?: { target?: string, cssTarget?: string } }} [platform]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function viteConfig(platform = {}) {
    const target = platform?.vite?.target ?? 'esnext';
    const cssTarget = platform?.vite?.cssTarget ?? 'chrome157';
    return [
        "import { defineConfig } from 'vite';",
        '',
        '// Chrome 157 Beta is the only target. esnext keeps the ES2026 syntax intact.',
        'export default defineConfig({',
        '    build: {',
        `        target: '${target}',`,
        `        cssTarget: '${cssTarget}',`,
        '    },',
        '});',
        '',
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
export function stackDocuments(kind, platform, libraries = []) {
    return {
        '.rules/stack.md': `# Stack\n\n${stackText(kind, platform, libraries)}\n`,
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
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    const lines = [];
    if (kind === 'backend') {
        lines.push('Node.js 26 ESM. Bind 127.0.0.1. Port from PORT or 3000.');
        lines.push(fastify ? 'Use fastify and the companion packages marked include.' : 'Use node:http. Do not add Fastify unless the recommendation includes it.');
    } else if (web) {
        lines.push('Vite, SCSS, and ESM. Node.js 26.');
        lines.push(kind === 'app' ? 'server.js serves dist/ after vite build.' : 'No Node server.');
        lines.push('vite.config.js is already written with the Chrome 157 build targets. Do not plan a step to create or verify it.');
        lines.push('Do not run npm run dev or npm run preview inside a step: they do not exit. Verify with npm run build and read the built files.');
        lines.push('Load fonts and icons from a CDN (Google Fonts, jsDelivr, unpkg). Do not vendor an icon set by hand; use download_font or download_icons only when the task needs local files.');
        lines.push('For each prominent graphic, compare a suitable Lucide or Phosphor icon available to the project (in dependencies or local files), a lightweight HTML/CSS drawing, and raster or SVG artwork. After npm run build, inspect the rendered page and choose the option that best matches the design and remains crisp at its displayed size; do not add every candidate.');
    } else lines.push('Choose the files the request needs.');
    lines.push('Read .rules/ and .skills/ and follow them. Do not overwrite them.');
    lines.push('Add absent package.json keys only. Keep existing script bodies and versions.');
    lines.push('Do not pass --force or -f to a scaffold command. Do not chain a scaffold command with &&, ||, ;, |, or redirection.');
    const prepared = ['package.json', 'scripts/generate.js', ...(web ? ['vite.config.js'] : []), '.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md'];
    lines.push(`${prepared.join(', ')} are already written. Do not plan a step to create or rewrite them.`);
    lines.push('Every step must create or change a named file. Do not spend a step only inspecting installed packages, tool versions, or toolchain internals.');
    lines.push('Dependencies from package.json are installed before the first step. Run npm install only when you add a new package.');
    lines.push('npm test reports 0 tests until the project adds tests. Do not count it as verification.');
    lines.push('Use at most 4 steps. Group the page, styles, and modules into one step when they belong together.');
    if (recommendations.libraries.some((item) => item.name === 'preact' && item.include && recommendations.libraries.some((entry) => entry.name === 'typescript' && entry.include))) {
        lines.push('Write the interface as Preact TSX modules. Each component has a matching SCSS module. Do not implement the UI as h() calls in src/main.js.');
    } else if (recommendations.libraries.some((item) => item.name === 'preact' && item.include)) {
        lines.push('Write the interface as Preact JSX modules. Each component has a matching SCSS module. Do not implement the UI as h() calls in src/main.js.');
    }
    return lines.join('\n');
}

/**
 * Verbatim scaffold files. The model must not spend a step copying them.
 * @param {{ kind: string | null, platform: object, recommendations: { libraries: object[] }, name?: string }} request
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function preparedScaffoldFiles({ kind, platform, recommendations, name = 'app' }) {
    const docs = stackDocuments(kind, platform, recommendations.libraries);
    const manifest = buildPackageManifest({ kind, name, libraries: recommendations.libraries });
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    return {
        'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
        ...(web ? { 'vite.config.js': viteConfig(platform) } : {}),
        'scripts/generate.js': scaffoldScript(),
        ...docs,
    };
}

/**
 * Write prepared scaffold files that are not already present.
 * @param {string} root
 * @param {Record<string, string>} files
 * @returns {Promise<{ written: string[], kept: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function writePreparedScaffold(root, files) {
    const written = [];
    const kept = [];
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        if (await stat(abs).then((info) => info.isFile()).catch(() => false)) {
            kept.push(rel);
            continue;
        }
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
        written.push(rel);
    }
    return { written, kept };
}

/**
 * Install package.json dependencies before the first step so `npm run build` can work.
 * `all` runs at once; `ask` asks the operator; `read` and `write` skip commands.
 * @param {{ root: string, level?: string, approve?: Function, signal?: AbortSignal, timeoutMs?: number, maxOutputBytes?: number, run?: Function }} request
 * @returns {Promise<{ ran: boolean, reason?: string, exitCode?: number|null, timedOut?: boolean, cancelled?: boolean, stdout?: string, stderr?: string }>}
 * @exports
 * @ai.hint io
 */
export async function ensureDependencies({ root, level = 'read', approve = async () => 'no', signal, timeoutMs = 10 * 60_000, maxOutputBytes = 64 * 1024, run = runCommand } = {}) {
    const manifestPath = path.join(root, 'package.json');
    const manifestText = await readFile(manifestPath, 'utf8').catch(() => null);
    if (manifestText === null) return { ran: false, reason: 'no package.json' };
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { return { ran: false, reason: 'invalid package.json' }; }
    const count = (section) => (manifest?.[section] && typeof manifest[section] === 'object' ? Object.keys(manifest[section]).length : 0);
    if (count('dependencies') + count('devDependencies') === 0) return { ran: false, reason: 'no dependencies' };
    const installed = await Promise.all([
        stat(path.join(root, 'node_modules', '.package-lock.json')).then((info) => info.isFile()).catch(() => false),
        stat(path.join(root, 'node_modules', '.bin')).then((info) => info.isDirectory()).catch(() => false),
    ]);
    if (installed.some(Boolean)) return { ran: false, reason: 'already installed' };
    if (level !== 'all' && level !== 'ask') return { ran: false, reason: 'approval level' };
    if (level === 'ask') {
        const answer = await approve({
            name: 'npm install', category: 'command',
            preview: `Установить зависимости из package.json в ${root}`,
        });
        if (answer !== 'yes' && answer !== 'always') return { ran: false, reason: 'declined' };
    }
    const result = await run({
        command: 'npm install --no-audit --no-fund', cwd: root, timeoutMs, maxOutputBytes, signal,
    });
    return { ran: true, ...result };
}

/**
 * English task wrapper. Fidelity, references, and the customer fence are added by the brief.
 * @param {{ kind: string | null, prompt?: string, platform: object, recommendations: object, name?: string }} request
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderGenerationTask({ kind, prompt = '', platform, recommendations, name = 'app' }) {
    void prompt;
    const prepared = new Set(Object.keys(preparedScaffoldFiles({ kind, platform, recommendations, name })));
    const application = filesForStack({ kind, libraries: recommendations.libraries }).filter((file) => !prepared.has(file));
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
        'Dependencies from package.json are installed before the plan. Do not plan a step only to run npm install.',
        'List the recommended libraries. Choose them from the mockup, the attached image, and the design name, with CSS and icons first.',
        'When the customer names a library or a link, include it, and include its documentation and its type package when they exist.',
        'When web_search is available, use it to confirm documentation and type packages.',
        'After the plan, initialize the project and implement the application or its prototype.',
        '',
        'Stack:',
        stackText(kind, platform, recommendations.libraries),
        '',
        'Already written. Do not plan a step to create, copy, or rewrite them:',
        ...Object.keys(preparedScaffoldFiles({ kind, platform, recommendations, name })).map((file) => `- ${file}`),
        '',
        application.length ? 'Create these application files when they are missing:' : 'Create the application files the request needs.',
        ...application.map((file) => `- ${file}`),
        '',
        'Recommendations:',
        ...(libs.length ? libs : ['- (none)']),
        '',
        'The prepared files are complete. Plan the application, not a step per boilerplate file.',
        'Every step must create or change a named file. Do not plan a step only to inspect installed packages, tool versions, or toolchain internals.',
        'For a web kind, verify with npm run build. Do not run npm run dev or npm run preview: they do not exit.',
        'Run npx or npm run generate only for a named generator or template.',
        'Read .rules/ and .skills/ and follow them. Do not overwrite them.',
        'Do not overwrite an existing file. A scaffold command copies only missing paths and adds absent package.json keys.',
    ].join('\n');
}

const NAMED_FILE = /(?:^|[\s"'`(])((?:\.rules|\.skills)\/[\w./-]+|(?:[\w.-]+\/)*[\w.-]+\.(?:html|js|mjs|cjs|scss|css|json|md))\b/;

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
    for (const match of source.matchAll(new RegExp(NAMED_FILE.source, 'g'))) keep(match[1]);
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
