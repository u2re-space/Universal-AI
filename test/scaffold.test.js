import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { filesForKind, filesForStack, npmPackageName, buildPackageManifest, stackText, recommendStack, scaffoldScript, renderGenerationTask, isScaffoldCommand, scaffoldCommandError, planScaffoldMerge, guardScaffold, preparedScaffoldFiles, writePreparedScaffold, ensureDependencies, viteConfig, kindRules } from '../src/generate/scaffold.js';

const platform = { id: 'chrome-156-stable', ecma: { edition: 2026 } };

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

const diaryIdea = `
## Frontend stack
- https://github.com/preactjs/preact
- https://github.com/preactjs/signals
- https://www.typescriptlang.org/download/
- https://github.com/sass/sass (SCSS)
- https://vite.dev/
## Backend stack
- https://github.com/fastify/fastify
- https://www.beercss.com/
- https://github.com/google/material-design-icons
- https://github.com/material-foundation/material-color-utilities
- https://m3.material.io/
`;

test('a Preact and TypeScript idea asks for TSX modules and SCSS modules', () => {
    const result = recommendStack({ kind: 'app', prompt: diaryIdea, references: {} });
    const included = names(result, true);
    for (const name of ['preact', '@preact/signals', '@preact/preset-vite', 'typescript', 'sass', 'fastify', '@fastify/static', 'beercss', 'material-symbols', '@material/material-color-utilities']) {
        assert.ok(included.includes(name), name);
    }
    const design = result.libraries.find((item) => item.name === 'https://m3.material.io/');
    assert.equal(design.include, false);
    assert.equal(result.libraries.some((item) => item.name === 'https://github.com/preactjs/preact'), false);
    const files = filesForStack({ kind: 'app', libraries: result.libraries });
    assert.ok(files.includes('src/main.tsx'));
    assert.ok(files.includes('src/app.tsx'));
    assert.ok(files.includes('src/app.scss'));
    assert.ok(files.includes('src/styles.scss'));
    assert.equal(files.includes('src/main.js'), false);
    const task = renderGenerationTask({
        kind: 'app', prompt: diaryIdea, platform, recommendations: result, name: 'diary-m',
    });
    assert.match(task, /src\/main\.tsx/);
    assert.match(task, /src\/app\.scss/);
    assert.match(task, /TSX/);
    assert.match(task, /SCSS module/);
    assert.equal(buildPackageManifest({ kind: 'app', name: 'diary-m', libraries: result.libraries }).dependencies.preact, '*');
    assert.match(task, /Already written/);
    assert.doesNotMatch(task, /process\.exit/);
});

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
    assert.match(task, /vite\.config\.js/);
    const written = task.slice(task.indexOf('Already written'), task.indexOf('Create these application files'));
    assert.match(written, /vite\.config\.js/);
    const application = task.slice(task.indexOf('Create these application files'), task.indexOf('Recommendations:'));
    assert.doesNotMatch(application, /vite\.config\.js/);
    assert.match(task, /Every step must create or change a named file/);
    assert.match(task, /npm run build/);
    assert.match(task, /Already written/);
    assert.match(task, /Do not plan a step/);
    assert.doesNotMatch(task, /The skeleton is already written/);
    assert.equal(task.includes('Повтори макет'), false);
});

