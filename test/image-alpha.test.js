import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { runProgram } from '../src/agent/shell.js';
import { detectMagick, magickApplyAlphaMask, magickIsOpaque } from '../src/agent/image-magick.js';
import { ALPHA_MASK_PROMPT, applyGeneratedAlphaMask } from '../src/agent/image-alpha.js';
import { TINY_PNG } from './helpers/mock-server.js';

/**
 * Red square on white, 120x80.
 * @param {string} exe
 * @param {string} dir
 * @param {string} file
 * @returns {Promise<void>}
 */
async function makeSubject(exe, dir, file = 'subject.png') {
    await runProgram({
        file: exe, args: ['-size', '120x80', 'xc:white', '-fill', 'red', '-draw', 'rectangle 40,20 80,60', file],
        cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096,
    });
}

/**
 * White square on black (or the inverse), 120x80.
 * @param {string} exe
 * @param {string} dir
 * @param {{ file?: string, size?: string, inverted?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function makeMask(exe, dir, { file = 'mask.png', size = '120x80', inverted = false, box = '40,20 80,60' } = {}) {
    await runProgram({
        file: exe,
        args: ['-size', size, `xc:${inverted ? 'white' : 'black'}`, '-fill', inverted ? 'black' : 'white', '-draw', `rectangle ${box}`, file],
        cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096,
    });
}

/**
 * Read one pixel as a rounded `r,g,b,a` tuple scaled to 0..255.
 * @param {string} exe
 * @param {string} file
 * @param {number} x
 * @param {number} y
 * @param {string} cwd
 * @returns {Promise<number[]>}
 */
async function pixel(exe, file, x, y, cwd) {
    const res = await runProgram({
        file: exe,
        args: [file, '-format', `%[fx:round(255*p{${x},${y}}.r)],%[fx:round(255*p{${x},${y}}.g)],%[fx:round(255*p{${x},${y}}.b)],%[fx:round(255*p{${x},${y}}.a)]`, 'info:'],
        cwd, timeoutMs: 10000, maxOutputBytes: 4096,
    });
    return res.stdout.trim().split(',').map(Number);
}

test('a grayscale mask becomes the alpha channel and keeps the subject color', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-alpha-'));
    try {
        await makeSubject(exe, dir);
        await makeMask(exe, dir);
        const result = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'mask.png', cwd: dir });
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'mask');
        assert.equal(result.inverted, false);
        assert.equal(result.width, 120);
        assert.equal(result.height, 80);
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'subject.png'), cwd: dir }), false);
        assert.deepEqual(await pixel(exe, 'subject.png', 60, 40, dir), [255, 0, 0, 255]);
        assert.deepEqual(await pixel(exe, 'subject.png', 2, 2, dir), [0, 0, 0, 0]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a mask with white corners is inverted before it is applied', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-invert-'));
    try {
        await makeSubject(exe, dir);
        await makeMask(exe, dir, { file: 'inverted.png', inverted: true });
        const result = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'inverted.png', cwd: dir });
        assert.equal(result.changed, true);
        assert.equal(result.inverted, true);
        assert.deepEqual(await pixel(exe, 'subject.png', 60, 40, dir), [255, 0, 0, 255]);
        assert.deepEqual(await pixel(exe, 'subject.png', 2, 2, dir), [0, 0, 0, 0]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a mask drawn on another frame is resized to the image', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-resize-'));
    try {
        await makeSubject(exe, dir);
        await makeMask(exe, dir, { file: 'small.png', size: '60x40', box: '20,10 40,30' });
        const result = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'small.png', cwd: dir });
        assert.equal(result.changed, true);
        assert.equal(result.width, 120);
        assert.deepEqual(await pixel(exe, 'subject.png', 60, 40, dir), [255, 0, 0, 255]);
        assert.deepEqual(await pixel(exe, 'subject.png', 2, 2, dir), [0, 0, 0, 0]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a full-white mask leaves an opaque picture alone', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-full-'));
    try {
        await makeSubject(exe, dir);
        await runProgram({ file: exe, args: ['-size', '120x80', 'xc:white', 'full.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        const result = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'full.png', cwd: dir });
        assert.equal(result.changed, false);
        assert.equal(result.reason, 'full-mask');
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'subject.png'), cwd: dir }), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('applyGeneratedAlphaMask asks the model for a mask and writes RGBA', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-apply-'));
    try {
        await makeSubject(exe, dir, 'art.png');
        await makeMask(exe, dir, { file: 'drawn.png' });
        const maskB64 = (await readFile(path.join(dir, 'drawn.png'))).toString('base64');
        const calls = [];
        const client = {
            images: {
                async edit(request) {
                    calls.push(request);
                    return [maskB64];
                },
            },
        };
        const config = { baseURL: 'https://api.proxyapi.ru/v1/', image: { maskModel: 'vendor/mask-model' } };
        const result = await applyGeneratedAlphaMask({ client, config, file: path.join(dir, 'art.png') });
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'mask');
        assert.equal(result.model, 'vendor/mask-model');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].prompt, ALPHA_MASK_PROMPT);
        assert.equal(calls[0].size, '1536x1024');
        assert.equal(calls[0].format, 'png');
        assert.equal(calls[0].files[0].mime, 'image/png');
        assert.equal((await stat(path.join(dir, 'art.png'))).size > 0, true);
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'art.png'), cwd: dir }), false);
        // The temporary matte is cleaned up next to the image.
        const leftovers = (await import('node:fs/promises')).readdir(dir);
        assert.equal((await leftovers).some((name) => name.startsWith('.tmp-alpha-mask-')), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('applyGeneratedAlphaMask skips a transparent file, a JPEG, and a failing mask request', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-skip-'));
    try {
        const png = path.join(dir, 'tiny.png');
        await writeFile(png, Buffer.from(TINY_PNG, 'base64'));
        const client = { images: { async edit() { throw new Error('must not be called'); } } };
        const already = await applyGeneratedAlphaMask({ client, config: { image: {} }, file: png });
        assert.equal(already.changed, false);
        assert.equal(already.reason, 'already');

        await makeSubject(exe, dir, 'photo.jpg');
        const jpeg = await applyGeneratedAlphaMask({ client, config: { image: {} }, file: path.join(dir, 'photo.jpg') });
        assert.equal(jpeg.changed, false);
        assert.equal(jpeg.reason, 'format');

        // A failed mask request falls back to the local flat fill.
        await makeSubject(exe, dir, 'flat.png');
        const broken = { images: { async edit() { throw new Error('upstream 500'); } } };
        const fallback = await applyGeneratedAlphaMask({ client: broken, config: { image: {} }, file: path.join(dir, 'flat.png') });
        assert.equal(fallback.changed, true);
        assert.equal(fallback.reason, 'flat');
        assert.match(fallback.error.message, /upstream 500/);

        // A matte that covers the whole frame means there is no background to cut.
        await makeSubject(exe, dir, 'whole.png');
        await runProgram({ file: exe, args: ['-size', '120x80', 'xc:white', 'white.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        const white = (await readFile(path.join(dir, 'white.png'))).toString('base64');
        const full = { images: { async edit() { return [white]; } } };
        const opaque = await applyGeneratedAlphaMask({ client: full, config: { image: {} }, file: path.join(dir, 'whole.png') });
        assert.equal(opaque.changed, false);
        assert.equal(opaque.reason, 'opaque');
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'whole.png'), cwd: dir }), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
