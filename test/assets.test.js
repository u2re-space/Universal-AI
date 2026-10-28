import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { generateSvg } from '../src/agent/assets.js';
import { enabledToolNames, TOOL_SPECS } from '../src/agent/tool-specs.js';
import { createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';
import { rasterInfo } from '../src/agent/image-raster.js';

let root;
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const createPng = async (width, height, draw) => {
    const canvas = createCanvas(width, height);
    draw(canvas.getContext('2d'));
    return canvas.toBuffer('image/png');
};

test('generate_svg writes a complete SVG document', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-svg-'));
    const raw = await generateSvg({
        prompt: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
        output: 'assets/dot.svg', cwd: root,
    });
    assert.equal(raw.rel, 'assets/dot.svg');
    const svg = await readFile(path.join(root, raw.rel), 'utf8');
    assert.match(svg, /<circle/);
    assert.match(svg, /<\/svg>/);
    assert.ok((await stat(path.join(root, raw.rel))).size > 0);

    const text = await generateSvg({ prompt: 'Hello <world> & "friends"', width: 320, height: 200, output: 'label', cwd: root });
    assert.equal(text.rel, 'label.svg');
    const label = await readFile(path.join(root, text.rel), 'utf8');
    assert.match(label, /viewBox="0 0 320 200"/);
    assert.match(label, /Hello &lt;world&gt; &amp; &quot;friends&quot;/);
});

test('image tools are enabled with images and asset downloads with fetch', () => {
    const images = enabledToolNames({ images: true }, { images: true });
    assert.ok(images.includes('split_image'));
    assert.ok(images.includes('crop_image'));
    assert.ok(images.includes('compare_images'));
    assert.ok(images.includes('generate_svg'));
    assert.equal(images.includes('download_font'), false);

    const fetch = enabledToolNames({ fetch: true }, { images: false });
    assert.ok(fetch.includes('fetch_url'));
    assert.ok(fetch.includes('download_font'));
    assert.ok(fetch.includes('download_icons'));
    assert.equal(fetch.includes('split_image'), false);
});

import { detectMagick } from '../src/agent/image-magick.js';

test('detectMagick answers with an executable path or null and never throws', async () => {
    const found = await detectMagick();
    assert.ok(found === null || typeof found === 'string');
});

test('crop_image is the one tool for both a box and a padding trim', async () => {
    assert.ok(TOOL_SPECS.crop_image.parameters.properties.trim);
    assert.match(TOOL_SPECS.crop_image.description, /trim=true/);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-crop-trim-'));
    try {
        await writeFile(path.join(dir, 'subject.png'), await createPng(200, 200, (ctx) => {
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 200);
            ctx.fillStyle = 'red'; ctx.fillRect(60, 60, 41, 41);
        }));
        const toolset = createToolset({ root: dir, config: defaults, names: ['crop_image'], approvalLevel: 'all' });
        const call = (args) => toolset.execute({ name: 'crop_image', call_id: 'c1', arguments: JSON.stringify(args) });

        const trimmed = await call({ path: 'subject.png', x: null, y: null, width: null, height: null, trim: true, output: 'assets/subject.png', reason: 'снять белый фон' });
        assert.equal(trimmed.ok, true, trimmed.output);
        assert.match(trimmed.output, /Снят padding/);
        assert.equal(trimmed.summary, 'assets/subject.png');
        const cut = await rasterInfo(path.join(dir, 'assets/subject.png'), { cwd: dir });
        assert.equal(cut.width, 41);
        assert.equal(cut.height, 41);

        const box = await call({ path: 'subject.png', x: 10, y: 10, width: 50, height: 40, trim: false, output: 'assets/box.png', reason: 'кроп детали' });
        assert.equal(box.ok, true, box.output);
        const cropped = await rasterInfo(path.join(dir, 'assets/box.png'), { cwd: dir });
        assert.equal(cropped.width, 50);
        assert.equal(cropped.height, 40);

        const plain = await call({ path: 'subject.png', x: null, y: null, width: null, height: null, trim: false, output: '', reason: 'без размеров' });
        assert.equal(plain.ok, false);
        assert.match(plain.output, /trim=true/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
