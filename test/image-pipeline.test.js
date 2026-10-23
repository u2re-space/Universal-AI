import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createClient } from '../src/openai/client.js';
import { createToolset } from '../src/agent/tools.js';
import { runProgram } from '../src/agent/shell.js';
import { detectMagick, magickIsOpaque } from '../src/agent/image-magick.js';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask } from '../src/agent/image-alpha.js';

/**
 * Run ImageMagick inside a temporary directory.
 * @param {string} exe
 * @param {string} dir
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function magick(exe, dir, args) {
    const res = await runProgram({ file: exe, args, cwd: dir, timeoutMs: 20000, maxOutputBytes: 65536 });
    assert.equal(res.exitCode, 0, res.stderr);
}

/**
 * Read one pixel as `r,g,b,a`.
 * @param {string} exe
 * @param {string} dir
 * @param {string} file
 * @param {number} x
 * @param {number} y
 * @returns {Promise<number[]>}
 */
async function pixel(exe, dir, file, x, y) {
    const res = await runProgram({
        file: exe, cwd: dir, timeoutMs: 20000, maxOutputBytes: 4096,
        args: [file, '-format', `%[fx:round(255*p{${x},${y}}.r)],%[fx:round(255*p{${x},${y}}.g)],%[fx:round(255*p{${x},${y}}.b)],%[fx:round(255*p{${x},${y}}.a)]`, 'info:'],
    });
    return res.stdout.trim().split(',').map(Number);
}

