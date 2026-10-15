import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { extractHtmlEntries, formatWorkspace, mergeTaskDraft, parseJsonc, resolveSpecifier, scanWorkspace } from '../src/agent/workspace-scan.js';
import { fileInstructions } from '../src/roles/encoder.js';
import { instructions as plannerInstructions } from '../src/roles/planner.js';

test('parseJsonc keeps strings and drops comments and trailing commas', () => {
    const value = parseJsonc(`{
        // alias
        "paths": { "@/*": ["src/*"], },
        "note": "keep, } this",
        /* block */
    }`);
    assert.deepEqual(value.paths['@/*'], ['src/*']);
    assert.equal(value.note, 'keep, } this');
});

test('extractHtmlEntries reads an import map, module scripts, and stylesheets', () => {
    const html = `<!doctype html>
<script type="importmap">
{ "imports": { "app/": "./src/" } }
</script>
<script type="module" src="./src/main.js"></script>
<link rel="stylesheet" href="./styles.css">
`;
    const entries = extractHtmlEntries(html);
    assert.equal(entries.importMap.imports['app/'], './src/');
    assert.deepEqual(entries.scripts, [{ src: './src/main.js', module: true }]);
    assert.deepEqual(entries.styles, ['./styles.css']);
});

test('resolveSpecifier maps tsconfig paths, node imports, and html import maps', () => {
    const paths = resolveSpecifier('@/app', { baseUrl: '.', paths: { '@/*': ['src/*'] } });
    assert.ok(paths.includes('src/app.ts'));
    const hashed = resolveSpecifier('#lib/util', { imports: { '#lib/*': './src/lib/*.js' } });
    assert.ok(hashed.includes('src/lib/util.js'));
    const mapped = resolveSpecifier('app/main.js', { importMap: { imports: { 'app/': './src/' } } });
    assert.ok(mapped.includes('src/main.js'));
    assert.deepEqual(resolveSpecifier('https://example.com/app.js', { paths: { '@/*': ['src/*'] } }), []);
});

