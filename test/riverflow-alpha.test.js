import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask } from '../src/agent/image-alpha.js';
import { decodeRgba, rasterEngine } from '../src/agent/image-raster.js';

const RIVERFLOW_MODEL = 'sourceful/riverflow-v2.6-pro';
const GPT_MODEL = 'openai/gpt-image-2.6-sunburst';

async function png(width, height, draw) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    draw(ctx);
    return canvas.toBuffer('image/png');
}

/** A yellow plate of art on a dark ground: the artwork covers most of the frame. */
function subjectBytes() {
    return png(120, 80, (ctx) => {
        ctx.fillStyle = '#202428';
        ctx.fillRect(0, 0, 120, 80);
        ctx.fillStyle = '#e8b020';
        ctx.fillRect(24, 16, 72, 48);
    });
}

/** A white rectangle on black — the matte the fake model answers with. */
function maskBytes() {
    return png(120, 80, (ctx) => {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 120, 80);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(24, 16, 72, 48);
    });
}

/**
 * A model that paints the background flat yellow and then draws the matte.
 * @param {{ paint?: boolean }} [options] — `paint: false` makes the paint pass fail
 */
function fakeClient({ paint = true } = {}) {
    const calls = [];
    const painted = png(120, 80, (ctx) => {
        ctx.fillStyle = '#e8b020';
        ctx.fillRect(0, 0, 120, 80);
        ctx.fillStyle = '#e8b020';
        ctx.fillRect(24, 16, 72, 48);
    });
    return {
        calls,
        images: {
            async edit(request) {
                calls.push(request);
                if (request.prompt === ALPHA_MASK_PROMPT) return [(await maskBytes()).toString('base64')];
                if (!paint) throw new Error('paint pass unavailable');
                return [(await painted).toString('base64')];
            },
        },
    };
}

async function pixel(file, x, y) {
    const frame = await decodeRgba(await readFile(file));
    const at = (y * frame.width + x) * 4;
    return [...frame.data.subarray(at, at + 4)];
}

test('riverflow names the background color in the paint prompt instead of leaving it to the model', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-prompt-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient();
        const config = { baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL, image: { maskModel: 'tech/model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: RIVERFLOW_MODEL });

        assert.equal(result.changed, true);
        assert.equal(result.painted, true);
        assert.equal(result.reason, 'mask');
        assert.equal(client.calls.length, 2);
        const prompt = client.calls[0].prompt;
        assert.notEqual(prompt, BACKGROUND_PAINT_PROMPT, 'the generic "dominant color of the subject" prompt must not be used');
        assert.match(prompt, /solid color #[0-9a-f]{6}/, 'the paint prompt must carry an explicit hex');
        // The plate is the dark border, the artwork is yellow: the picked color must be the artwork.
        const picked = /solid color #([0-9a-f]{6})/i.exec(prompt)[1].toLowerCase();
        assert.ok(picked.startsWith('e'), `the subject color must win over the plate, picked #${picked}`);
        // The matte is still drawn from the clean source.
        assert.equal(client.calls[1].prompt, ALPHA_MASK_PROMPT);
        assert.deepEqual(client.calls[1].files[0].bytes, await subjectBytes());
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the riverflow cut-out keeps the matte geometry on the painted plate', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-cut-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient();
        const config = { baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL, image: { maskModel: 'tech/model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: RIVERFLOW_MODEL });
        assert.equal(result.changed, true);
        assert.equal((await pixel(file, 60, 40))[3], 255, 'the subject stays opaque');
        assert.equal((await pixel(file, 2, 2))[3], 0, 'the plate becomes transparent');
        // The rim of a painted plate carries the subject color, so no white halo survives.
        const rim = await pixel(file, 23, 40);
        assert.ok(rim[0] > 150, `the rim must keep the plate color, got ${rim.join(',')}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('gpt-image keeps the shared paint prompt: the color pick stays with the model', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-gpt-prompt-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient();
        const config = { baseURL: 'https://api.example/v1/', imageModel: GPT_MODEL, image: { maskModel: 'tech/model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: GPT_MODEL });
        assert.equal(result.changed, true);
        assert.equal(client.calls[0].prompt, BACKGROUND_PAINT_PROMPT, 'the family default prompt must stay untouched');
        // Preset frames only: gpt-image cannot take the literal 120x80 source frame.
        assert.match(client.calls[0].size, /^(1024x1536|1536x1024|1024x1024|768x1024|1024x768)$/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('riverflow falls back to the local matte when the paint pass fails', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-fallback-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient({ paint: false });
        const config = { baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL, image: { maskModel: 'tech/model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: RIVERFLOW_MODEL });
        assert.equal(result.painted, false);
        assert.equal(result.changed, true);
        // No paint pass means no matte request either: the local contour matte cuts the plate.
        assert.ok(['contour', 'saturation', 'flat', 'mask'].includes(result.reason), `unexpected reason ${result.reason}`);
        assert.equal((await pixel(file, 60, 40))[3], 255, 'the subject survives the fallback');
        assert.equal((await pixel(file, 2, 2))[3], 0, 'the corner plate is cleared');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