test('prepared scaffold files are written once and an existing file stays', async () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const files = preparedScaffoldFiles({ kind: 'landing', platform, recommendations, name: 'widget' });
    assert.equal(typeof files['scripts/generate.js'], 'string');
    assert.match(files['vite.config.js'], /target: 'esnext'/);
    assert.match(files['vite.config.js'], /cssTarget: 'chrome156'/);
    assert.match(files['package.json'], /"name": "widget"/);
    const backend = preparedScaffoldFiles({ kind: 'backend', platform, recommendations, name: 'api' });
    assert.equal('vite.config.js' in backend, false);
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-prepared-'));
    try {
        await mkdir(path.join(root, '.rules'), { recursive: true });
        await writeFile(path.join(root, '.rules', 'stack.md'), 'keep\n');
        const first = await writePreparedScaffold(root, files);
        assert.ok(first.written.includes('scripts/generate.js'));
        assert.ok(first.written.includes('vite.config.js'));
        assert.ok(first.written.includes('package.json'));
        assert.ok(first.kept.includes('.rules/stack.md'));
        assert.equal(await readFile(path.join(root, '.rules', 'stack.md'), 'utf8'), 'keep\n');
        const second = await writePreparedScaffold(root, files);
        assert.deepEqual(second.written, []);
        assert.ok(second.kept.includes('package.json'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('ensureDependencies installs once and respects the access level', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-deps-'));
    try {
        assert.equal((await ensureDependencies({ root, level: 'all' })).reason, 'no package.json');
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '*' } }));
        assert.equal((await ensureDependencies({ root, level: 'read' })).reason, 'approval level');
        const calls = [];
        const run = async (options) => { calls.push(options); return { exitCode: 0, stdout: '', stderr: '' }; };
        assert.equal((await ensureDependencies({ root, level: 'ask', approve: async () => 'no', run })).reason, 'declined');
        const first = await ensureDependencies({ root, level: 'all', run });
        assert.equal(first.ran, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cwd, root);
        assert.match(calls[0].command, /npm install/);
        await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
        const second = await ensureDependencies({ root, level: 'all', run });
        assert.equal(second.ran, false);
        assert.equal(second.reason, 'already installed');
        assert.equal(calls.length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

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

test('filesForStack with React framework and TypeScript', () => {
    const files = filesForStack({ kind: 'landing', framework: 'react', scriptLanguage: 'typescript' });
    assert.ok(files.includes('src/main.tsx'), 'React + TS should use tsx');
    assert.ok(files.includes('src/App.tsx'), 'React should add App.tsx');
    assert.ok(files.includes('src/App.module.scss'), 'React should add SCSS module');
    assert.equal(files.includes('src/main.js'), false, 'React + TS should not have plain .js');
});

test('filesForStack with Vue framework', () => {
    const files = filesForStack({ kind: 'landing', framework: 'vue' });
    assert.ok(files.includes('src/main.vue') || files.includes('src/main.js'), 'Vue entry file');
    assert.ok(files.includes('src/App.vue'), 'Vue should add App.vue');
});

test('filesForStack with Fest-Lib framework', () => {
    const files = filesForStack({ kind: 'landing', framework: 'fest' });
    assert.ok(files.includes('src/main.tsx'), 'Fest defaults to TypeScript tsx');
    assert.ok(files.includes('src/App.tsx'), 'Fest should add App.tsx');
});

test('filesForStack with Svelte framework', () => {
    const files = filesForStack({ kind: 'landing', framework: 'svelte' });
    assert.ok(files.includes('src/main.svelte') || files.includes('src/main.js'), 'Svelte entry file');
});

test('buildPackageManifest with React framework adds dependencies', () => {
    const manifest = buildPackageManifest({ kind: 'landing', name: 'react-app', framework: 'react' });
    assert.equal(manifest.dependencies.react, '*');
    assert.equal(manifest.devDependencies['@vitejs/plugin-react'], '*');
    assert.equal(manifest.devDependencies.vite, '*');
    assert.equal(manifest.devDependencies.sass, '*');
});

test('buildPackageManifest with Fest-Lib adds Fest dependencies', () => {
    const manifest = buildPackageManifest({ kind: 'landing', name: 'fest-app', framework: 'fest' });
    assert.equal(manifest.dependencies['@fest-lib/lure'], '*');
    assert.equal(manifest.dependencies['@fest-lib/core'], '*');
    assert.equal(manifest.dependencies['@fest-lib/dom'], '*');
    assert.equal(manifest.dependencies['@fest-lib/object'], '*');
    assert.equal(manifest.dependencies['@fest-lib/uniform'], '*');
    assert.equal(manifest.devDependencies['@fest-lib/style-lib'], '*');
});

test('buildPackageManifest with style language Less', () => {
    const manifest = buildPackageManifest({ kind: 'landing', name: 'less-app', styleLanguage: 'less' });
    assert.equal(manifest.devDependencies.less, '*');
    assert.equal(manifest.devDependencies.sass, undefined, 'Less should not add sass');
});

test('buildPackageManifest with style language PostCSS', () => {
    const manifest = buildPackageManifest({ kind: 'landing', name: 'postcss-app', styleLanguage: 'postcss-preset-env' });
    assert.equal(manifest.devDependencies['postcss-preset-env'], '*');
    assert.equal(manifest.devDependencies.sass, undefined);
});

test('stackText mentions React for react framework', () => {
    const text = stackText('landing', platform, [], { framework: 'react' });
    assert.match(text, /React/);
});

test('stackText mentions Fest-Lib for fest framework', () => {
    const text = stackText('landing', platform, [], { framework: 'fest' });
    assert.match(text, /Fest-Lib LUR\.E/);
});

test('stackText mentions Vue SFC for vue framework', () => {
    const text = stackText('landing', platform, [], { framework: 'vue' });
    assert.match(text, /Vue Single-File Components/);
});

test('stackText with Less style language', () => {
    const text = stackText('landing', platform, [], { styleLanguage: 'less' });
    assert.match(text, /Less/);
    assert.doesNotMatch(text, /SCSS/);
});

test('renderGenerationTask with React framework includes React files', () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const task = renderGenerationTask({ kind: 'landing', platform, recommendations, framework: 'react' });
    assert.match(task, /React JSX\/TSX components with Vite plugin/);
    assert.match(task, /src\/main\.jsx/);
    assert.match(task, /src\/App\.jsx/);
});

test('preparedScaffoldFiles with React framework includes React in package.json', () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const files = preparedScaffoldFiles({ kind: 'landing', platform, recommendations, framework: 'react' });
    const pkg = JSON.parse(files['package.json']);
    assert.equal(pkg.dependencies.react, '*');
    assert.equal(pkg.devDependencies['@vitejs/plugin-react'], '*');
});

test('filesForStack with Pug markup replaces index.html with index.pug', () => {
    const files = filesForStack({ kind: 'landing', markup: 'pug' });
    assert.ok(files.includes('index.pug'), 'Pug markup should produce index.pug');
    assert.equal(files.includes('index.html'), false, 'Pug markup should not have index.html');
});

test('filesForStack with htmx markup keeps index.html', () => {
    const files = filesForStack({ kind: 'landing', markup: 'htmx' });
    assert.ok(files.includes('index.html'), 'htmx markup keeps index.html');
});

test('buildPackageManifest with htmx markup adds htm.org dependency', () => {
    const manifest = buildPackageManifest({ kind: 'landing', name: 'htmx-app', markup: 'htmx' });
    assert.equal(manifest.dependencies['htmx.org'], '*');
});

test('buildPackageManifest with Pug markup adds pug as devDependency', () => {
    const manifest = buildPackageManifest({ kind: 'landing', name: 'pug-app', markup: 'pug' });
    assert.equal(manifest.devDependencies.pug, '*');
});

test('viteConfig with htmx markup produces no extra plugins', () => {
    const config = viteConfig(platform, { framework: null, markup: 'htmx' });
    assert.ok(config.includes('defineConfig'), 'viteConfig should always produce a valid config');
    assert.equal(config.includes('pugPlugin'), false, 'htmx should not add pug plugin');
});

test('viteConfig with Pug markup includes pug plugin', () => {
    const config = viteConfig(platform, { framework: null, markup: 'pug' });
    assert.ok(config.includes('pug') || config.includes('pug-plugin'), 'viteConfig should mention pug plugin');
});

test('viteConfig with Fest-Lib framework includes fest plugin', () => {
    const config = viteConfig(platform, { framework: 'fest', markup: null });
    assert.ok(config.includes('fest') || config.includes('lure'), 'viteConfig should mention fest/lure');
});

test('stackText with htmx markup mentions htmx', () => {
    const text = stackText('landing', platform, [], { markupLanguage: 'htmx' });
    assert.match(text, /htmx/i);
});

test('stackText with Pug markup mentions Pug', () => {
    const text = stackText('landing', platform, [], { markupLanguage: 'pug' });
    assert.match(text, /Pug/i);
});

test('kindRules with Fest-Lib framework includes deep rules', () => {
    const rules = kindRules('landing', { libraries: [{ name: '@fest-lib/lure', include: true, reason: 'test' }] }, 'fest');
    assert.match(rules, /Fest-Lib LUR\.E/);
    assert.match(rules, /E\(/);
    assert.match(rules, /observe/);
    assert.match(rules, /formLink|bindForms|FormBinding/);
    assert.match(rules, /withTriggerModifiers|bindOutsideDismiss/);
    assert.match(rules, /bindDraggable/);
    assert.match(rules, /@fest-lib\/icon|Phosphor/);
    assert.match(rules, /JSX/);
});

test('kindRules with htmx markup includes htmx rules', () => {
    const rules = kindRules('landing', { libraries: [] }, null, 'htmx');
    assert.match(rules, /htmx 4|htmx\.org/);
    assert.match(rules, /hx-get|hx-post|hx-put|hx-delete/);
    assert.match(rules, /hx-swap|hx-target/);
});

test('kindRules with Pug markup includes Pug rules', () => {
    const rules = kindRules('landing', { libraries: [] }, null, 'pug');
    assert.match(rules, /Pug/);
    assert.match(rules, /index\.pug/);
});

test('renderGenerationTask with Pug markup mentions index.pug', () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const task = renderGenerationTask({ kind: 'landing', platform, recommendations, markup: 'pug' });
    assert.match(task, /index\.pug/);
});

test('renderGenerationTask with Fest-Lib framework mentions tsx files', () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const task = renderGenerationTask({ kind: 'landing', platform, recommendations, framework: 'fest' });
    assert.match(task, /\.tsx/);
});

test('preparedScaffoldFiles with Pug markup includes index.pug in stack docs', () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const files = preparedScaffoldFiles({ kind: 'landing', platform, recommendations, markup: 'pug' });
    const stackMd = files['.rules/stack.md'];
    assert.ok(stackMd.includes('Pug') || stackMd.includes('pug'), 'stack.md should mention Pug');
});

test('preparedScaffoldFiles with Fest-Lib framework includes fest deps in package.json', () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'Fest-Lib app', references: {} });
    const files = preparedScaffoldFiles({ kind: 'landing', platform, recommendations, framework: 'fest' });
    const pkg = JSON.parse(files['package.json']);
    assert.equal(pkg.dependencies['@fest-lib/lure'], '*');
    assert.equal(pkg.dependencies['@fest-lib/core'], '*');
    assert.equal(pkg.devDependencies['@fest-lib/style-lib'], '*');
});
