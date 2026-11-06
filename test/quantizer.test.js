import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import {
    dominantColorHex,
    dominantColors,
    dominantSubjectColorHex,
    dominantSubjectColors,
    backgroundColor,
    frameFromFile,
    kmeansPalette,
    samplePixels,
    toHex,
} from '../src/quantizer/kmeans.js';
import {
    decodeRgba,
    rasterAlphaShare,
    rasterAlphaSoftShare,
    rasterColorKeyAlpha,
    rasterEngine,
} from '../src/agent/image-raster.js';

/** Build a PNG buffer with node-canvas. */
async function png(width, height, draw) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    draw(ctx);
    return canvas.toBuffer('image/png');
}

/** Read one pixel as an `[r, g, b, a]` tuple. */
async function pixel(file, x, y) {
    const bytes = await readFile(file);
    const frame = await decodeRgba(bytes);
    const at = (y * frame.width + x) * 4;
    return [...frame.data.subarray(at, at + 4)];
}

/**
 * A 200x120 frame: a light background, a red disc (the subject), and a blue square inside the disc
 * painted in the same color as the background, to exercise the flood-fill boundary.
 */
function paintSubject(ctx) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, 200, 120);
    ctx.fillStyle = '#cc2233';
    ctx.beginPath();
    ctx.arc(100, 60, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(90, 50, 20, 20);
}

test('kmeansPalette separates two flat color regions deterministically', () => {
    const colors = [
        ...Array.from({ length: 60 }, () => ({ r: 240, g: 240, b: 240 })),
        ...Array.from({ length: 40 }, () => ({ r: 204, g: 34, b: 51 })),
    ];
    const first = kmeansPalette(colors, { k: 2, seed: 7 });
    const second = kmeansPalette(colors, { k: 2, seed: 7 });
    assert.deepEqual(first, second, 'the same seed must give the same palette');
    assert.equal(first.length, 2);
    assert.equal(first[0].r, 240, 'the majority cluster wins the first slot');
    assert.equal(first[0].share, 0.6);
    assert.equal(first[1].r, 204);
});

test('kmeansPalette never loses a slot to an empty cluster', () => {
    const colors = Array.from({ length: 30 }, () => ({ r: 10, g: 10, b: 10 }));
    const palette = kmeansPalette(colors, { k: 4, seed: 3 });
    assert.equal(palette.length, 4);
    assert.ok(palette.every((c) => Number.isFinite(c.r) && c.r >= 0 && c.r <= 255));
});

test('samplePixels skips transparent pixels and respects the sample cap', () => {
    const width = 64;
    const height = 64;
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = 10;
        data[i * 4 + 1] = 200;
        data[i * 4 + 2] = 30;
        data[i * 4 + 3] = i < width * height / 2 ? 255 : 0;
    }
    const opaque = samplePixels({ width, height, data }, { alphaThreshold: 128, maxSamples: 4096 });
    assert.ok(opaque.length > 0);
    assert.ok(opaque.every((c) => c.g === 200));
    const capped = samplePixels({ width, height, data }, { maxSamples: 200 });
    assert.ok(capped.length <= 216, 'the stride keeps the sample near the requested cap');
    assert.equal(samplePixels(null).length, 0);
});