test('scanWorkspace returns null when the directory has no node or frontend markers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-ws-empty-'));
    try {
        assert.equal(await scanWorkspace(root, { task: 'исправь src/app.js' }), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('scanWorkspace sends configs and resolves aliases to real files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-ws-app-'));
    try {
        await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
        await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
            name: 'demo',
            type: 'module',
            imports: { '#lib/*': './src/lib/*.js' },
        }, null, 2)}\n`);
        await writeFile(path.join(root, 'tsconfig.json'), `{
            // aliases
            "compilerOptions": {
                "baseUrl": ".",
                "paths": { "@/*": ["src/*"], },
            },
        }\n`);
        await writeFile(path.join(root, 'index.html'), '<script type="module" src="./src/main.js"></script>\n<link rel="stylesheet" href="./styles.css">\n');
        await writeFile(path.join(root, 'styles.css'), 'body { color: black; }\n');
        await writeFile(path.join(root, 'src', 'app.ts'), 'export const n = 1;\n');
        await writeFile(path.join(root, 'src', 'main.js'), "import { n } from '@/app';\nimport { clip } from '#lib/util';\n");
        await writeFile(path.join(root, 'src', 'lib', 'util.js'), 'export const clip = (v) => v;\n');
        const card = await scanWorkspace(root, { task: 'исправь @/app' });
        assert.equal(card.kind, 'node-frontend');
        assert.equal(card.configFile, 'tsconfig.json');
        const text = formatWorkspace(card);
        assert.match(text, /"name": "demo"/);
        assert.match(text, /@\/\*/);
        assert.match(text, /#lib\/\*/);
        assert.match(text, /src\/main\.js/);
        assert.match(text, /styles\.css/);
        assert.ok(card.files.some((file) => file.path === 'src/app.ts' && file.role === 'edit'));
        assert.ok(card.files.some((file) => file.path === 'src/main.js' && file.role === 'read'));
        assert.ok(card.files.some((file) => file.path === 'src/lib/util.js' && file.role === 'read'));
        assert.ok(card.files.some((file) => file.path === 'styles.css' && file.role === 'read'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('jsconfig is used when tsconfig is absent, and one extends file supplies paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-ws-js-'));
    try {
        await mkdir(path.join(root, 'src'), { recursive: true });
        await writeFile(path.join(root, 'package.json'), '{"name":"lib","type":"module"}\n');
        await writeFile(path.join(root, 'base.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n');
        await writeFile(path.join(root, 'tsconfig.json'), '{"extends":"./base.json","compilerOptions":{"jsx":"react-jsx"}}\n');
        await writeFile(path.join(root, 'src', 'app.ts'), 'export const n = 1;\n');
        const card = await scanWorkspace(root, { task: 'исправь @/app' });
        assert.equal(card.kind, 'node');
        assert.equal(card.configFile, 'tsconfig.json');
        assert.ok(card.files.some((file) => file.path === 'src/app.ts' && file.role === 'edit'));
        await rm(path.join(root, 'tsconfig.json'));
        await writeFile(path.join(root, 'jsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n');
        const js = await scanWorkspace(root, { task: 'почитай @/app' });
        assert.equal(js.configFile, 'jsconfig.json');
        assert.equal(js.kind, 'node');
        assert.ok(js.files.some((file) => file.path === 'src/app.ts' && file.role === 'read'));
        assert.match(formatWorkspace(js), /jsconfig\.json/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a large index.html body is omitted unless the task is about the page', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-ws-html-'));
    try {
        const html = `<script type="importmap">{ "imports": { "app/": "./src/" } }</script>\n${'x'.repeat(9000)}`;
        await writeFile(path.join(root, 'index.html'), html);
        const quiet = await scanWorkspace(root, { task: 'починить server' });
        assert.equal(quiet.kind, 'frontend');
        assert.equal(quiet.indexHtml.included, false);
        const quietText = formatWorkspace(quiet);
        assert.match(quietText, /body omitted/);
        assert.match(quietText, /"app\/": "\.\/src\/"/);
        const loud = await scanWorkspace(root, { task: 'поправь вёрстку index.html' });
        assert.equal(loud.indexHtml.included, true);
        assert.ok(loud.files.some((file) => file.path === 'index.html' && file.role === 'edit'));
        assert.match(formatWorkspace(loud), /\nindex\.html:\n<script type="importmap">/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a linked import map is read from a relative src', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-ws-map-'));
    try {
        await mkdir(path.join(root, 'src'), { recursive: true });
        await writeFile(path.join(root, 'importmap.json'), '{"imports":{"app/":"./src/"}}\n');
        await writeFile(path.join(root, 'index.html'), '<script type="importmap" src="./importmap.json"></script>\n<script type="module" src="/src/main.js"></script>\n');
        await writeFile(path.join(root, 'src', 'main.js'), 'export const n = 1;\n');
        const card = await scanWorkspace(root, { task: 'посмотреть страницу' });
        assert.equal(card.importMaps[0].source, 'index.html');
        assert.equal(card.importMaps[0].map.imports['app/'], './src/');
        assert.ok(card.files.some((file) => file.path === 'src/main.js'));
        assert.equal(card.indexHtml.included, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('an unreadable package.json still marks a node workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-ws-bad-'));
    try {
        await writeFile(path.join(root, 'package.json'), '{');
        const card = await scanWorkspace(root, { task: 'исправь' });
        assert.equal(card.kind, 'node');
        assert.match(formatWorkspace(card), /not valid JSON/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('mergeTaskDraft puts scanner files ahead of the draft', () => {
    const merged = mergeTaskDraft(
        { edit: [{ path: 'a.js', role: 'edit', reason: 'draft' }], read: [], scan: [{ path: 'b.js', role: 'scan', reason: 'рядом' }] },
        [{ path: 'src/app.ts', role: 'edit', reason: 'упомянут в задаче' }],
    );
    assert.equal(merged.edit[0].path, 'src/app.ts');
    assert.equal(merged.edit[1].path, 'a.js');
    assert.equal(merged.scan[0].path, 'b.js');
});

test('planner and encoder prompts tell the model to use the workspace scan', () => {
    assert.match(plannerInstructions, /Workspace scan/);
    assert.match(fileInstructions, /Workspace scan/);
});
