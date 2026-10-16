import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesForKind, npmPackageName, buildPackageManifest, stackText, recommendStack } from '../src/generate/scaffold.js';

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
