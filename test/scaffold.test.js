import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { filesForKind, filesForStack, npmPackageName, buildPackageManifest, stackText, recommendStack, scaffoldScript, renderGenerationTask, isScaffoldCommand, scaffoldCommandError, planScaffoldMerge, guardScaffold, preparedScaffoldFiles, writePreparedScaffold } from '../src/generate/scaffold.js';

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
    assert.match(task, /Already written/);
    assert.match(task, /Do not plan a step/);
    assert.doesNotMatch(task, /The skeleton is already written/);
    assert.equal(task.includes('Повтори макет'), false);
});

test('prepared scaffold files are written once and an existing file stays', async () => {
    const recommendations = recommendStack({ kind: 'landing', prompt: 'page', references: {} });
    const files = preparedScaffoldFiles({ kind: 'landing', platform, recommendations, name: 'widget' });
    assert.equal(typeof files['scripts/generate.js'], 'string');
    assert.match(files['package.json'], /"name": "widget"/);
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-prepared-'));
    try {
        await mkdir(path.join(root, '.rules'), { recursive: true });
        await writeFile(path.join(root, '.rules', 'stack.md'), 'keep\n');
        const first = await writePreparedScaffold(root, files);
        assert.ok(first.written.includes('scripts/generate.js'));
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
