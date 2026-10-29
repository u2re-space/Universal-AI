import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from 'canvas';
import { createClient } from '../src/openai/client.js';
import { TINY_PNG } from './helpers/mock-server.js';
import { rasterInfo, rasterIsOpaque, rasterPadImageBytes } from '../src/agent/image-raster.js';
import { runProgram } from '../src/agent/shell.js';
import { backgroundValue, encodeMultipart, generationBody, imageFormatField, imageModelFor, imagePayloads, imageRequestSize, imageSizeAttempts, imageTransport, normalizeImageFormat, normalizeImageSize, normalizeVectorRatio, sameAspectImageSize, isImageSizeError, isVectorModel, pngHasAlphaChannel, sniffImage, supportsTransparentBackground, PROXY_VECTOR_MODEL, VECTOR_RATIOS } from '../src/openai/images.js';
import { builtinTools } from '../src/agent/loop.js';
import { enabledToolNames } from '../src/agent/tool-specs.js';
import { createToolset } from '../src/agent/tools.js';

const RGB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oKFgUxCIqEz80AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMTAtMjJUMDU6NDk6MDgrMDA6MDAqmhesAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTEwLTIyVDA1OjQ5OjA4KzAwOjAwW8evEAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0xMC0yMlQwNTo0OTowOCswMDowMAzSjs8AAAAKSURBVAjXY2gAAACCAIHdQ2r0AAAAAElFTkSuQmCC';

