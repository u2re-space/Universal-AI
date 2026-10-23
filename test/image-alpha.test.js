import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { runProgram } from '../src/agent/shell.js';
import { detectMagick, magickApplyAlphaMask, magickContourAlphaMask, magickDetectFakeTransparency, magickIsOpaque, magickSaturationAlphaMask } from '../src/agent/image-magick.js';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask } from '../src/agent/image-alpha.js';
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

/**
 * Remove a temporary directory. ImageMagick may still hold a handle on Windows right after a call,
 * so the removal is retried a few times before giving up.
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function rmDir(dir) {
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            await rm(dir, { recursive: true, force: true });
            return;
        } catch (error) {
            if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    await rm(dir, { recursive: true, force: true });
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
        await rmDir(dir);
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
        await rmDir(dir);
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
        await rmDir(dir);
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
        await rmDir(dir);
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
                    // The paint pass returns a plain picture; the matte pass returns the mask.
                    return [request.prompt === ALPHA_MASK_PROMPT ? maskB64 : maskB64];
                },
            },
        };
        const config = { baseURL: 'https://api.proxyapi.ru/v1/', image: { maskModel: 'vendor/mask-model', paintBackground: false } };
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
        await rmDir(dir);
    }
});

test('applyGeneratedAlphaMask paint + mask pipeline with paintBackground enabled', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-paint-'));
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
        const artBytes = await readFile(path.join(dir, 'art.png'));
        const config = { baseURL: 'https://api.proxyapi.ru/v1/', image: { maskModel: 'tech/model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file: path.join(dir, 'art.png') });
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'mask');
        assert.equal(result.model, 'tech/model');
        assert.equal(result.painted, true);
        // Two calls: first the background paint, then the matte — both from the clean source.
        assert.equal(calls.length, 2);
        assert.equal(calls[0].prompt, BACKGROUND_PAINT_PROMPT);
        assert.equal(calls[1].prompt, ALPHA_MASK_PROMPT);
        // The matte is the geometry of the subject, so it is drawn from the source, not from the
        // painted picture the paint pass returned.
        assert.deepEqual(calls[1].files[0].bytes, artBytes);
        assert.equal(calls[1].files[0].filename, 'art.png');
    } finally {
        await rmDir(dir);
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

        // A failed mask request falls back to the local contour matte.
        await makeSubject(exe, dir, 'flat.png');
        const broken = { images: { async edit() { throw new Error('upstream 500'); } } };
        const fallback = await applyGeneratedAlphaMask({ client: broken, config: { image: {} }, file: path.join(dir, 'flat.png') });
        assert.equal(fallback.changed, true);
        assert.equal(fallback.reason, 'contour');
        assert.match(String(fallback.error?.message ?? ''), /upstream 500/);

        // A matte that covers the whole frame means there is no background to cut.
        await makeSubject(exe, dir, 'whole.png');
        await runProgram({ file: exe, args: ['-size', '120x80', 'xc:white', 'white.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        const white = (await readFile(path.join(dir, 'white.png'))).toString('base64');
        const full = { images: { async edit() { return [white]; } } };
        const opaque = await applyGeneratedAlphaMask({ client: full, config: { image: { paintBackground: false } }, file: path.join(dir, 'whole.png') });
        assert.equal(opaque.changed, false);
        assert.equal(opaque.reason, 'opaque');
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'whole.png'), cwd: dir }), true);
    } finally {
        await rmDir(dir);
    }
});

test('applyGeneratedAlphaMask builds the matte from the clean alphaSource, not the saved picture', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-source-'));
    try {
        // The saved picture is white-on-black, the clean source is the red square on white.
        await runProgram({ file: exe, args: ['-size', '120x80', 'xc:black', '-fill', 'white', '-draw', 'rectangle 40,20 80,60', 'out.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        await makeSubject(exe, dir, 'ref.png');
        await makeMask(exe, dir, { file: 'drawn.png' });
        const matte = (await readFile(path.join(dir, 'drawn.png'))).toString('base64');
        const sent = [];
        const client = { images: { async edit(request) { sent.push(request.files[0]); return [matte]; } } };
        const result = await applyGeneratedAlphaMask({
            client, config: { image: { paintBackground: false } },
            file: path.join(dir, 'out.png'), alphaSource: path.join(dir, 'ref.png'),
        });
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'mask');
        // The picture sent to the model is the reference, not the saved output.
        assert.equal(sent[0].filename, 'ref.png');
        assert.equal(Buffer.compare(sent[0].bytes, await readFile(path.join(dir, 'ref.png'))), 0);
        // And the matte is merged into the reference pixels, so the subject keeps its red color.
        assert.deepEqual(await pixel(exe, 'out.png', 60, 40, dir), [255, 0, 0, 255]);
        assert.equal(result.source, path.relative(process.cwd(), path.join(dir, 'ref.png')).split(path.sep).join('/'));
    } finally {
        await rmDir(dir);
    }
});

test('applyGeneratedAlphaMask alphaMode off and contour skip the model request', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-mode-'));
    try {
        let called = 0;
        const client = { images: { async edit() { called++; throw new Error('must not be called'); } } };
        await makeSubject(exe, dir, 'off.png');
        const off = await applyGeneratedAlphaMask({ client, config: { image: {} }, file: path.join(dir, 'off.png'), alphaMode: 'off' });
        assert.equal(off.changed, false);
        assert.equal(off.reason, 'off');

        await makeSubject(exe, dir, 'contour.png');
        const contour = await applyGeneratedAlphaMask({ client, config: { image: {} }, file: path.join(dir, 'contour.png'), alphaMode: 'contour' });
        assert.equal(called, 0);
        assert.equal(contour.changed, true);
        assert.equal(contour.reason, 'contour');
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'contour.png'), cwd: dir }), false);
        assert.equal((await pixel(exe, 'contour.png', 2, 2, dir))[3], 0);
    } finally {
        await rmDir(dir);
    }
});

test('the matte keeps an anti-aliased edge instead of a wide blur', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-feather-'));
    try {
        await makeSubject(exe, dir);
        // A hard black/white matte: the transition band is one step wide.
        await makeMask(exe, dir, { file: 'hard.png' });
        const hard = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'hard.png', cwd: dir, feather: 0 });
        assert.equal(hard.changed, true);
        assert.equal(hard.feathered, 0);
        /** Distinct alpha levels in a small patch on the subject rim. */
        const levels = async () => {
            const res = await runProgram({
                file: exe, cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096,
                args: ['subject.png', '-alpha', 'extract', '-colorspace', 'Gray', '-crop', '3x3+39+19', '+repage', '-format', '%k', 'info:'],
            });
            return Number(res.stdout.trim());
        };
        // A binary matte gives exactly two alpha values: transparent and opaque.
        assert.equal(await levels(), 2, 'an unsmoothed matte keeps a two-value step');

        // One pixel of anti-aliasing adds intermediate alpha values on the rim and nothing more.
        const anti = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'hard.png', cwd: dir, feather: 1 });
        assert.equal(anti.changed, true);
        assert.equal(anti.feathered, 1);
        const rim = await levels();
        assert.ok(rim > 2, `the rim must gain anti-aliased levels, got ${rim}`);
        // The interior and the far background stay fully opaque and fully transparent.
        assert.deepEqual(await pixel(exe, 'subject.png', 60, 40, dir), [255, 0, 0, 255]);
        assert.deepEqual(await pixel(exe, 'subject.png', 2, 2, dir), [0, 0, 0, 0]);
    } finally {
        await rmDir(dir);
    }
});

