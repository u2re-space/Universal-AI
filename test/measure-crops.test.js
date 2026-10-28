import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { runProgram } from '../src/agent/shell.js';
import { detectMagick, ensureTransparentBackground, magickIsOpaque, assessVectorSuitability, magickColorCount, magickPaletteStats } from '../src/agent/image-magick.js';
import { stageMeasurementCrops, measurementConclusion } from '../src/agent/measure-crops.js';
import { renderMeasurements } from '../src/agent/team-text.js';
import { MEASURER_SCHEMA } from '../src/agent/schemas.js';
import { TINY_PNG } from './helpers/mock-server.js';

/** Create a flat PNG with a red square on white using ImageMagick. */
async function makeFlatImage({ exe, dir, file = 'mockup.png', width = 200, height = 100 }) {
    await runProgram({
        file: exe,
        args: ['-size', `${width}x${height}`, 'xc:white', '-fill', 'red', '-draw', 'rectangle 10,10 60,60', file],
        cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096,
    });
}

test('measurement crops are cut once and rendered as ready generate_image references', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-crops-'));
    try {
        await makeFlatImage({ exe, dir });
        const sheet = {
            summary: 'Two blocks on a flat background',
            source: 'mockup.png',
            unit: 'px',
            units: {
                source: 'px', rootFontSize: 16, scale: null, preferred: ['rem', '%'],
                notes: '1rem = 16 source pixels; conversions are inferred from the canvas.',
            },
            confidence: 'medium',
            assumptions: ['The mockup is shown at 1x; the 16px root size is assumed.'],
            canvas: { x: 0, y: 0, width: 200, height: 100 },
            elements: [
                {
                    name: 'Hero image', kind: 'image', box: { x: 10, y: 10, width: 50, height: 50 },
                    rotation: 0, borders: '', radius: null,
                    padding: { top: null, right: null, bottom: null, left: null },
                    margin: { top: null, right: null, bottom: null, left: null }, gap: null,
                    spacing: '', placement: 'left', css: 'width: 3.125rem; height: 3.125rem;',
                    typography: null, confidence: 'high', notes: '', use: 'artwork reference', crop: null,
                },
                {
                    name: 'Badge', kind: 'icon', box: { x: 120, y: 30, width: 20, height: 20 },
                    rotation: 0, borders: '', radius: 4,
                    padding: { top: null, right: null, bottom: null, left: null },
                    margin: { top: null, right: null, bottom: null, left: null }, gap: null,
                    spacing: '', placement: 'inside the right block', css: 'width: 1.25rem; height: 1.25rem; border-radius: 0.25rem;',
                    typography: null, confidence: 'low', notes: 'Shape is inferred from a small crop.', use: 'icon source', crop: null,
                },
            ],
            regions: [
                {
                    name: 'Hero image', kind: 'image', box: { x: 10, y: 10, width: 50, height: 50 },
                    how: 'left square', use: 'artwork reference', crop: null,
                },
                {
                    name: 'CTA', kind: 'card', box: { x: 100, y: 20, width: 80, height: 60 },
                    how: 'right block', use: 'card reference', crop: null,
                },
                { name: 'Unmeasured', kind: 'other', box: { x: null, y: null, width: null, height: null }, how: 'unknown', use: '', crop: null },
            ],
            rules: [{ name: 'space', value: 8, unit: 'px', css: '--space-1: 0.5rem', from: 'gaps' }],
            notes: '',
        };
        // A model-provided path to the full reference is not a crop and must be replaced.
        sheet.elements[0].crop = 'mockup.png';
        const first = await stageMeasurementCrops({ root: dir, workId: 'work-1', sheet, referencePaths: ['mockup.png'] });
        assert.equal(first.warnings.length, 0);
        assert.equal(first.crops.length, 3, 'the shared hero box is cut once');
        assert.equal(sheet.regions[0].crop, '.tmp/work-1/crops/01-region-hero-image.png');
        assert.equal(sheet.regions[1].crop, '.tmp/work-1/crops/02-region-cta.png');
        assert.equal(sheet.regions[2].crop, null);
        assert.equal(sheet.elements[0].crop, sheet.regions[0].crop, 'an element with the same box reuses the region crop');
        assert.equal(sheet.elements[1].crop, '.tmp/work-1/crops/03-element-badge.png');
        assert.ok((await stat(path.join(dir, sheet.regions[0].crop))).size > 0);
        assert.ok((await stat(path.join(dir, sheet.regions[1].crop))).size > 0);
        assert.ok((await stat(path.join(dir, sheet.elements[1].crop))).size > 0);

        const second = await stageMeasurementCrops({ root: dir, workId: 'work-1', sheet, referencePaths: ['mockup.png'] });
        assert.equal(second.crops.length, 3);
        assert.equal(second.warnings.length, 0);

        const text = renderMeasurements(sheet);
        assert.match(text, /3 ready crop file\(s\); 2 element\(s\) and 2 region\(s\) reference them/);
        assert.match(text, /crop: \.tmp\/work-1\/crops\/01-region-hero-image\.png/);
        assert.match(text, /width: 3\.125rem/);
        assert.match(text, /low confidence/);
        assert.match(text, /The mockup is shown at 1x/);

        const conclusion = measurementConclusion(sheet, first.crops);
        assert.deepEqual(conclusion.counts, { elements: 2, textElements: 0, regions: 3, rules: 1, crops: 3, lowConfidence: 1 });
        assert.equal(conclusion.units.rootFontSize, 16);
        assert.equal(Object.hasOwn(conclusion, 'files'), false);
        assert.match(text, /PNG with a real alpha channel/);
        assert.match(text, /convert it locally and keep the PNG/);
        assert.match(text, /vectorize_image \/ Recraft/);
        assert.match(text, /Lucide or Phosphor icons available to the project/);
        assert.match(text, /do not call generate_image, edit_image, or image_generation/);
        assert.match(text, /common aspect-ratio frame/);
        assert.match(text, /never stretch an image/);
        assert.match(text, /convert it locally and keep the PNG/);
        assert.match(text, /After the page is built, compare the options/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the measurer schema can record units, confidence, and a crop path', () => {
    assert.ok(MEASURER_SCHEMA.properties.regions.items.properties.crop);
    assert.ok(MEASURER_SCHEMA.properties.units);
    assert.deepEqual(MEASURER_SCHEMA.properties.confidence.enum, ['high', 'medium', 'low', 'unknown']);
    assert.deepEqual(MEASURER_SCHEMA.properties.assumptions.type, 'array');
    const element = MEASURER_SCHEMA.properties.elements.items.properties;
    assert.ok(element.crop);
    assert.ok(element.css);
    assert.ok(element.use);
    assert.ok(element.kind);
    assert.deepEqual(element.confidence.enum, ['high', 'medium', 'low', 'unknown']);
    assert.deepEqual(element.typography.type, ['object', 'null']);
    assert.deepEqual(element.typography.properties.familyConfidence.enum, ['high', 'medium', 'low', 'unknown']);
    assert.deepEqual(element.typography.properties.fontSize.type, ['number', 'null']);
    assert.deepEqual(element.padding.properties.top.type, ['number', 'null']);
    assert.deepEqual(element.margin.properties.left.type, ['number', 'null']);
    assert.deepEqual(element.gap.type, ['number', 'null']);
    assert.deepEqual(MEASURER_SCHEMA.properties.rules.items.properties.value.type, ['number', 'null']);
});

test('local alpha fallback removes a flat background and keeps the subject', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-alpha-'));
    try {
        const file = path.join(dir, 'flat.png');
        await makeFlatImage({ exe, dir, file: 'flat.png', width: 64, height: 64 });
        assert.equal(await magickIsOpaque({ exe, input: file, cwd: dir }), true);
        const result = await ensureTransparentBackground({ file });
        assert.equal(result.changed, true);
        assert.equal(await magickIsOpaque({ exe, input: file, cwd: dir }), false);
        const corner = await runProgram({ file: exe, args: [file, '-format', '%[pixel:p{0,0}]', 'info:'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        assert.match(corner.stdout.trim(), /,0\)$/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('local alpha fallback works on a path relative to the process cwd', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-alpha-relative-'));
    try {
        await makeFlatImage({ exe, dir, file: 'relative.png', width: 64, height: 64 });
        const relative = path.relative(process.cwd(), path.join(dir, 'relative.png'));
        if (path.isAbsolute(relative)) return t.skip('temp directory is on another drive');
        const result = await ensureTransparentBackground({ file: relative });
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'removed');
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'relative.png'), cwd: dir }), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('vector suitability accepts flat artwork and refuses a photographic palette', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-vector-fit-'));
    try {
        await makeFlatImage({ exe, dir, file: 'flat.png', width: 64, height: 64 });
        const flat = await assessVectorSuitability({ exe, input: 'flat.png', cwd: dir });
        assert.equal(flat.suitable, true);
        assert.ok(['flat', 'limited-palette'].includes(flat.reason));
        assert.ok(flat.colors <= 4);
        assert.equal(flat.width, 64);
        assert.equal(flat.ratio, 1);

        // A plasma frame has thousands of colors spread evenly over the palette.
        await runProgram({ file: exe, args: ['-size', '64x64', 'plasma:fractal', 'photo.png'], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        const colors = await magickColorCount({ exe, input: 'photo.png', cwd: dir });
        assert.ok(colors > 256, `expected a rich palette, got ${colors}`);
        const palette = await magickPaletteStats({ exe, input: 'photo.png', cwd: dir });
        assert.ok(palette && palette.top2 < 0.8, `top2=${palette?.top2}`);
        const photo = await assessVectorSuitability({ exe, input: 'photo.png', cwd: dir });
        assert.equal(photo.suitable, false);
        assert.equal(photo.reason, 'too-many-colors');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('local alpha fallback leaves an already transparent PNG and reports JPEG', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-alpha-skip-'));
    try {
        const png = path.join(dir, 'tiny.png');
        await writeFile(png, Buffer.from(TINY_PNG, 'base64'));
        const already = await ensureTransparentBackground({ file: png });
        assert.equal(already.changed, false);
        assert.equal(already.reason, 'already');

        const jpg = path.join(dir, 'photo.jpg');
        await runProgram({ file: exe, args: ['-size', '8x8', 'xc:white', jpg], cwd: dir, timeoutMs: 10000, maxOutputBytes: 4096 });
        const jpeg = await ensureTransparentBackground({ file: jpg });
        assert.equal(jpeg.changed, false);
        assert.equal(jpeg.reason, 'format');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
