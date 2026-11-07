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
 * @changed 2026-10-30 `onStart` callback, `pipe` option forwarded to the shell.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { resolveInside } from '../agent/paths.js';
import { runCommand } from '../agent/shell.js';

const RULES = ['.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md'];
const WEB_TAIL = ['src/main.js', 'src/styles.scss', 'scripts/generate.js', ...RULES];

/**
 * Front-end framework definitions. Maps a canonical framework name to its
 * library entries (used for dependency resolution) and Vite-plugin entries.
 * The keys are the canonical values stored in config.generate.frontendFramework.
 */
const FRAMEWORKS = Object.freeze({
    vanilla:  { libs: [], plugins: [], defaultScript: 'javascript' },
    react:    { libs: ['react'], plugins: ['@vitejs/plugin-react'], defaultScript: 'javascript' },
    'react-ssr': { libs: ['react', 'react-dom'], plugins: ['@vitejs/plugin-react'], defaultScript: 'javascript' },
    vue:      { libs: ['vue'], plugins: ['@vitejs/plugin-vue'], defaultScript: 'javascript' },
    'vue-runtime': { libs: ['vue'], plugins: ['@vitejs/plugin-vue'], defaultScript: 'javascript' },
    angular:  { libs: ['@angular/core', '@angular/common'], plugins: ['@angular-devkit/build-angular'], defaultScript: 'typescript' },
    svelte:   { libs: ['svelte'], plugins: ['@sveltejs/vite-plugin-svelte'], defaultScript: 'javascript' },
    solid:    { libs: ['solid-js'], plugins: ['@vitejs/plugin-solid'], defaultScript: 'typescript' },
    'solidjs': { libs: ['solid-js'], plugins: ['@vitejs/plugin-solid'], defaultScript: 'typescript' },
    lit:      { libs: ['lit'], plugins: [], defaultScript: 'typescript' },
    fest:     { libs: ['@fest-lib/lure', '@fest-lib/core', '@fest-lib/dom', '@fest-lib/object', '@fest-lib/uniform', '@fest-lib/style-lib'], plugins: [], defaultScript: 'typescript' },
    'fest-lib': { libs: ['@fest-lib/lure', '@fest-lib/core', '@fest-lib/dom', '@fest-lib/object', '@fest-lib/uniform', '@fest-lib/style-lib'], plugins: [], defaultScript: 'typescript' },
});

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
 * File list for a kind after framework and language choices determine extensions.
 * @param {{ kind: string | null, libraries?: { name: string, include: boolean }[], framework?: string | null, scriptLanguage?: string | null, styleLanguage?: string | null, markup?: string | null }} request
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function filesForStack({ kind, libraries = [], framework = null, scriptLanguage = null, styleLanguage = null, markup = null }) {
    const files = [...filesForKind(kind)];
    const included = new Set(libraries.filter((item) => item.include).map((item) => item.name));

    // Backward compatibility: when no explicit framework/scriptLanguage is given,
    // fall back to the old library-based detection (preact + typescript).
    const explicit = framework !== null || scriptLanguage !== null || styleLanguage !== null || markup !== null;
    if (!explicit) {
        const ui = included.has('preact') || included.has('react');
        const typed = included.has('typescript');
        if (!ui && !typed) return files;
        const ext = typed ? (ui ? 'tsx' : 'ts') : 'jsx';
        const index = files.indexOf('src/main.js');
        if (index === -1) return files;
        files[index] = `src/main.${ext}`;
        if (ui) files.splice(index + 1, 0, `src/app.${ext}`, 'src/app.scss');
        return files;
    }

    // Resolve framework (explicit or inferred from libraries).
    const fw = framework ?? (included.has('react') ? 'react' : included.has('vue') ? 'vue' : included.has('svelte') ? 'svelte' : included.has('solid') || included.has('solid-js') ? 'solid' : included.has('lit') ? 'lit' : included.has('@fest-lib/lure') ? 'fest' : 'vanilla');
    const sty = styleLanguage ?? 'scss';
    // Resolve script language: explicit value, or framework default.
    const fDef = FRAMEWORKS[fw];
    const lang = scriptLanguage ?? (fDef?.defaultScript ?? 'javascript');
    if (lang === 'vanilla' || lang === 'none') return files;

    // Determine extension for source files.
    let ext;
    if (fw === 'vue') ext = lang === 'typescript' ? 'ts' : 'js';
    else if (fw === 'svelte') ext = lang === 'typescript' ? 'ts' : 'js';
    else if (fw === 'lit') ext = 'ts';
    else if (fw === 'fest') ext = 'tsx';
    else if (lang === 'typescript') ext = (fw === 'react' || fw === 'react-ssr' || fw === 'solid') ? 'tsx' : 'ts';
    else ext = (fw === 'react' || fw === 'react-ssr' || fw === 'solid') ? 'jsx' : 'js';

    // Determine component entry file.
    const mainIdx = files.indexOf('src/main.js');
    if (mainIdx !== -1) {
        files[mainIdx] = `src/main.${ext}`;
    }
    // Vue: also add App.vue
    if (fw === 'vue') {
        const appIdx = mainIdx !== -1 ? mainIdx : files.length;
        files.splice(appIdx, 0, 'src/App.vue');
    }
    // React/Solid: add App entry
    if ((fw === 'react' || fw === 'react-ssr' || fw === 'solid') && !included.has('preact')) {
        const targetIdx = mainIdx !== -1 ? mainIdx + 1 : 1;
        files.splice(targetIdx, 0, `src/App.${ext}`, `src/App.${sty === 'scss' ? 'module.' + sty : sty}`);
    }
    // Solid: also add index.html entry wrapper
    if (fw === 'solid') {
        const solidIdx = mainIdx !== -1 ? mainIdx + 2 : 2;
        files.splice(solidIdx, 0, 'src/index.css');
    }
    // LIT: add LitElement base file
    if (fw === 'lit') {
        const litIdx = mainIdx !== -1 ? mainIdx + 1 : 1;
        files.splice(litIdx, 0, 'src/app-element.ts');
    }
    // Fest-Lib: add LUR.E entry (TSX)
    if (fw === 'fest') {
        const festIdx = mainIdx !== -1 ? mainIdx + 1 : 1;
        files.splice(festIdx, 0, 'src/App.tsx');
    }
    // Markup language: pug replaces the HTML entry. htmx keeps index.html.
    const mk = markup ?? 'html';
    if (mk === 'pug') {
        const htmlIdx = files.indexOf('index.html');
        if (htmlIdx !== -1) files[htmlIdx] = 'index.pug';
    }
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
 * @param {{ kind: string | null, name: string, libraries?: { name: string, kind: string, include: boolean }[], framework?: string | null, styleLanguage?: string | null, markup?: string | null }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function buildPackageManifest({ kind, name, libraries = [], framework = null, styleLanguage = null, markup = null }) {
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    const scripts = { ...(web ? WEB_SCRIPTS : BACKEND_SCRIPTS) };
    const dev = {};
    const deps = {};
    if (web) { dev.vite = '*'; }
    // Style language dependency
    const sty = styleLanguage ?? 'scss';
    if (web && sty === 'scss') dev.sass = '*';
    else if (web && sty === 'sass') dev.sass = '*'; // sass gem is also 'sass' package on npm
    else if (web && sty === 'less') dev.less = '*';
    else if (web && sty === 'stylus') dev.stylus = '*';
    else if (web && sty === 'postcss-preset-env') dev['postcss-preset-env'] = '*';
    // Framework dependencies
    const fw = framework ?? 'vanilla';
    const fDef = FRAMEWORKS[fw];
    if (fDef) {
        for (const libName of fDef.libs) {
            const known = KNOWN[libName];
            if (known) {
                const bucket = (known.kind === 'css' || known.kind === 'tool' || known.kind === 'types') ? dev : deps;
                if (!(libName in bucket) && !(libName in dev) && !(libName in deps)) bucket[libName] = '*';
            }
        }
        for (const plugin of fDef.plugins) {
            const known = KNOWN[plugin];
            if (known && known.kind === 'tool') {
                if (!(plugin in dev) && !(plugin in deps)) dev[plugin] = '*';
            }
        }
    }
    // Markup language dependency
    const mk = markup ?? 'html';
    if (web && mk === 'htmx') deps['htmx.org'] = '*';
    else if (web && mk === 'pug') dev.pug = '*';
    for (const lib of libraries) {
        if (!lib?.include || typeof lib.name !== 'string') continue;
        const bucket = lib.kind === 'css' || lib.kind === 'tool' || lib.kind === 'types' ? dev : deps;
        if (!(lib.name in bucket) && !(lib.name in dev) && !(lib.name in deps) &&
            Array.from(Object.keys(KNOWN) || [])?.includes?.(lib.name?.trim?.())) bucket[lib.name?.trim?.()] = '*';
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
 * @param {{ framework?: string | null, scriptLanguage?: string | null, styleLanguage?: string | null, markupLanguage?: string | null }} [options]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stackText(kind, platform, libraries = [], options = {}) {
    const included = new Set(libraries.filter((item) => item.include).map((item) => item.name));
    const { framework = null, scriptLanguage = null, styleLanguage = null, markupLanguage = null } = options;
    let text;
    const fw = framework ?? (included.has('react') ? 'react' : included.has('vue') ? 'vue' : included.has('svelte') ? 'svelte' : included.has('@fest-lib/lure') ? 'fest' : null);
    const sty = styleLanguage ?? 'scss';
    const mk = markupLanguage ?? 'html';
    if (kind === 'backend') text = 'Node.js 26, ESM, server.js on node:http, bind 127.0.0.1, port PORT or 3000. No dependencies unless a recommendation includes them.';
    else if (kind === 'landing' || kind === 'site') text = `Node.js 26, ESM, Vite, ${sty === 'scss' ? 'SCSS' : sty === 'sass' ? 'Sass' : sty === 'less' ? 'Less' : sty === 'stylus' ? 'Stylus' : sty === 'postcss-preset-env' ? 'PostCSS' : 'CSS'}, ECMAScript ${platform.ecma.edition} (${platform.id}, experimental flags off). No Node server.`;
    else if (kind === 'app') text = `Node.js 26, ESM, Vite, ${sty === 'scss' ? 'SCSS' : sty === 'sass' ? 'Sass' : sty === 'less' ? 'Less' : sty === 'stylus' ? 'Stylus' : sty === 'postcss-preset-env' ? 'PostCSS' : 'CSS'}, ECMAScript ${platform.ecma.edition} (${platform.id}, experimental flags off). server.js serves dist/ after vite build.`;
    else text = 'If this is web, PWA, or frontend, use Node.js 26, ESM, Vite, and SCSS. If it is a backend, use node:http on 127.0.0.1 and port PORT or 3000. Otherwise choose the files the request needs.';
    if (fw === 'react') text += ' Write the interface as React JSX/TSX components with Vite plugin.';
    else if (fw === 'react-ssr') text += ' Write the interface as React SSR with @vitejs/plugin-react.';
    else if (fw === 'vue') text += ' Write the interface as Vue Single-File Components (.vue) with @vitejs/plugin-vue.';
    else if (fw === 'vue-runtime') text += ' Write the interface as Vue runtime-only SFCs with @vitejs/plugin-vue.';
    else if (fw === 'svelte') text += ' Write the interface as Svelte components (.svelte) with @sveltejs/vite-plugin-svelte.';
    else if (fw === 'solid') text += ' Write the interface as Solid.js TSX with @vitejs/plugin-solid.';
    else if (fw === 'lit') text += ' Write the interface as LitElement web components.';
    else if (fw === 'fest') text += ' Write the interface as Fest-Lib LUR.E components (@fest-lib/lure + @fest-lib/core + @fest-lib/dom + @fest-lib/object).';
    if (mk === 'htmx') text += ' Markup uses htmx 4 (htmx.org): write HTML attributes hx-get, hx-post, hx-swap, hx-target for server-driven fragments.';
    else if (mk === 'pug') text += ' Markup is Pug (.pug). The prepared vite.config.js compiles index.pug to index.html on dev and build.';
    if (included.has('preact') && included.has('typescript')) text += ' Write the interface as Preact TSX modules. Each component has a matching SCSS module. Do not implement the UI as h() calls in src/main.js.';
    else if (included.has('preact')) text += ' Write the interface as Preact JSX modules. Each component has a matching SCSS module. Do not implement the UI as h() calls in src/main.js.';
    else if (scriptLanguage === 'typescript' || included.has('typescript')) text += ' Source modules are TypeScript.';
    if (included.has('fastify')) text += ' The server uses fastify.';
    return text;
}

const KNOWN = Object.freeze({
    tailwindcss: { kind: 'css', docs: 'https://tailwindcss.com/docs', types: null },
    '@tailwindcss/vite': { kind: 'tool', docs: 'https://tailwindcss.com/docs/installation/using-vite', types: null },
    bootstrap: { kind: 'css', docs: 'https://getbootstrap.com/docs/', types: null },
    bulma: { kind: 'css', docs: 'https://bulma.io/documentation/', types: null },
    'open-props': { kind: 'css', docs: 'https://open-props.style/', types: null },
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
    'lucide': { kind: 'icons', docs: 'https://lucide.dev/guide/lucide/getting-started', types: null },
    'lucide-icons': { kind: 'icons', docs: 'https://lucide.dev/icons/', types: null },
    'lucide-npm': { kind: 'icons', docs: 'https://www.npmjs.com/package/lucide', types: null },
    'lucide-static': { kind: 'icons', docs: 'https://www.npmjs.com/package/lucide-static', types: null },
    'lucide-github': { kind: 'icons', docs: 'https://github.com/lucide-icons/lucide', types: null },
    'phosphor-homepage': { kind: 'icons', docs: 'https://github.com/phosphor-icons/homepage', types: null },
    'phosphor-core': { kind: 'icons', docs: 'https://github.com/phosphor-icons/core', types: null },
    'phosphor-web': { kind: 'icons', docs: 'https://github.com/phosphor-icons/web', types: null },
    'phosphor-webcomponents': { kind: 'icons', docs: 'https://github.com/phosphor-icons/webcomponents', types: null },
    'phosphor-icons': { kind: 'icons', docs: 'https://phosphoricons.com/', types: null },
    // Fest-Lib (frontend framework + utilities)
    '@fest-lib/lure': { kind: 'runtime', docs: 'https://github.com/fest-live/lur.e', types: null },
    '@fest-lib/core': { kind: 'runtime', docs: 'https://github.com/fest-live/core.ts', types: null },
    '@fest-lib/dom': { kind: 'runtime', docs: 'https://github.com/fest-live/dom.ts', types: null },
    '@fest-lib/object': { kind: 'runtime', docs: 'https://github.com/fest-live/object.ts', types: null },
    '@fest-lib/uniform': { kind: 'runtime', docs: 'https://github.com/fest-live/uniform.ts', types: null },
    '@fest-lib/image': { kind: 'runtime', docs: 'https://github.com/fest-live/image.ts', types: null },
    '@fest-lib/icon': { kind: 'icons', docs: 'https://github.com/fest-live/icon.ts', types: null },
    '@fest-lib/style-lib': { kind: 'css', docs: 'https://github.com/fest-live/style.ts', types: null },
    // React ecosystem
    'react': { kind: 'runtime', docs: 'https://react.dev/', types: '@types/react' },
    'react-dom': { kind: 'runtime', docs: 'https://react.dev/', types: '@types/react-dom' },
    '@vitejs/plugin-react': { kind: 'tool', docs: 'https://github.com/vitejs/vite/tree/main/packages/plugin-react', types: null },
    '@vitejs/plugin-react-swc': { kind: 'tool', docs: 'https://github.com/vitejs/vite-plugin-react-swc', types: null },
    // Vue ecosystem
    'vue': { kind: 'runtime', docs: 'https://vuejs.org/', types: '@vue/runtime-core' },
    '@vitejs/plugin-vue': { kind: 'tool', docs: 'https://github.com/vitejs/vite-plugin-vue', types: null },
    // Angular ecosystem
    '@angular/core': { kind: 'runtime', docs: 'https://angular.io/', types: null },
    '@angular/common': { kind: 'runtime', docs: 'https://angular.io/', types: null },
    '@angular-devkit/build-angular': { kind: 'tool', docs: 'https://angular.io/', types: null },
    // Svelte ecosystem
    'svelte': { kind: 'runtime', docs: 'https://svelte.dev/', types: null },
    '@sveltejs/vite-plugin-svelte': { kind: 'tool', docs: 'https://github.com/sveltejs/vite-plugin-svelte', types: null },
    // Solid ecosystem
    'solid-js': { kind: 'runtime', docs: 'https://www.solidjs.com/', types: null },
    '@vitejs/plugin-solid': { kind: 'tool', docs: 'https://github.com/solidjs/solid-refresh', types: null },
    // LIT
    'lit': { kind: 'runtime', docs: 'https://lit.dev/', types: null },
    // Style languages
    'less': { kind: 'css', docs: 'https://lesscss.org/', types: null },
    'stylus': { kind: 'css', docs: 'https://stylus-lang.com/', types: null },
    'postcss-preset-env': { kind: 'css', docs: 'https://postcss.org/', types: null },
    'sugarss': { kind: 'css', docs: 'https://sugarss.postcss.org/', types: null },
    // Markup languages
    'htmx.org': { kind: 'runtime', docs: 'https://htmx.org/', types: null },
    'pug': { kind: 'tool', docs: 'https://pugjs.org/api/reference.html', types: null },
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
    { test: /phosphor/i, name: '@phosphor-icons/core' },
    { test: /tabler/i, name: '@tabler/icons' },
    { test: /material symbols|material icons/i, name: 'material-symbols' },
    { test: /lucide/i, name: 'lucide-static' },
];
const SERVERS = [
    { test: /\bfastify\b/i, name: 'fastify' },
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
    // Fest-Lib repos
    { test: /github\.com\/fest-live\/lur\.e(?:\/|$)/i, names: ['@fest-lib/lure'] },
    { test: /github\.com\/fest-live\/core\.ts(?:\/|$)/i, names: ['@fest-lib/core'] },
    { test: /github\.com\/fest-live\/dom\.ts(?:\/|$)/i, names: ['@fest-lib/dom'] },
    { test: /github\.com\/fest-live\/object\.ts(?:\/|$)/i, names: ['@fest-lib/object'] },
    { test: /github\.com\/fest-live\/uniform\.ts(?:\/|$)/i, names: ['@fest-lib/uniform'] },
    { test: /github\.com\/fest-live\/style\.ts(?:\/|$)/i, names: ['@fest-lib/style-lib'] },
    { test: /github\.com\/fest-live\/image\.ts(?:\/|$)/i, names: ['@fest-lib/image'] },
    { test: /github\.com\/fest-live\/icon\.ts(?:\/|$)/i, names: ['@fest-lib/icon'] },
    // htmx and pug
    { test: /github\.com\/bigskysoftware\/htmx(?:\/|$)/i, names: ['htmx.org'] },
    { test: /github\.com\/pugjs\/pug(?:\/|$)/i, names: ['pug'] },
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
 * Framework and markup choices add imports, plugins, and JSX options.
 * @param {{ vite?: { target?: string, cssTarget?: string } }} [platform]
 * @param {{ framework?: string | null, markup?: string | null }} [options]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function viteConfig(platform = {}, { framework = null, markup = null } = {}) {
    const target = platform?.vite?.target ?? 'esnext';
    const cssTarget = platform?.vite?.cssTarget ?? 'chrome156';
    const fw = framework ?? 'vanilla';
    const mk = markup ?? 'html';
    const lines = ["import { defineConfig } from 'vite';"];
    const plugins = [];
    // Framework Vite plugin.
    if (fw === 'react' || fw === 'react-ssr') {
        lines.push("import react from '@vitejs/plugin-react';");
        plugins.push('react()');
    } else if (fw === 'vue' || fw === 'vue-runtime') {
        lines.push("import vue from '@vitejs/plugin-vue';");
        plugins.push('vue()');
    } else if (fw === 'svelte') {
        lines.push("import { svelte } from '@sveltejs/vite-plugin-svelte';");
        plugins.push('svelte()');
    } else if (fw === 'solid' || fw === 'solidjs') {
        lines.push("import solid from '@vitejs/plugin-solid';");
        plugins.push('solid()');
    } else if (fw === 'fest') {
        // Fest-Lib LUR.E ships its JSX factory in a TypeScript subpath. esbuild compiles it.
        lines.push("import { lureJsx } from '@fest-lib/lure';");
        lines.push('');
        lines.push('// LUR.E jsx factory. Automatic runtime points at the package jsx-runtime export.');
        lines.push('const festJsxPlugin = () => ({');
        lines.push('    name: "fest-lure-jsx",');
        lines.push('    config() {');
        lines.push('        return {');
        lines.push('            esbuild: {');
        lines.push('                jsx: "transform",');
        lines.push('                jsxFactory: "lureJsx",');
        lines.push('                jsxFragment: "Fragment",');
        lines.push('                loader: "jsx",');
        lines.push('            },');
        lines.push('        };');
        lines.push('    },');
        lines.push('});');
        plugins.push('festJsxPlugin()');
    }
    // Markup language plugin.
    if (mk === 'pug') {
        lines.push("import pug from 'pug';");
        lines.push("import { readFileSync, writeFileSync, existsSync } from 'node:fs';");
        lines.push('');
        lines.push('const pugFile = new URL("./index.pug", import.meta.url);');
        lines.push('const htmlFile = new URL("./index.html", import.meta.url);');
        lines.push('const compilePug = () => {');
        lines.push('    if (!existsSync(pugFile)) return;');
        lines.push('    const render = pug.compileFile(pugFile, { filename: pugFile });');
        lines.push('    writeFileSync(htmlFile, render(), "utf8");');
        lines.push('};');
        lines.push('const pugPlugin = () => ({');
        lines.push('    name: "vite-pug",');
        lines.push('    buildStart: compilePug,');
        lines.push('    configureServer(server) {');
        lines.push('        server.middlewares.use((req, res, next) => {');
        lines.push('            if (req.url === "/" || req.url?.startsWith("/index")) {');
        lines.push('                try { compilePug(); } catch { /* keep the previous html */ }');
        lines.push('            }');
        lines.push('            next();');
        lines.push('        });');
        lines.push('    },');
        lines.push('    handleHotUpdate({ file, server }) {');
        lines.push('        if (file.endsWith(".pug")) { compilePug(); server.ws.send({ type: "full-reload" }); return []; }');
        lines.push('    },');
        lines.push('});');
        plugins.push('pugPlugin()');
    }
    lines.push('');
    lines.push('// Chromium 156 based browser is the only target. esnext keeps the ES2026 syntax intact.');
    lines.push('export default defineConfig({');
    if (plugins.length) lines.push(`    plugins: [${plugins.join(', ')}],`);
    lines.push('    build: {');
    lines.push(`        target: '${target}',`);
    lines.push(`        cssTarget: '${cssTarget}',`);
    lines.push('    },');
    lines.push('});');
    lines.push('');
    return lines.join('\n');
}

/**
 * English rule and skill bodies.
 * @param {string | null} kind
 * @param {{ id: string, ecma: { edition: number } }} platform
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function stackDocuments(kind, platform, libraries = [], options = {}) {
    return {
        '.rules/stack.md': `# Stack\n\n${stackText(kind, platform, libraries, options)}\n`,
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
export function kindRules(kind, recommendations, framework = null, markup = null) {
    const fastify = recommendations.libraries.some((item) => item.name === 'fastify' && item.include);
    const included = new Set(recommendations.libraries.filter((item) => item.include).map((item) => item.name));
    const fw = framework ?? (included.has('react') ? 'react' : included.has('vue') ? 'vue' : included.has('svelte') ? 'svelte' : included.has('@fest-lib/lure') ? 'fest' : included.has('lit') ? 'lit' : included.has('solid') || included.has('solid-js') ? 'solid' : null);
    const mk = markup ?? 'html';
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    const lines = [];
    if (kind === 'backend') {
        lines.push('Node.js 26 ESM. Bind 127.0.0.1. Port from PORT or 3000.');
        lines.push(fastify ? 'Use fastify and the companion packages marked include.' : 'Use node:http. Do not add Fastify unless the recommendation includes it.');
    } else if (web) {
        if (fw === 'react') lines.push('Vite + @vitejs/plugin-react, React JSX/TSX, and ESM. Node.js 26.');
        else if (fw === 'react-ssr') lines.push('Vite + @vitejs/plugin-react, React SSR, and ESM. Node.js 26.');
        else if (fw === 'vue') lines.push('Vite + @vitejs/plugin-vue, Vue SFC (.vue), and ESM. Node.js 26.');
        else if (fw === 'vue-runtime') lines.push('Vite + @vitejs/plugin-vue, Vue runtime-only SFC (.vue), and ESM. Node.js 26.');
        else if (fw === 'svelte') lines.push('Vite + @sveltejs/vite-plugin-svelte, Svelte components (.svelte), and ESM. Node.js 26.');
        else if (fw === 'solid') lines.push('Vite + @vitejs/plugin-solid, Solid.js TSX, and ESM. Node.js 26.');
        else if (fw === 'lit') lines.push('Vite, LitElement web components, and ESM. Node.js 26.');
        else if (fw === 'fest') lines.push('Vite, Fest-Lib LUR.E (@fest-lib/lure + core + dom + object + uniform), and ESM. Node.js 26.');
        else lines.push('Vite, SCSS, and ESM. Node.js 26.');
        lines.push(kind === 'app' ? 'server.js serves dist/ after vite build.' : 'No Node server.');
        lines.push('vite.config.js is already written with the Chromium 156 based browser build targets. Do not plan a step to create or verify it.');
        lines.push('Do not run npm run dev or npm run preview inside a step: they do not exit. Verify with npm run build and read the built files.');
        lines.push('Load fonts and icons from a CDN (Google Fonts, jsDelivr, unpkg). Do not vendor an icon set by hand; use download_font or download_icons only when the task needs local files.');
        lines.push('For each prominent graphic, compare existing candidates only: suitable Lucide or Phosphor icons available to the project, lightweight HTML/CSS drawings, and existing raster or SVG artwork. Do not generate new images for comparison or atlas packing. Use compare_images to create a local PNG sheet and optional pixel-difference map directly from raster data with sharp/node-canvas, rendering SVG candidates through ReSVG; do not create an SVG snapshot or rasterize comparison in a browser, and do not spend an AI request on comparison. Candidates are fitted proportionally into a common aspect-ratio frame with transparent/neutral padding or a deliberate crop; never stretch them. Preserve the original candidates and prefer a PNG that already has a real alpha channel; an optional SVG conversion may be tried on a copy. If a WebP copy is useful, convert it locally and keep the PNG; never use image generation or editing just to change the format. After npm run build, inspect the rendered page and retain only the best-fitting existing option.');
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
    // Fest-Lib deep rules: LUR.E primitives, forms, overlays, drag, and icon.
    if (fw === 'fest') {
        lines.push('Fest-Lib LUR.E: build the UI with the package factories — E(tag|node, props, children) for create/wrap/bind, H`html` or H("<div>") for HTML parse, M(list, mapFn) for reactive lists, Q(selector, root) for live queries, T(string|ref) for text, C(ref, factory) for conditional swap, and S`css` for controllable stylesheets.');
        lines.push('Reactive state comes from @fest-lib/object: observe(value) and iterated([...]). Bind refs through E props (attributes, classList, style, on) or the H prefixes attr:*, prop:*, on:*/@*, ref/ref:*.');
        lines.push('Forms: use formLink / bindForms / FormBinding / bindFormControl / formRef. Mount lifecycle is opt-in through bindWhileConnected.');
        lines.push('Triggers and overlays: use withTriggerModifiers (once/debounce/prevent/stop/capture/passive), bindOutsideDismiss, resolvePlacement / placeOverlay, and registerTransientOverlay. Do not write ad-hoc listeners when these exist.');
        lines.push('Drag: bindDraggable(target, onEnd).');
        lines.push('Icons: @fest-lib/icon ships the Phosphor ui-icon web component with OPFS and CSS-registry caches. Use it in place of hand-written SVG or other icon sets when fest-lib is the framework.');
        lines.push('JSX: the prepared vite.config.js already sets the LUR.E jsx factory (E) and the jsx fragment. Each .tsx file imports E, H, M, Q, T, C, S from "@fest-lib/lure" and uses JSX for the component tree.');
    }
    if (mk === 'htmx') {
        lines.push('Markup: htmx 4 (htmx.org). The script tag loads htmx from the CDN or from the installed package. Use hx-get/hx-post/hx-put/hx-delete, hx-swap, hx-target, hx-boost, and hx-trigger for server-driven fragments. Do not duplicate the interactivity in JS.');
    } else if (mk === 'pug') {
        lines.push('Markup: Pug. index.pug is the source template; the prepared vite.config.js compiles it to index.html on dev and build. Write .pug partials under src/ for shared blocks and include or extend them. Do not hand-edit index.html — it is generated.');
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
export function preparedScaffoldFiles({ kind, platform, recommendations, name = 'app', framework = null, scriptLanguage = null, styleLanguage = null, markup = null }) {
    const docsOpts = { framework, scriptLanguage, styleLanguage, markupLanguage: markup };
    const docs = stackDocuments(kind, platform, recommendations.libraries, docsOpts);
    const manifest = buildPackageManifest({ kind, name, libraries: recommendations.libraries, framework, styleLanguage, markup });
    const web = kind === 'landing' || kind === 'site' || kind === 'app';
    return {
        'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
        ...(web ? {
            'vite.config.js': viteConfig(platform, { framework, markup }),
        } : {}),
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
 * `onStart` is notified before the install begins, and `pipe` echoes npm output live so the
 * wait does not look like a freeze.
 * @param {{ root: string, level?: string, approve?: Function, signal?: AbortSignal, timeoutMs?: number, maxOutputBytes?: number, run?: Function, pipe?: boolean, onStart?: Function }} request
 * @returns {Promise<{ ran: boolean, reason?: string, exitCode?: number|null, timedOut?: boolean, cancelled?: boolean, stdout?: string, stderr?: string }>}
 * @exports
 * @ai.hint io
 */
export async function ensureDependencies({ root, level = 'read', approve = async () => 'no', signal, timeoutMs = 10 * 60_000, maxOutputBytes = 64 * 1024, run = runCommand, pipe = true, onStart = null } = {}) {
    const manifestPath = path.join(root, 'package.json');
    const manifestText = await readFile(manifestPath, 'utf8').catch(() => null);
    if (manifestText === null) return { ran: false, reason: 'no package.json' };
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { return { ran: false, reason: 'invalid package.json' }; }
    const count = (section) => (manifest?.[section] && typeof manifest[section] === 'object' ? Object.keys(manifest[section]).length : 0);
    const total = count('dependencies') + count('devDependencies');
    if (total === 0) return { ran: false, reason: 'no dependencies' };
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
    onStart?.(total);
    const result = await run({
        command: 'npm install --no-audit --no-fund', cwd: root, timeoutMs, maxOutputBytes, signal, pipe,
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
export function renderGenerationTask({ kind, prompt = '', platform, recommendations, name = 'app', framework = null, scriptLanguage = null, styleLanguage = null, markup = null }) {
    void prompt;
    const opts = { framework, scriptLanguage, styleLanguage, markup };
    const prepared = new Set(Object.keys(preparedScaffoldFiles({ kind, platform, recommendations, name, ...opts })));
    const application = filesForStack({ kind, libraries: recommendations.libraries, ...opts }).filter((file) => !prepared.has(file));
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
        stackText(kind, platform, recommendations.libraries, opts),
        '',
        'Already written. Do not plan a step to create, copy, or rewrite them:',
        ...Object.keys(preparedScaffoldFiles({ kind, platform, recommendations, name, ...opts })).map((file) => `- ${file}`),
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
