import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { generateSvg } from '../src/agent/assets.js';
import { detectMagick } from '../src/agent/image-magick.js';
import { enabledToolNames } from '../src/agent/tool-specs.js';

let root;
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

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
    assert.ok(images.includes('generate_svg'));
    assert.equal(images.includes('download_font'), false);

    const fetch = enabledToolNames({ fetch: true }, { images: false });
    assert.ok(fetch.includes('fetch_url'));
    assert.ok(fetch.includes('download_font'));
    assert.ok(fetch.includes('download_icons'));
    assert.equal(fetch.includes('split_image'), false);
});

test('detectMagick answers with an executable path or null and never throws', async () => {
    const found = await detectMagick();
    assert.ok(found === null || typeof found === 'string');
});
