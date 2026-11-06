import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask } from '../src/agent/image-alpha.js';
import { createToolset } from '../src/agent/tools.js';
import { decodeRgba, rasterEngine } from '../src/agent/image-raster.js';
import { loadConfig } from '../src/core/config.js';

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

/**
 * A picture resting on a flat light plate: what the opaque riverflow reply is expected to look like.
 */
function plateBytes() {
    return png(120, 80, (ctx) => {
        ctx.fillStyle = '#eeeeee';
        ctx.fillRect(0, 0, 120, 80);
        ctx.fillStyle = '#b02020';
        ctx.beginPath();
        ctx.arc(60, 40, 22, 0, Math.PI * 2);
        ctx.fill();
    });
}

/** A client that records every request and always answers with one picture. */
function recordingClient(replyB64) {
    const seen = [];
    return {
        seen,
        images: {
            async generate(request) { seen.push({ route: 'generate', ...request }); return [replyB64]; },
            async edit(request) { seen.push({ route: 'edit', ...request }); return [replyB64]; },
        },
    };
}

test('riverflow is asked for an opaque frame: the plate is cut locally, not requested as alpha', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-opaque-'));
    try {
        const client = recordingClient((await plateBytes()).toString('base64'));
        const config = {
            baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL,
            image: { size: 'auto', format: 'png', background: 'auto', alphaMode: 'key', alphaFeather: 1, pngMaxBytes: 4 * 1024 * 1024 },
            limits: {},
        };
        const toolset = createToolset({ root: dir, client, config, names: ['generate_image'], approvalLevel: 'all' });
        const made = await toolset.execute({
            name: 'generate_image',
            arguments: JSON.stringify({ prompt: 'flat mark', path: 'assets/mark.png', size: '120x80', background: 'transparent' }),
        });
        assert.equal(made.ok, true, made.output);

        // The wire field is opaque: this family answers `transparent` with a painted plate anyway.
        assert.equal(client.seen[0].background, 'opaque', 'the request must not ask riverflow for transparency');
        assert.equal(client.seen[0].background_mode, 'opaque');
        // gpt-image does get the real field, so the family split is what decides.
        const gptClient = recordingClient((await plateBytes()).toString('base64'));
        const gptToolset = createToolset({
            root: dir, client: gptClient,
            config: { ...config, imageModel: GPT_MODEL },
            names: ['generate_image'], approvalLevel: 'all',
        });
        await gptToolset.execute({
            name: 'generate_image',
            arguments: JSON.stringify({ prompt: 'flat mark', path: 'assets/gpt.png', size: '120x80', background: 'transparent' }),
        });
        assert.equal(gptClient.seen[0].background, 'transparent', 'gpt-image keeps the native alpha field');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('alphaMode key cuts the plate without spending a single extra generation', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-keymode-'));
    try {
        const client = recordingClient((await plateBytes()).toString('base64'));
        const config = {
            baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL,
            image: { size: 'auto', format: 'png', background: 'auto', alphaMode: 'key', alphaFeather: 1, pngMaxBytes: 4 * 1024 * 1024 },
            limits: {},
        };
        const toolset = createToolset({ root: dir, client, config, names: ['generate_image'], approvalLevel: 'all' });
        const made = await toolset.execute({
            name: 'generate_image',
            arguments: JSON.stringify({ prompt: 'flat mark', path: 'assets/mark.png', size: '120x80', background: 'transparent' }),
        });
        assert.equal(made.ok, true, made.output);
        // One request only: the generation itself. No paint pass, no matte pass.
        assert.equal(client.seen.length, 1, `expected one generation call, got ${client.seen.length}`);
        assert.match(made.output, /без дополнительных генераций/);

        const out = path.join(dir, 'assets', 'mark.png');
        assert.equal((await pixel(out, 60, 40))[3], 255, 'the subject stays opaque');
        assert.equal((await pixel(out, 2, 2))[3], 0, 'the plate becomes transparent');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the technical passes use the edit model, not the expensive generator', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-techmodel-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient();
        const config = { baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL, image: { maskModel: 'cheap/edit-model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: RIVERFLOW_MODEL });
        assert.equal(result.changed, true);
        assert.equal(result.model, 'cheap/edit-model', 'the matte is credited to the technical model');
        // Both passes must be charged to the cheap model: the generator family is billed once.
        for (const call of client.calls) {
            assert.equal(call.model, 'cheap/edit-model', `a technical pass went to ${call.model}`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('maskModel self runs the technical passes on the generator itself, in the exact source frame', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rf-selftech-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient();
        const config = { baseURL: 'https://api.example/v1/', imageModel: RIVERFLOW_MODEL, image: { maskModel: 'self', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: RIVERFLOW_MODEL });
        assert.equal(result.changed, true);
        assert.equal(client.calls.length, 2, 'the paid path still runs both passes');
        for (const call of client.calls) {
            assert.equal(call.model, RIVERFLOW_MODEL, 'a technical pass left the generator');
            // Riverflow takes an arbitrary frame, so the matte comes back in the source geometry:
            // this is what the cheap preset-sized technical model cannot promise.
            assert.equal(call.size, '120x80', 'the technical pass must keep the source frame');
        }
        assert.equal((await pixel(file, 60, 40))[3], 255);
        assert.equal((await pixel(file, 2, 2))[3], 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a named maskModel wins over the generator in the gpt-image tract too', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-gpt-techmodel-'));
    try {
        const file = path.join(dir, 'art.png');
        await writeFile(file, await subjectBytes());
        const client = fakeClient();
        const config = { baseURL: 'https://api.example/v1/', imageModel: GPT_MODEL, image: { maskModel: 'cheap/edit-model', paintBackground: true } };
        const result = await applyGeneratedAlphaMask({ client, config, file, model: GPT_MODEL });
        assert.equal(result.changed, true);
        for (const call of client.calls) {
            assert.equal(call.model, 'cheap/edit-model', 'the operator named the technical model; the generator must not be charged');
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('alphaMode key means the same thing in both families: a local cut, no generation', async (t) => {
    if (!(await rasterEngine())) return t.skip('no local raster engine');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-key-symmetric-'));
    try {
        const file = path.join(dir, 'plate.png');
        await writeFile(file, await plateBytes());
        const never = {
            images: {
                async edit() { throw new Error('a key cut must not ask the model for anything'); },
                async generate() { throw new Error('a key cut must not ask the model for anything'); },
            },
        };
        for (const model of [RIVERFLOW_MODEL, GPT_MODEL]) {
            const target = path.join(dir, `cut-${model.includes('riverflow') ? 'rf' : 'gpt'}.png`);
            await writeFile(target, await plateBytes());
            const result = await applyGeneratedAlphaMask({
                client: never, config: { imageModel: model, image: { alphaMode: 'key' } }, file: target, model,
            });
            assert.equal(result.changed, true, `${model} did not cut the plate in key mode`);
            assert.equal(result.reason, 'key', `${model} used ${result.reason} instead of the local key cut`);
            assert.equal((await pixel(target, 60, 40))[3], 255, `${model} lost the subject`);
            assert.equal((await pixel(target, 2, 2))[3], 0, `${model} kept the plate`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('image.alphaMode accepts key and still rejects an unknown mode', async () => {
    const home = path.join(os.tmpdir(), 'ai-home-alpha-mode');
    try {
        const load = (alphaMode) => loadConfig({
            env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
            overrides: { image: { alphaMode } },
            ensureHome: true,
        });
        assert.equal((await load('key')).image.alphaMode, 'key');
        await assert.rejects(() => load('nonsense'), /alphaMode/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