test('proxyapi uses the images API and omits Responses-only image fields', () => {
    assert.equal(imageTransport({ baseURL: 'https://api.proxyapi.ru/v1/' }), 'images');
    assert.equal(imageTransport({ baseURL: 'https://api.openai.com/v1/' }), 'responses');
    assert.equal(imageTransport({ baseURL: 'https://api.proxyapi.ru/v1/', image: { transport: 'responses' } }), 'responses');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/' }), 'openai/gpt-image-2.5-sunburst');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/' }, { hasImage: true }), 'openai/gpt-image-2.5-sunburst');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/', imageModel: 'custom/model' }, { hasImage: true }), 'custom/model');
    const body = generationBody({ model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', size: 'auto', quality: 'auto', n: 1, format: 'png', background: 'transparent' });
    assert.deepEqual(body, { model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', image_format: 'png' });
    assert.deepEqual(
        generationBody({ model: 'gpt-image-2.5-sunburst', prompt: 'маяк', size: 'auto', quality: 'auto', n: 1, format: 'png', background: 'transparent' }),
        { model: 'gpt-image-2.5-sunburst', prompt: 'маяк', output_format: 'png', background: 'transparent' },
    );
    assert.equal('partial_images' in body, false);
    assert.deepEqual(
        generationBody({ model: 'gpt-image-1', prompt: 'маяк', format: 'png', background: 'transparent' }),
        { model: 'gpt-image-1', prompt: 'маяк', output_format: 'png', background: 'transparent' },
    );
    assert.equal(supportsTransparentBackground('gpt-image-2.5-sunburst'), true);
    assert.equal(supportsTransparentBackground('gpt-image-1'), true);
    assert.equal(supportsTransparentBackground('gpt-image-2'), false);
    assert.equal(supportsTransparentBackground('gpt-image-2-2026-04-21'), false);
    assert.equal(supportsTransparentBackground('recraft/recraft-v4.1-utility'), false);
    assert.equal('background' in generationBody({ model: 'gpt-image-2', prompt: 'маяк', background: 'transparent' }), false);
    assert.equal(imageFormatField('gpt-image-2'), 'output_format');
    assert.equal(imageFormatField('gpt-image-2.5-sunburst'), 'output_format');
    assert.equal(imageFormatField('gpt-image-1'), 'output_format');
    assert.equal(imageFormatField('recraft/recraft-v4.1-utility'), 'image_format');
    assert.equal(backgroundValue({ model: 'gpt-image-2.5-sunburst', format: 'png', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: 'gpt-image-2.5-sunburst', format: 'webp', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: 'gpt-image-2.5-sunburst', format: 'jpeg', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: 'gpt-image-2.5-sunburst', format: 'png', background: 'opaque' }), 'opaque');
    assert.equal(backgroundValue({ model: 'gpt-image-2.5-sunburst', format: 'png', background: 'auto' }), null);
    assert.equal(backgroundValue({ model: 'gpt-image-2', format: 'png', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: 'recraft/recraft-v4.1-utility', format: 'png', background: 'transparent' }), null);
    assert.deepEqual(
        generationBody({ model: 'gpt-image-2.5-sunburst', prompt: 'маяк', format: 'jpeg', background: 'transparent' }),
        { model: 'gpt-image-2.5-sunburst', prompt: 'маяк', output_format: 'jpeg' },
    );
    assert.equal(normalizeImageFormat('auto'), null);
    assert.equal(normalizeImageFormat('jpg'), 'jpeg');
    assert.equal(normalizeImageFormat('PNG'), 'png');
    assert.deepEqual(imagePayloads({ data: [{ b64_json: TINY_PNG }, { b64_json: '' }] }), [TINY_PNG]);
    assert.equal(normalizeImageSize('auto'), null);
    assert.equal(normalizeImageSize(''), null);
    assert.equal(normalizeImageSize('1024x1024'), '1024x1024');
    assert.equal(normalizeImageSize('768x1024'), '1024x1536');
    assert.equal(normalizeImageSize('1280x720'), '1536x1024');
    assert.equal(normalizeImageSize('portrait'), '1024x1536');
    assert.equal(imageRequestSize('2048x2048', 'gpt-image-2.5-sunburst'), '2048x2048');
    assert.equal(imageRequestSize('2048x2048', 'gpt-image-1'), '1024x1024');
    assert.equal(generationBody({ model: 'gpt-image-2.5-sunburst', prompt: 'p', size: '2048x2048' }).size, '2048x2048');
    assert.deepEqual(imageSizeAttempts('2048x2048', 'gpt-image-2.5-sunburst'), ['2048x2048', '1024x1024']);
    assert.deepEqual(imageSizeAttempts('100x100', 'gpt-image-2.5-sunburst'), ['100x100', '816x816', '1024x1024']);
    assert.deepEqual(imageSizeAttempts('4096x2048', 'gpt-image-2.5-sunburst'), ['4096x2048', '3840x1920', '1536x1024']);
    assert.deepEqual(imageSizeAttempts('1024x1024', 'gpt-image-2.5-sunburst'), ['1024x1024']);
    assert.equal(sameAspectImageSize('bad'), null);
    assert.equal(sameAspectImageSize('100x100'), '816x816');
    assert.equal(sameAspectImageSize('100000x100000'), '2880x2880');
    assert.equal(sameAspectImageSize('1x4'), null);
    assert.equal(isImageSizeError({ status: 400, param: 'size' }), true);
    assert.equal(isImageSizeError({ status: 422, message: 'Unsupported dimensions for this model' }), true);
    assert.equal(isImageSizeError({ status: 401, message: 'Invalid size' }), false);
    assert.equal(isImageSizeError({ status: 400, message: 'Invalid API key' }), false);
    assert.equal(generationBody({ model: 'm', prompt: 'p', size: '768x1024' }).size, '1024x1536');
    assert.equal(generationBody({ model: 'm', prompt: 'p', size: 'auto' }).size, undefined);
    const png = Buffer.from(TINY_PNG, 'base64');
    const form = encodeMultipart({ fields: { model: 'recraft/recraft-v4.1-utility', prompt: 'утро' }, files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }] });
    assert.match(form.contentType, /multipart\/form-data; boundary=/);
    assert.ok(form.body.includes(png));
    assert.match(form.body.toString('latin1'), /filename="shot.png"/);
    assert.equal(sniffImage(png).mime, 'image/png');
    assert.equal(pngHasAlphaChannel(png), true);
    assert.equal(pngHasAlphaChannel(Buffer.from(RGB_PNG, 'base64')), false);
    const proxy = { baseURL: 'https://api.proxyapi.ru/v1/', tools: { web: false, images: true }, image: { format: 'png', partialImages: 2, size: 'auto', quality: 'auto', background: 'auto' }, webSearch: { contextSize: 'medium' } };
    assert.equal(builtinTools(proxy, { images: imageTransport(proxy) !== 'images' }).some((tool) => tool.type === 'image_generation'), false);
    assert.ok(enabledToolNames({ images: true, fs: true }, { imageApi: true }).includes('generate_image'));
    assert.ok(enabledToolNames({ images: true, fs: true }, { imageApi: true }).includes('edit_image'));
});

