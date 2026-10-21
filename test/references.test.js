/**
 * @file test/references.test.js
 * @purpose Tests for src/generate/references.js (stageReferences, resolveRefPath).
 * @ai.hint io
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { stageReferences, resolveRefPath, stageOneReference } from '../src/generate/references.js';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVRICOLi+P8RAAEDAAEBwwABAAAAAElFTkSuQmCC';
const TINY_JPG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

/**
 * Create a temporary working directory.
 */
async function tmpWork() {
    return mkdtemp(path.join(os.tmpdir(), 'ai-refs-test-'));
}

test('stageReferences returns empty arrays for no images', async () => {
    const { refs, warnings } = await stageReferences({ images: [], cwd: process.cwd() });
    assert.deepEqual(refs, []);
    assert.deepEqual(warnings, []);
});

test('stageReferences reuses relative path for local file inside root', async () => {
    const work = await tmpWork();
    try {
        const file = path.join(work, 'mockup.png');
        await writeFile(file, Buffer.from(TINY_PNG, 'base64'));
        const { refs, warnings } = await stageReferences({ images: ['mockup.png'], cwd: work });
        assert.equal(warnings.length, 0);
        assert.equal(refs.length, 1);
        assert.equal(refs[0].rel, 'mockup.png');
        assert.equal(refs[0].mime, 'image/png');
        assert.ok(refs[0].bytes > 0);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});

test('stageReferences copies a file outside root into .ai/refs/', async () => {
    const work = await tmpWork();
    const outside = await tmpWork();
    try {
        const file = path.join(outside, 'design.png');
        const bytes = Buffer.from(TINY_PNG, 'base64');
        await writeFile(file, bytes);
        const { refs, warnings } = await stageReferences({ images: [file], cwd: work });
        assert.equal(warnings.length, 0);
        assert.equal(refs.length, 1);
        assert.ok(refs[0].rel.startsWith('.ai/refs/'));
        assert.ok(refs[0].rel.endsWith('.png'));
        // The staged file exists and has the same bytes
        const staged = await readFile(path.join(work, refs[0].rel));
        assert.deepEqual(staged, bytes);
    } finally {
        await rm(work, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test('stageReferences decodes a data: URL into .ai/refs/', async () => {
    const work = await tmpWork();
    try {
        const dataUrl = `data:image/png;base64,${TINY_PNG}`;
        const { refs, warnings } = await stageReferences({ images: [dataUrl], cwd: work });
        assert.equal(warnings.length, 0);
        assert.equal(refs.length, 1);
        assert.ok(refs[0].rel.startsWith('.ai/refs/'));
        assert.equal(refs[0].mime, 'image/png');
        const staged = await readFile(path.join(work, refs[0].rel));
        assert.ok(staged.length > 0);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});

test('stageReferences is idempotent for the same content', async () => {
    const work = await tmpWork();
    const outside = await tmpWork();
    try {
        const file = path.join(outside, 'same.png');
        const bytes = Buffer.from(TINY_PNG, 'base64');
        await writeFile(file, bytes);
        const r1 = await stageReferences({ images: [file], cwd: work });
        const r2 = await stageReferences({ images: [file], cwd: work });
        assert.equal(r1.refs[0].rel, r2.refs[0].rel);
    } finally {
        await rm(work, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test('stageReferences skips a missing file and emits a warning', async () => {
    const work = await tmpWork();
    try {
        const { refs, warnings } = await stageReferences({ images: ['does-not-exist.png'], cwd: work });
        assert.equal(refs.length, 0);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /не найден/i);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});

test('stageReferences skips an unsupported format', async () => {
    const work = await tmpWork();
    try {
        const file = path.join(work, 'file.txt');
        await writeFile(file, 'not an image');
        const { refs, warnings } = await stageReferences({ images: ['file.txt'], cwd: work });
        assert.equal(refs.length, 0);
        assert.equal(warnings.length, 1);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});

test('stageOneReference throws for an empty string', async () => {
    await assert.rejects(() => stageOneReference('', process.cwd(), 1024), /Пустая ссылка/);
});

test('resolveRefPath returns null for URLs', () => {
    assert.equal(resolveRefPath('https://example.com/a.png', '/tmp'), null);
    assert.equal(resolveRefPath('http://example.com/a.png', '/tmp'), null);
    assert.equal(resolveRefPath('data:image/png;base64,abc', '/tmp'), null);
});

test('resolveRefPath returns null for files outside cwd', () => {
    assert.equal(resolveRefPath('/etc/passwd', '/home/user/project'), null);
});

test('resolveRefPath returns rel for files inside cwd', () => {
    const result = resolveRefPath('assets/img.png', '/home/user/project');
    assert.ok(result);
    assert.equal(result.rel, path.join('assets', 'img.png'));
});

test('stageReferences handles JPEG data URL', async () => {
    const work = await tmpWork();
    try {
        const dataUrl = `data:image/jpeg;base64,${TINY_JPG}`;
        const { refs, warnings } = await stageReferences({ images: [dataUrl], cwd: work });
        assert.equal(warnings.length, 0);
        assert.equal(refs.length, 1);
        assert.equal(refs[0].mime, 'image/jpeg');
        assert.ok(refs[0].rel.endsWith('.jpg'));
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});
