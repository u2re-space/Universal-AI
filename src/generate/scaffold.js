/**
 * @file src/generate/scaffold.js
 * @module generate/scaffold
 * @purpose Stack, package.json, recommendations, and the safe scaffold merge for generation.
 * @depends node:path
 * @usedBy generate/brief, agent/tools
 * @exports filesForKind, npmPackageName, buildPackageManifest, stackText, recommendStack, scaffoldScript, stackDocuments, kindRules, renderGenerationTask
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
 * @param {{ kind: string | null, prompt?: string, platform: object, recommendations: object, name?: string }} request
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