test('a coarse matte is resampled to the image frame without stair-stepping', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-resample-'));
    try {
        await makeSubject(exe, dir);
        await makeMask(exe, dir, { file: 'coarse.png', size: '30x20', box: '10,5 20,15' });
        const result = await magickApplyAlphaMask({ exe, input: 'subject.png', mask: 'coarse.png', cwd: dir, feather: 0 });
        assert.equal(result.changed, true);
        assert.equal(result.width, 120);
        // Lanczos resampling produces intermediate values on the scaled edge.
        const res = await runProgram({
            file: exe, cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096,
            args: ['subject.png', '-alpha', 'extract', '-colorspace', 'Gray', '-format', '%k', 'info:'],
        });
        assert.ok(Number(res.stdout.trim()) > 2, 'the upscaled matte keeps gray transition pixels');
        assert.deepEqual(await pixel(exe, 'subject.png', 60, 40, dir), [255, 0, 0, 255]);
        assert.deepEqual(await pixel(exe, 'subject.png', 2, 2, dir), [0, 0, 0, 0]);
    } finally {
        await rmDir(dir);
    }
});

test('a painted checkerboard is detected as a fake transparency plate', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-fake-'));
    try {
        await runProgram({
            file: exe, args: ['-size', '120x80', 'pattern:checkerboard', 'plate.png'],
            cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096,
        });
        const fake = await magickDetectFakeTransparency({ exe, input: 'plate.png', cwd: dir });
        assert.equal(fake.fake, true);
        assert.equal(fake.reason, 'checkerboard');

        await makeSubject(exe, dir, 'plain.png');
        assert.equal((await magickDetectFakeTransparency({ exe, input: 'plain.png', cwd: dir })).fake, false);

        await runProgram({ file: exe, args: ['-size', '120x80', 'xc:#336699', 'colored.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        assert.equal((await magickDetectFakeTransparency({ exe, input: 'colored.png', cwd: dir })).fake, false);
    } finally {
        await rmDir(dir);
    }
});

test('the contour matte keeps the subject and clears a flat corner background', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-contour-'));
    try {
        await makeSubject(exe, dir);
        const built = await magickContourAlphaMask({ exe, input: 'subject.png', output: 'matte.png', cwd: dir });
        assert.equal(built.changed, true);
        assert.equal(built.reason, 'contour');
        assert.equal(built.width, 120);
        // The center of the subject is white (keep), the corner is black (cut).
        assert.equal((await pixel(exe, 'matte.png', 60, 40, dir))[0], 255);
        assert.equal((await pixel(exe, 'matte.png', 2, 2, dir))[0], 0);
    } finally {
        await rmDir(dir);
    }
});

test('the saturation matte separates colored art from a neutral plate', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mask-saturation-'));
    try {
        await makeSubject(exe, dir);
        const built = await magickSaturationAlphaMask({ exe, input: 'subject.png', output: 'matte.png', cwd: dir });
        assert.equal(built.changed, true);
        assert.equal(built.reason, 'saturation');
        assert.equal((await pixel(exe, 'matte.png', 60, 40, dir))[0], 255);
        assert.equal((await pixel(exe, 'matte.png', 2, 2, dir))[0], 0);

        // A black-and-white picture has no saturation, so the matte covers nothing.
        await runProgram({ file: exe, args: ['-size', '120x80', 'xc:white', '-fill', 'black', '-draw', 'rectangle 40,20 80,60', 'bw.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        const empty = await magickSaturationAlphaMask({ exe, input: 'bw.png', output: 'bw-matte.png', cwd: dir });
        assert.equal(empty.changed, false);
        assert.equal(empty.reason, 'empty-mask');
    } finally {
        await rmDir(dir);
    }
});