test('vector model uses aspect_ratio and svg output', () => {
    assert.equal(PROXY_VECTOR_MODEL, 'recraft/recraft-v4.1-pro-vector');
    assert.equal(isVectorModel('recraft/recraft-v4.1-vector'), true);
    assert.equal(isVectorModel('recraft/recraft-v4-styles-pro-vector'), true);
    assert.equal(isVectorModel('recraft/recraft-v4.1-utility'), false);
    assert.equal(isVectorModel(''), false);
    assert.deepEqual([...VECTOR_RATIOS], ['1:1', '4:3', '3:4', '16:9', '9:16', 'auto']);
    assert.equal(normalizeVectorRatio(''), null);
    assert.equal(normalizeVectorRatio('auto'), null);
    assert.equal(normalizeVectorRatio('1:1'), '1:1');
    assert.equal(normalizeVectorRatio('square'), '1:1');
    assert.equal(normalizeVectorRatio('portrait'), '3:4');
    assert.equal(normalizeVectorRatio('landscape'), '4:3');
    assert.equal(normalizeVectorRatio('1024x1024'), '1:1');
    assert.equal(normalizeVectorRatio('1536x1024'), '4:3');
    assert.equal(normalizeVectorRatio('1024x1536'), '3:4');
    assert.equal(normalizeVectorRatio('1920x1080'), '16:9');
    assert.equal(normalizeVectorRatio('1080x1920'), '9:16');
    assert.equal(normalizeVectorRatio('garbage'), null);
    const vectorBody = generationBody({
        model: 'recraft/recraft-v4.1-pro-vector', prompt: 'логотип', size: '1024x1024', format: 'png', quality: 'high', background: 'transparent',
    });
    assert.deepEqual(vectorBody, { model: 'recraft/recraft-v4.1-pro-vector', prompt: 'логотип', aspect_ratio: '1:1', image_format: 'svg' });
    assert.equal('size' in vectorBody, false);
    assert.equal('quality' in vectorBody, false);
    assert.equal('background' in vectorBody, false);
    assert.equal('input_references' in vectorBody, false);
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).mime, 'image/svg+xml');
    assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg></svg>')).ext, 'svg');
    assert.equal(sniffImage(Buffer.from('<svg')).ext, 'svg');
});

test('vectorize_image is offered together with the other image tools', () => {
    const names = enabledToolNames({ images: true, fs: true }, { imageApi: true });
    assert.ok(names.includes('vectorize_image'));
    assert.equal(enabledToolNames({ images: true, fs: true }, { imageApi: false }).includes('vectorize_image'), false);
});

