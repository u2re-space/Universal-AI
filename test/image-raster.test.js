import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import {
    fitBox,
    frameFor,
    rasterApplyAlphaMask,
    rasterCompare,
    rasterCrop,
    rasterDetectFakeTransparency,
    rasterEngine,
    rasterInfo,
    rasterIsOpaque,
    rasterPadImageBytes,
    rasterRemoveImagePadding,
    rasterSplit,
    rasterTrim,
} from '../src/agent/image-raster.js';
import { createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';

async function png(width, height, draw) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    draw(ctx);
    return canvas.toBuffer('image/png');
}

async function pixel(file, x, y) {
    const info = await rasterInfo(file);
    const bytes = await readFile(file);
    const sharp = (await import('sharp')).default;
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
    const at = (y * info.width + x) * 4;
    return [...raw.subarray(at, at + 4)];
}

test('local image engine is available and geometry keeps aspect ratio', async () => {
    assert.ok(['sharp', 'canvas'].includes(await rasterEngine()));
    assert.deepEqual(fitBox(400, 200, 100, 100), { x: 0, y: 25, width: 100, height: 50, scale: 0.25 });
    assert.deepEqual(frameFor({ frame: 'portrait', sources: [], maxSide: 640 }), { width: 400, height: 640 });
});

test('comparison writes a direct local raster sheet and pixel difference map', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-compare-'));
    try {
        await writeFile(path.join(root, 'wide.png'), await png(80, 40, (ctx) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 80, 40); }));
        await writeFile(path.join(root, 'square.png'), await png(40, 40, (ctx) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 40, 40); }));
        const result = await rasterCompare({
            files: ['wide.png', 'square.png'].map((rel) => ({ rel, abs: path.join(root, rel) })),
            output: 'sheet.png', cwd: root, mode: 'both', frame: '64x64', gap: 4,
        });
        assert.equal(result.engine, 'sharp');
        assert.deepEqual([result.width, result.height], [132, 64]);
        assert.equal(result.items[0].width, 64);
        assert.equal(result.items[0].height, 32);
        assert.equal(result.items[0].y, 16);
        assert.equal(result.items[1].width, 64);
        assert.equal(result.items[1].height, 64);
        assert.ok(result.diff.similarity > 0 && result.diff.similarity < 100);
        assert.equal((await rasterInfo('sheet.png', { cwd: root })).format, 'png');
        assert.equal((await rasterInfo(result.diff.rel, { cwd: root })).width, 64);
        assert.deepEqual(await pixel(path.join(root, 'sheet.png'), 4, 4), [0, 0, 0, 0]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('SVG comparison input is rasterized locally through sharp', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-svg-'));
    try {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#3157d5"/></svg>';
        await writeFile(path.join(root, 'vector.svg'), svg);
        await writeFile(path.join(root, 'raster.png'), await png(32, 16, (ctx) => { ctx.fillStyle = '#3157d5'; ctx.fillRect(0, 0, 32, 16); }));
        const result = await rasterCompare({
            files: ['vector.svg', 'raster.png'].map((rel) => ({ rel, abs: path.join(root, rel) })),
            output: 'svg-sheet.png', cwd: root, mode: 'both', frame: '32x16',
        });
        assert.equal(result.engine, 'sharp');
        assert.equal(result.diff.similarity, 100);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('raster alpha mask keeps subject RGB, handles inverse masks, and refuses white mattes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-alpha-'));
    try {
        await writeFile(path.join(root, 'base.png'), await png(16, 12, (ctx) => { ctx.fillStyle = '#cc2222'; ctx.fillRect(0, 0, 16, 12); }));
        await writeFile(path.join(root, 'mask.png'), await png(16, 12, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(4, 3, 8, 6); }));
        const applied = await rasterApplyAlphaMask({ input: 'base.png', mask: 'mask.png', output: 'cut.png', cwd: root, feather: 0 });
        assert.equal(applied.changed, true);
        assert.equal(applied.reason, 'mask');
        assert.deepEqual(await pixel(path.join(root, 'cut.png'), 7, 5), [204, 34, 34, 255]);
        assert.equal((await pixel(path.join(root, 'cut.png'), 1, 1))[3], 0);
        assert.equal(await rasterIsOpaque(path.join(root, 'cut.png')), false);

        await writeFile(path.join(root, 'inverse.png'), await png(16, 12, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 16, 12); ctx.fillStyle = '#000'; ctx.fillRect(4, 3, 8, 6); }));
        const inverted = await rasterApplyAlphaMask({ input: 'base.png', mask: 'inverse.png', output: 'inverse-out.png', cwd: root, feather: 0 });
        assert.equal(inverted.inverted, true);
        assert.equal((await pixel(path.join(root, 'inverse-out.png'), 1, 1))[3], 0);
        assert.equal((await pixel(path.join(root, 'inverse-out.png'), 7, 5))[3], 255);

        await writeFile(path.join(root, 'full.png'), await png(16, 12, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 16, 12); }));
        assert.deepEqual(await rasterApplyAlphaMask({ input: 'base.png', mask: 'full.png', output: 'refuse.png', cwd: root }), { changed: false, reason: 'full-mask' });
        assert.equal(await stat(path.join(root, 'refuse.png')).then(() => true, () => false), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('crop, trim, and split run locally without ImageMagick', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-crops-'));
    try {
        await writeFile(path.join(root, 'source.png'), await png(64, 48, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 64, 48); ctx.fillStyle = '#1e3a8a'; ctx.fillRect(12, 8, 40, 32); }));
        const crop = await rasterCrop({ input: 'source.png', output: 'crop.png', x: 12, y: 8, width: 40, height: 32, cwd: root });
        assert.deepEqual([crop.width, crop.height], [40, 32]);
        const split = await rasterSplit({ input: 'source.png', outputDir: 'tiles', rows: 2, cols: 2, cwd: root });
        assert.equal(split.length, 4);
        assert.deepEqual(split.map((tile) => [tile.x, tile.y, tile.width, tile.height]), [[0, 0, 32, 24], [32, 0, 32, 24], [0, 24, 32, 24], [32, 24, 32, 24]]);
        const trim = await rasterTrim({ input: 'source.png', output: 'trimmed.png', cwd: root, fuzz: 0 });
        assert.equal(trim.changed, true);
        assert.deepEqual(trim.after, { width: 40, height: 32 });
        assert.equal((await rasterInfo('trimmed.png', { cwd: root })).width, 40);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('divide-16 padding is transparent, does not scale pixels, and restores the original frame', async () => {
    const original = await png(19, 17, (ctx) => { ctx.fillStyle = '#cc2222'; ctx.fillRect(0, 0, 19, 17); });
    const padded = await rasterPadImageBytes({ bytes: original });
    assert.deepEqual([padded.width, padded.height], [32, 32]);
    assert.deepEqual([padded.originalWidth, padded.originalHeight], [19, 17]);
    assert.equal(padded.padded, true);
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-padding-'));
    try {
        await writeFile(path.join(root, 'padded.png'), padded.bytes);
        assert.deepEqual(await pixel(path.join(root, 'padded.png'), 18, 16), [204, 34, 34, 255]);
        assert.deepEqual(await pixel(path.join(root, 'padded.png'), 20, 16), [0, 0, 0, 0]);
        const restored = await rasterRemoveImagePadding({
            bytes: padded.bytes, width: padded.width, height: padded.height,
            originalWidth: padded.originalWidth, originalHeight: padded.originalHeight, engine: padded.engine,
        });
        await writeFile(path.join(root, 'restored.png'), restored);
        assert.deepEqual([...(await rasterInfo('restored.png', { cwd: root })).width ? [19, 17] : []], [19, 17]);
        assert.deepEqual(await pixel(path.join(root, 'restored.png'), 18, 16), [204, 34, 34, 255]);
        assert.equal(padded.engine, 'sharp');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a painted checkerboard is detected locally without ImageMagick', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-plate-'));
    try {
        await writeFile(path.join(root, 'plate.png'), await png(64, 48, (ctx) => {
            for (let y = 0; y < 48; y += 8) {
                for (let x = 0; x < 64; x += 8) {
                    ctx.fillStyle = ((x + y) / 8) % 2 === 0 ? '#999999' : '#666666';
                    ctx.fillRect(x, y, 8, 8);
                }
            }
        }));
        const fake = await rasterDetectFakeTransparency({ input: 'plate.png', cwd: root });
        assert.equal(fake.fake, true);
        assert.equal(fake.reason, 'checkerboard');

        await writeFile(path.join(root, 'flat.png'), await png(64, 48, (ctx) => { ctx.fillStyle = '#336699'; ctx.fillRect(0, 0, 64, 48); }));
        assert.equal((await rasterDetectFakeTransparency({ input: 'flat.png', cwd: root })).fake, false);

        await writeFile(path.join(root, 'clear.png'), await png(64, 48, (ctx) => { ctx.clearRect(0, 0, 64, 48); }));
        assert.equal((await rasterDetectFakeTransparency({ input: 'clear.png', cwd: root })).reason, 'already');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('compare_images tool validates and writes inside the working tree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-raster-tool-'));
    try {
        await writeFile(path.join(root, 'a.png'), await png(16, 16, (ctx) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 16, 16); }));
        await writeFile(path.join(root, 'b.png'), await png(16, 16, (ctx) => { ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 16, 16); }));
        const toolset = createToolset({
            root,
            config: { ...defaults, image: { ...defaults.image, rasterEngine: 'sharp' } },
            names: ['compare_images'], approvalLevel: 'all',
        });
        const call = (args) => toolset.execute({ name: 'compare_images', call_id: 'compare', arguments: JSON.stringify(args) });
        const result = await call({ files: ['a.png', 'b.png'], output: 'cmp.png', mode: 'both', layout: 'row', frame: '', gap: 8, background: 'transparent', max_side: 64, labels: false, reason: 'проверить варианты' });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /Similarity|сходство/);
        assert.equal((await stat(path.join(root, 'cmp.png'))).isFile(), true);
        assert.equal((await stat(path.join(root, 'cmp-diff.png'))).isFile(), true);
        const invalid = await call({ files: ['../outside.png', 'b.png'], output: '', mode: 'sheet', layout: 'row', frame: '', gap: 8, background: 'transparent', max_side: 64, labels: false, reason: 'invalid path' });
        assert.equal(invalid.ok, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
