import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { openHandoff, spillAnswer } from '../src/agent/handoff.js';
import {
    applyRemoveLines, cleanExtractPath, extractHandoff, extractionChunks, hasExtractableArtifacts,
    languageExtension, normalizeLanguage, parseExtraction, renderExtractionPrompt,
} from '../src/agent/extract.js';

test('language tags map to clean extensions', () => {
    assert.equal(normalizeLanguage('JavaScript'), 'js');
    assert.equal(normalizeLanguage('.ts'), 'ts');
    assert.equal(languageExtension('typescript'), '.ts');
    assert.equal(languageExtension('html'), '.html');
    assert.equal(languageExtension('python'), '.py');
    assert.equal(languageExtension('unknown-language'), '.txt');
    assert.equal(languageExtension(''), '.txt');
});

test('extracted paths stay relative, gain an extension, and never collide', () => {
    const used = new Set();
    assert.equal(cleanExtractPath('src/app', 'js', 1, used), 'src/app.js');
    assert.equal(cleanExtractPath('src/app.js', 'js', 2, used), 'src/app-2.js');
    assert.equal(cleanExtractPath('../secret.js', 'js', 3, used), 'snippet-003.js');
    assert.equal(cleanExtractPath('C:/tmp/a.js', 'js', 4, used), 'snippet-004.js');
    assert.equal(cleanExtractPath('.tmp/run/a.js', 'js', 5, used), 'snippet-005.js');
    assert.equal(cleanExtractPath('foo:bar.js', 'js', 6, used), 'snippet-006.js');
    assert.equal(cleanExtractPath('src//app.js', 'js', 7, used), 'snippet-007.js');
    assert.equal(cleanExtractPath('', 'css', 8, used), 'snippet-008.css');
    assert.equal(cleanExtractPath('bad\nname.js', 'js', 9, used), 'snippet-009.js');
    assert.equal(cleanExtractPath('scan.comp', 'glsl', 10, used), 'scan.comp');
});

test('extraction chunks respect the file count and byte budget', () => {
    const artifacts = [
        { id: 'a001', bytes: 10 },
        { id: 'a002', bytes: 20 },
        { id: 'a003', bytes: 30 },
    ];
    assert.deepEqual(extractionChunks(artifacts, { maxFiles: 2, maxBytes: 1000 }).map((chunk) => chunk.map((item) => item.id)), [['a001', 'a002'], ['a003']]);
    assert.deepEqual(extractionChunks(artifacts, { maxFiles: 10, maxBytes: 35 }).map((chunk) => chunk.map((item) => item.id)), [['a001', 'a002'], ['a003']]);
    assert.deepEqual(extractionChunks([], { maxFiles: 2 }), []);
});

test('removeLines drops 1-based lines and ignores bad values', () => {
    assert.equal(applyRemoveLines('one\ntwo\nthree\nfour', [1, 3]), 'two\nfour');
    assert.equal(applyRemoveLines('one\ntwo', [0, 99, 1.5]), 'one\ntwo');
    assert.equal(applyRemoveLines('one\ntwo', []), 'one\ntwo');
});

test('parseExtraction uses content, removeLines, and safe defaults', () => {
    const artifacts = [
        { id: 'a001', hintPath: null, hintLanguage: 'js', bytes: 20 },
        { id: 'a002', hintPath: 'styles.css', hintLanguage: 'css', bytes: 20 },
        { id: 'a003', hintPath: null, hintLanguage: 'text', bytes: 20 },
    ];
    const bodies = new Map([
        ['a001', 'Here is the file:\nexport const a = 1;\nThat is all.'],
        ['a002', 'body { color: red; }'],
        ['a003', 'not a file'],
    ]);
    const files = parseExtraction({
        summary: 'clean',
        files: [
            { source: 'a001', path: 'src/a', language: 'js', content: '```js\nexport const a = 1;\n```', removeLines: [] },
            { source: 'a002', path: '', language: 'css', content: '', removeLines: [] },
            { source: 'a404', path: 'x.js', language: 'js', content: 'x', removeLines: [] },
            { source: 'a001', path: 'duplicate.js', language: 'js', content: 'x', removeLines: [] },
        ],
    }, artifacts, bodies);
    assert.deepEqual(files.map((file) => [file.source, file.path, file.language, file.body]), [
        ['a001', 'src/a.js', 'js', 'export const a = 1;'],
        ['a002', 'styles.css', 'css', 'body { color: red; }'],
    ]);
    assert.match(renderExtractionPrompt(artifacts.slice(0, 1), bodies), /1\tHere is the file:/);
});

test('extractHandoff writes clean files, marks originals, and keeps a failed chunk', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-extract-'));
    try {
        const state = await openHandoff(root);
        await spillAnswer(root, state, 'Here is the module.\n\n```js\nexport const a = 1;\n```\n\nAnd the style.\n\n```css\nbody { color: red; }\n```\nroute: encode');
        assert.equal(hasExtractableArtifacts(state), true);
        const prompts = [];
        const result = await extractHandoff({
            root, state, maxFiles: 1, maxBytes: 1024,
            run: async (text) => {
                prompts.push(text);
                if (text.includes('[artifact a001]')) {
                    return { status: 'completed', data: { summary: 'js', files: [{ source: 'a001', path: 'src/app.js', language: 'js', content: 'export const a = 1;', removeLines: [] }] } };
                }
                return { status: 'failed', error: new Error('small model failed') };
            },
        });
        assert.equal(result.calls, 2);
        assert.equal(prompts.length, 2);
        assert.equal(result.files.length, 1);
        assert.equal(await readFile(path.join(root, '.tmp', state.id, 'extracted', 'src', 'app.js'), 'utf8'), 'export const a = 1;');
        assert.equal(state.artifacts.find((item) => item.id === 'a001').supersededBy, result.files[0].id);
        assert.equal(state.artifacts.find((item) => item.id === 'a002').supersededBy, undefined);
        assert.match(state.text, /# Extracted files/);
        const saved = JSON.parse(await readFile(path.join(root, '.tmp', state.id, 'handoff.json'), 'utf8'));
        assert.equal(saved.artifacts.some((item) => item.extracted && item.hintPath === 'src/app.js'), true);
        assert.equal(saved.raw, `.tmp/${state.id}/answer.md`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a failed extraction leaves the original artifacts untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-extract-fail-'));
    try {
        const state = await openHandoff(root);
        await spillAnswer(root, state, '```js\nexport const a = 1;\n```\nroute: encode');
        const events = [];
        const result = await extractHandoff({
            root, state, run: async () => ({ status: 'failed', error: new Error('nope') }),
            notify: (event) => events.push(event),
        });
        assert.equal(result.files.length, 0);
        assert.equal(state.artifacts[0].supersededBy, undefined);
        assert.equal(state.artifacts.length, 1);
        assert.equal(events.some((event) => event.type === 'warning'), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