test('end-to-end: native alpha, paint + matte, RGBA composition, and SVG', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-pipeline-'));

    // Source: a red square on white. The cut-out version carries a real alpha channel.
    await magick(exe, dir, ['-size', '160x120', 'xc:white', '-fill', '#cc2222', '-draw', 'rectangle 50,30 110,90', 'src.png']);
    await magick(exe, dir, ['-size', '160x120', 'xc:none', '-fill', '#cc2222', '-draw', 'rectangle 50,30 110,90', 'native.png']);
    // Painted: the background takes the subject color.
    await magick(exe, dir, ['-size', '160x120', 'xc:#cc2222', '-fill', '#cc2222', '-draw', 'rectangle 50,30 110,90', 'painted.png']);
    // Matte: a soft grayscale ramp around the subject.
    await magick(exe, dir, ['-size', '160x120', 'xc:black', '-fill', 'white', '-draw', 'rectangle 50,30 110,90', '-blur', '0x2', 'matte.png']);

    const b64 = async (name) => (await readFile(path.join(dir, name))).toString('base64');
    const nativeB64 = await b64('native.png');
    const paintedB64 = await b64('painted.png');
    const matteB64 = await b64('matte.png');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect x="50" y="30" width="60" height="60" fill="#cc2222"/></svg>';
    const svgB64 = Buffer.from(svg).toString('base64');

    /** Requests the mock saw, in order. */
    const seen = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('latin1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url !== '/v1/images/edits') {
            res.end(JSON.stringify({ data: [] }));
            return;
        }
        const prompt = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] ?? '';
        const model = /name="model"\r\n\r\n([^\r]+)\r\n/.exec(raw)?.[1] ?? '';
        seen.push({ model, prompt, raw });

        // Stage 4: the vector model answers with SVG markup.
        if (/name="image_format"\r\n\r\nsvg\r\n/.test(raw)) {
            res.end(JSON.stringify({ data: [{ b64_json: svgB64 }] }));
            return;
        }
        // Stage 2b: a matte of the painted picture.
        if (prompt === ALPHA_MASK_PROMPT) {
            res.end(JSON.stringify({ data: [{ b64_json: matteB64 }] }));
            return;
        }
        // Stage 2a: the background is painted with the subject color.
        if (prompt === BACKGROUND_PAINT_PROMPT) {
            res.end(JSON.stringify({ data: [{ b64_json: paintedB64 }] }));
            return;
        }
        // Stage 1: image-to-image that honors background=transparent.
        res.end(JSON.stringify({ data: [{ b64_json: nativeB64 }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });

    try {
        const config = {
            baseURL: 'http://127.0.0.1/v1/', imageModel: 'openai/gpt-image-2.5-flare',
            image: { size: 'auto', quality: 'auto', format: 'png', background: 'auto', paintBackground: true, alphaFeather: 1 },
            limits: {},
        };
        const toolset = createToolset({ root: dir, client, config, names: ['generate_image', 'vectorize_image'], approvalLevel: 'all' });

        // --- Stage 1: the model returns a real alpha channel, so no matte runs.
        const generated = await toolset.execute({
            name: 'generate_image',
            arguments: JSON.stringify({
                prompt: 'Recreate this flat logo exactly', path: 'assets/mark.png', size: '160x120', quality: '',
                reference: 'src.png', extra_images: '', background: 'transparent', to_svg: false,
            }),
        });
        assert.equal(generated.ok, true, generated.output);
        assert.match(generated.output, /настоящий альфа-канал/);
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'assets', 'mark.png'), cwd: dir }), false);
        assert.deepEqual(await pixel(exe, dir, 'assets/mark.png', 4, 4), [0, 0, 0, 0]);
        assert.deepEqual(await pixel(exe, dir, 'assets/mark.png', 80, 60), [204, 34, 34, 255]);

        const first = seen.at(-1);
        assert.equal(first.model, 'openai/gpt-image-2.5-flare');
        assert.match(first.raw, /name="output_format"\r\n\r\npng\r\n/);
        assert.match(first.raw, /name="background"\r\n\r\ntransparent\r\n/);

        // --- Stages 2 and 3: paint the background, draw a soft matte, merge it as alpha.
        // The input is an opaque reply (the model ignored background=transparent), so the pipeline runs.
        await magick(exe, dir, ['-size', '160x120', 'xc:white', '-fill', '#cc2222', '-draw', 'rectangle 50,30 110,90', 'assets/opaque.png']);
        const paintedCalls = [];
        const alphaClient = {
            images: {
                async edit(request) {
                    paintedCalls.push(request);
                    const name = request.prompt === ALPHA_MASK_PROMPT ? 'matte.png' : 'painted.png';
                    return [await b64(name)];
                },
            },
        };
        const composed = await applyGeneratedAlphaMask({
            client: alphaClient, config, file: path.join(dir, 'assets', 'opaque.png'), alphaSource: path.join(dir, 'src.png'),
        });
        assert.equal(composed.changed, true);
        assert.equal(composed.reason, 'mask');
        assert.equal(composed.painted, true);
        assert.equal(paintedCalls.length, 2);
        assert.equal(paintedCalls[0].prompt, BACKGROUND_PAINT_PROMPT);
        assert.equal(paintedCalls[1].prompt, ALPHA_MASK_PROMPT);
        // Technical passes stay on the raster model the caller uses, not on a separate default.
        assert.equal(paintedCalls[0].model, 'openai/gpt-image-2.5-flare');
        assert.equal(paintedCalls[1].model, 'openai/gpt-image-2.5-flare');
        // The paint pass receives the clean source, the matte pass receives the painted picture.
        assert.equal(Buffer.compare(paintedCalls[0].files[0].bytes, await readFile(path.join(dir, 'src.png'))), 0);
        assert.equal(Buffer.compare(paintedCalls[1].files[0].bytes, await readFile(path.join(dir, 'painted.png'))), 0);
        // The composed file is RGBA: transparent corner, opaque subject in the painted color.
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'assets', 'opaque.png'), cwd: dir }), false);
        assert.equal((await pixel(exe, dir, 'assets/opaque.png', 4, 4))[3], 0);
        assert.deepEqual(await pixel(exe, dir, 'assets/opaque.png', 80, 60), [204, 34, 34, 255]);

        // --- Stage 4: a vector was asked for, so the tool vectorizes the cut-out in the same call.
        const vectored = await toolset.execute({
            name: 'generate_image',
            arguments: JSON.stringify({
                prompt: 'Recreate this flat logo exactly', path: 'assets/badge.png', size: '160x120', quality: '',
                reference: 'src.png', extra_images: '', background: 'transparent', to_svg: true,
            }),
        });
        assert.equal(vectored.ok, true, vectored.output);
        assert.match(vectored.output, /Векторизовано assets\/badge\.png → assets\/badge\.svg/);
        assert.equal(await readFile(path.join(dir, 'assets', 'badge.svg'), 'utf8'), svg);
        const vectorRequest = seen.findLast((item) => /name="image_format"\r\n\r\nsvg\r\n/.test(item.raw));
        assert.equal(vectorRequest.model, 'recraft/recraft-v4.1-pro-vector');
        assert.match(vectorRequest.raw, /name="image"; filename="badge\.png"/);
        assert.equal((await stat(path.join(dir, 'assets', 'badge.svg'))).isFile(), true);
    } finally {
        client.close();
        await rm(dir, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});

test('a checkerboard reply is cut by the local matte instead of being trusted as alpha', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-pipeline-fake-'));
    try {
        await magick(exe, dir, ['-size', '160x120', 'pattern:checkerboard', '-fill', '#cc2222', '-draw', 'rectangle 50,30 110,90', 'fake.png']);
        const b64 = (await readFile(path.join(dir, 'fake.png'))).toString('base64');
        const calls = [];
        const client = { images: { async edit(request) { calls.push(request); throw new Error('no model'); } } };
        const result = await applyGeneratedAlphaMask({
            client, config: { image: { paintBackground: false } }, file: path.join(dir, 'fake.png'),
        });
        // The fake plate is opaque, so a matte runs; the model call fails and the saturation matte wins.
        assert.equal(result.changed, true);
        assert.equal(result.reason, 'saturation');
        assert.equal(calls.length, 1);
        assert.match(String(result.error?.message ?? ''), /no model/);
        assert.equal(await magickIsOpaque({ exe, input: path.join(dir, 'fake.png'), cwd: dir }), false);
        assert.equal((await pixel(exe, dir, 'fake.png', 2, 2))[3], 0);
        assert.equal((await pixel(exe, dir, 'fake.png', 80, 60))[3], 255);
        assert.deepEqual(await pixel(exe, dir, 'fake.png', 80, 60), [204, 34, 34, 255]);
        assert.ok(b64.length > 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