test('dominantColors reports the subject color of a painted frame', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-quant-subject-'));
    try {
        const file = path.join(dir, 'subject.png');
        await writeFile(file, await png(200, 120, paintSubject));
        const frame = await frameFromFile(file);
        assert.equal(frame.width, 200);
        const colors = dominantColors(frame, { k: 3 });
        assert.ok(colors.length >= 2);
        assert.equal(colors[0].r, 240, 'the background covers most of the frame');
        const hex = dominantColorHex(frame, { k: 3 });
        assert.match(hex, /^#[0-9a-f]{6}$/);
        assert.equal(hex, toHex(colors[0]));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('dominantColorHex follows alpha: a transparent background exposes the subject', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-quant-alpha-'));
    try {
        const file = path.join(dir, 'cutout.png');
        await writeFile(file, await png(200, 120, (ctx) => {
            ctx.clearRect(0, 0, 200, 120);
            ctx.fillStyle = '#cc2233';
            ctx.beginPath();
            ctx.arc(100, 60, 40, 0, Math.PI * 2);
            ctx.fill();
        }));
        const frame = await frameFromFile(file);
        assert.equal(dominantColorHex(frame, { k: 2 }), '#cc2233');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('dominantColors of an empty frame reports nothing rather than white', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-quant-empty-'));
    try {
        const file = path.join(dir, 'empty.png');
        await writeFile(file, await png(40, 40, (ctx) => ctx.clearRect(0, 0, 40, 40)));
        const frame = await frameFromFile(file);
        assert.deepEqual(dominantColors(frame, { k: 2 }), []);
        assert.equal(dominantColorHex(frame, { k: 2 }), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('backgroundColor reads the plate off the frame border, not the largest cluster', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-quant-bg-'));
    try {
        // The subject covers more pixels than the plate: a plain dominant color vote would pick the
        // subject and the paint pass would flood the artwork instead of the background.
        const file = path.join(dir, 'big-subject.png');
        await writeFile(file, await png(200, 120, (ctx) => {
            ctx.fillStyle = '#202428';
            ctx.fillRect(0, 0, 200, 120);
            ctx.fillStyle = '#e8b020';
            ctx.fillRect(20, 16, 160, 88);
        }));
        const frame = await frameFromFile(file);
        assert.deepEqual(backgroundColor(frame), { r: 32, g: 36, b: 40 });
        assert.equal(dominantColorHex(frame, { k: 2 }), '#e8b020', 'the bare dominant color is the subject');
        assert.equal(dominantSubjectColorHex(frame, { k: 2 }), '#e8b020');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('dominantSubjectColors keeps an artwork that touches the border', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-quant-touch-'));
    try {
        // A wide red band crossing the whole frame: the plate is the light strip top and bottom.
        const file = path.join(dir, 'band.png');
        await writeFile(file, await png(200, 120, (ctx) => {
            ctx.fillStyle = '#f4f4f4';
            ctx.fillRect(0, 0, 200, 120);
            ctx.fillStyle = '#b02020';
            ctx.fillRect(0, 30, 200, 60);
        }));
        const frame = await frameFromFile(file);
        assert.deepEqual(backgroundColor(frame), { r: 244, g: 244, b: 244 });
        const [subject] = dominantSubjectColors(frame, { k: 2 });
        assert.ok(subject.r > 150 && subject.g < 80, `the red band must win, got ${JSON.stringify(subject)}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('dominantSubjectColors falls back to the whole frame when art and plate share a color', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-quant-same-'));
    try {
        const file = path.join(dir, 'monochrome.png');
        await writeFile(file, await png(60, 60, (ctx) => {
            ctx.fillStyle = '#3060a0';
            ctx.fillRect(0, 0, 60, 60);
            ctx.fillStyle = '#3060a0';
            ctx.fillRect(10, 10, 40, 40);
        }));
        const frame = await frameFromFile(file);
        const colors = dominantSubjectColors(frame, { k: 2 });
        assert.ok(colors.length > 0);
        assert.equal(toHex(colors[0]), '#3060a0');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rasterColorKeyAlpha clears a flat key color and keeps the subject', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-key-cut-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await png(200, 120, paintSubject));
        const out = path.join(dir, 'cut.png');
        const result = await rasterColorKeyAlpha({ input: file, output: out, key: '#f0f0f0', cwd: dir });
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'color-key');
        assert.equal(result.width, 200);
        assert.ok(result.cleared > 0.4, `the background should clear, got ${result.cleared}`);

        assert.deepEqual(await pixel(out, 2, 2), [240, 240, 240, 0], 'the corner becomes transparent');
        assert.equal((await pixel(out, 100, 85))[3], 255, 'the disc stays opaque');
        assert.equal((await pixel(out, 100, 60))[3], 255, 'an interior patch of the key color survives');
        // Only the canvas' own anti-aliased rim may sit in the soft band; a keyed matte cannot add
        // a glow of its own the way a separately drawn matte does.
        const soft = await rasterAlphaSoftShare({ input: out, cwd: dir });
        assert.ok(soft !== null && soft < 0.02, `the soft band must stay at the drawn rim, got ${soft}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rasterColorKeyAlpha refuses a key the frame does not carry', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-key-miss-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await png(200, 120, paintSubject));
        const out = path.join(dir, 'cut.png');
        const result = await rasterColorKeyAlpha({ input: file, output: out, key: '#102030', cwd: dir });
        assert.equal(result.changed, false);
        assert.equal(result.reason, 'key-miss');
        const stat = await readFile(out).then(() => true, () => false);
        assert.equal(stat, false, 'a miss must not write the output');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rasterColorKeyAlpha rejects an unparsable key and an unreadable file', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-key-bad-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await png(40, 40, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 40, 40); }));
        assert.deepEqual(
            await rasterColorKeyAlpha({ input: file, output: 'x.png', key: 'not-a-color', cwd: dir }),
            { changed: false, reason: 'bad-key' },
        );
        const missing = await rasterColorKeyAlpha({ input: 'nope.png', output: 'x.png', key: '#ffffff', cwd: dir });
        assert.equal(missing.changed, false);
        assert.equal(missing.reason, 'unreadable');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rasterColorKeyAlpha feather widens the edge without eating the subject', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-key-feather-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await png(200, 120, paintSubject));
        const plain = path.join(dir, 'plain.png');
        const soft = path.join(dir, 'soft.png');
        await rasterColorKeyAlpha({ input: file, output: plain, key: '#f0f0f0', cwd: dir });
        const result = await rasterColorKeyAlpha({ input: file, output: soft, key: '#f0f0f0', cwd: dir, feather: 2 });
        assert.equal(result.feathered, 2);
        const clearedPlain = await rasterAlphaShare({ input: plain, cwd: dir });
        const clearedSoft = await rasterAlphaShare({ input: soft, cwd: dir });
        assert.ok(clearedSoft <= clearedPlain + 0.02, 'feathering must not clear more of the frame');
        assert.equal((await pixel(soft, 100, 60))[3], 255, 'the interior patch of the key color survives a feather');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the keyed alpha edge matches the RGB edge because both come from the same pixels', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-key-align-'));
    try {
        // A disc with a hard edge: walk one scanline and compare where RGB stops being the key color
        // with where alpha stops being zero. A separately drawn matte drifts; a keyed alpha cannot.
        const file = path.join(dir, 'art.png');
        await writeFile(file, await png(200, 120, (ctx) => {
            ctx.fillStyle = '#eeeeee';
            ctx.fillRect(0, 0, 200, 120);
            ctx.fillStyle = '#2040c0';
            ctx.beginPath();
            ctx.arc(100, 60, 35, 0, Math.PI * 2);
            ctx.fill();
        }));
        const out = path.join(dir, 'cut.png');
        await rasterColorKeyAlpha({ input: file, output: out, key: '#eeeeee', cwd: dir });
        const frame = await decodeRgba(await readFile(out));
        const row = 60;
        let rgbEdge = null;
        let alphaEdge = null;
        for (let x = 0; x < frame.width; x++) {
            const at = (row * frame.width + x) * 4;
            const isKey = frame.data[at] > 230 && frame.data[at + 1] > 230 && frame.data[at + 2] > 230;
            if (!isKey && rgbEdge === null) rgbEdge = x;
            if (frame.data[at + 3] > 127 && alphaEdge === null) alphaEdge = x;
        }
        assert.ok(rgbEdge !== null && alphaEdge !== null);
        assert.ok(Math.abs(rgbEdge - alphaEdge) <= 2, `A and RGB edges must coincide: rgb ${rgbEdge}, alpha ${alphaEdge}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