test('images client vectorize posts the source as a multipart edit and the tool saves SVG', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>';
    const svgB64 = Buffer.from(svg).toString('base64');
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/v1/images/edits') {
            const form = raw.toString('latin1');
            assert.match(form, /name="model"\r\n\r\nrecraft\/recraft-v4\.1-pro-vector\r\n/);
            assert.match(form, /name="image_format"\r\n\r\nsvg\r\n/);
            assert.match(form, /name="image"; filename="logo\.png"/);
            assert.doesNotMatch(form, /name="size"/);
            assert.doesNotMatch(form, /name="aspect_ratio"/);
            res.end(JSON.stringify({ data: [{ b64_json: svgB64 }] }));
            return;
        }
        res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-vector-'));
    try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path.join(root, 'logo.png'), png);
        const toolset = createToolset({
            root, client, config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', quality: 'auto' }, limits: {} },
            names: ['vectorize_image'], approvalLevel: 'all',
        });
        const result = await toolset.execute({ name: 'vectorize_image', arguments: JSON.stringify({ image: 'logo.png', path: 'assets/logo.svg', prompt: '', remove_background: true, force: false }) });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /assets\/logo\.svg/);
        assert.equal((await readFile(path.join(root, 'assets', 'logo.svg'), 'utf8')), svg);
    } finally {
        client.close();
        await rm(root, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});

test('openai edits send output_format and background instead of image_format', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('latin1');
        assert.match(raw, /name="model"\r\n\r\ngpt-image-1\r\n/);
        assert.match(raw, /name="output_format"\r\n\r\npng\r\n/);
        assert.match(raw, /name="background"\r\n\r\ntransparent\r\n/);
        assert.doesNotMatch(raw, /name="image_format"/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    try {
        const payloads = await client.images.edit({
            model: 'gpt-image-1', prompt: 'утро', format: 'png', background: 'transparent',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.equal(payloads[0], TINY_PNG);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image 2.5 retries invalid dimensions in order and does not retry other errors', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const generationSizes = [];
    const editSizes = [];
    let authAttempts = 0;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const fail = (status, message, param = null) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message, param } }));
        };
        if (req.url === '/v1/images/generations') {
            const body = JSON.parse(raw.toString('utf8'));
            if (body.prompt === 'auth') { authAttempts++; return fail(401, 'Invalid API key'); }
            generationSizes.push(body.size);
            if (generationSizes.length < 3) return fail(400, 'Invalid image size', 'size');
        } else {
            const form = raw.toString('latin1');
            editSizes.push(/name="size"\r\n\r\n([^\r]+)/.exec(form)?.[1]);
            if (editSizes.length < 3) return fail(422, 'Unsupported dimensions');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    try {
        await client.images.generate({ model: 'gpt-image-2.5-sunburst', prompt: 'draw', size: '100x100' });
        assert.deepEqual(generationSizes, ['100x100', '816x816', '1024x1024']);
        await client.images.edit({
            model: 'gpt-image-2.5-sunburst', prompt: 'edit', size: '100x100',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.deepEqual(editSizes, ['16x16', '816x816', '1024x1024']);
        await assert.rejects(() => client.images.generate({ model: 'gpt-image-2.5-sunburst', prompt: 'auth', size: '100x100' }), { status: 401 });
        assert.equal(authAttempts, 1);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image 2.5 pads non-multiple input edges without scaling and removes returned padding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-'));
    const source = path.join(root, 'source.png');
    const paddedReply = path.join(root, 'reply.png');
    const generatePng = async (file, width, height) => {
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#cc2222';
        ctx.fillRect(16, 16, width - 32, height - 32);
        await writeFile(file, canvas.toBuffer('image/png'));
    };
    const pixelAt = async (file, x, y) => {
        const sharp = (await import('sharp')).default;
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const at = (y * info.width + x) * 4;
        return [...data.subarray(at, at + 4)];
    };
    try {
        await generatePng(source, 1000, 600);
        await generatePng(paddedReply, 1008, 608);
        const sourceBytes = await readFile(source);
        const seen = [];
        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('latin1');
            const header = /name="size"\r\n\r\n([^\r]+)/.exec(raw);
            const imagePart = /name="image"; filename="source\.png"\r\nContent-Type: image\/png\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
            seen.push({ size: header?.[1], file: Boolean(imagePart), image: imagePart?.[1] });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: (await readFile(paddedReply)).toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp' });
        try {
            const payloads = await client.images.edit({
                model: 'gpt-image-2.5-sunburst', prompt: 'preserve', format: 'png',
                files: [{ filename: 'source.png', mime: 'image/png', bytes: sourceBytes }],
            });
            const original = await rasterPadImageBytes({ bytes: sourceBytes, engine: 'sharp' });
            assert.deepEqual(seen.map(({ size, file }) => ({ size, file })), [{ size: '1008x608', file: true }]);
            assert.equal(original.width, 1008);
            assert.equal(original.height, 608);
            assert.equal(original.originalWidth, 1000);
            assert.equal(original.originalHeight, 600);
            assert.equal(original.padded, true);
            const sentPath = path.join(root, 'sent.png');
            await writeFile(sentPath, Buffer.from(seen[0].image, 'latin1'));
            const sentInfo = await rasterInfo(sentPath, { cwd: root, engine: 'sharp' });
            assert.equal(sentInfo.width, 1008);
            assert.equal(sentInfo.height, 608);
            assert.deepEqual(await pixelAt(sentPath, 20, 20), await pixelAt(source, 20, 20));
            assert.deepEqual(await pixelAt(sentPath, 1004, 604), [0, 0, 0, 0]);
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            assert.equal(info.width, 1000);
            assert.equal(info.height, 600);
            assert.equal(await rasterIsOpaque(resultPath, { cwd: root, engine: 'sharp' }), false);
            assert.deepEqual(await pixelAt(resultPath, 16, 16), [204, 34, 34, 255]);
            assert.deepEqual(await pixelAt(resultPath, 20, 20), [204, 34, 34, 255]);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('images client posts generations and edits and the tool saves the file', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const generations = [];
    const edits = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/v1/images/generations') {
            generations.push(JSON.parse(raw.toString('utf8')));
            res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
            return;
        }
        const text = raw.toString('latin1');
        assert.match(text, /name="image"/);
        edits.push({ text, model: /name="model"\r\n\r\n([^\r]+)\r\n/.exec(text)?.[1] ?? '' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-images-'));
    try {
        const drawn = await client.images.generate({ model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', size: 'auto', format: 'png', background: 'transparent' });
        assert.equal(drawn[0], TINY_PNG);
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(root, 'shot.png'), png));
        const toolset = createToolset({
            root, client, config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', quality: 'auto' }, limits: {} },
            names: ['generate_image', 'edit_image'], approvalLevel: 'all',
        });
        const generated = await toolset.execute({ name: 'generate_image', arguments: JSON.stringify({ prompt: 'маяк', path: 'assets/portrait.png', size: '', quality: '' }) });
        assert.match(generated.output, /assets\/portrait\.png/);
        assert.equal((await readFile(path.join(root, 'assets', 'portrait.png'))).equals(png), true);
        const edited = await toolset.execute({ name: 'edit_image', arguments: JSON.stringify({ prompt: 'утро', image: 'shot.png', path: 'assets/edited.png', size: '' }) });
        assert.match(edited.output, /assets\/edited\.png/);

        // The direct recraft call keeps the vendor-specific format field and gets no OpenAI-only background.
        assert.deepEqual(generations[0], { model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', image_format: 'png' });
        // The tool defaults to gpt-image-2.5 for raster work.
        assert.equal(generations[1].model, 'openai/gpt-image-2.5-sunburst');
        assert.equal(generations[1].output_format, 'png');
        assert.equal('image_format' in generations[1], false);
        assert.equal(edits[0].model, 'openai/gpt-image-2.5-sunburst');
        assert.match(edits[0].text, /name="output_format"\r\n\r\npng\r\n/);
        assert.doesNotMatch(edits[0].text, /name="background"/);
    } finally {
        client.close();
        await rm(root, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});
