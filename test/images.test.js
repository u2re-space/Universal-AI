import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '../src/openai/client.js';
import { TINY_PNG } from './helpers/mock-server.js';
import { backgroundValue, encodeMultipart, generationBody, imageFormatField, imageModelFor, imagePayloads, imageTransport, normalizeImageFormat, normalizeImageSize, normalizeVectorRatio, isVectorModel, pngHasAlphaChannel, sniffImage, supportsTransparentBackground, PROXY_VECTOR_MODEL, VECTOR_RATIOS } from '../src/openai/images.js';
import { builtinTools } from '../src/agent/loop.js';
import { enabledToolNames } from '../src/agent/tool-specs.js';
import { createToolset } from '../src/agent/tools.js';

const RGB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oKFgUxCIqEz80AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMTAtMjJUMDU6NDk6MDgrMDA6MDAqmhesAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTEwLTIyVDA1OjQ5OjA4KzAwOjAwW8evEAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0xMC0yMlQwNTo0OTowOCswMDowMAzSjs8AAAAKSURBVAjXY2gAAACCAIHdQ2r0AAAAAElFTkSuQmCC';

test('proxyapi uses the images API and omits Responses-only image fields', () => {
    assert.equal(imageTransport({ baseURL: 'https://api.proxyapi.ru/v1/' }), 'images');
    assert.equal(imageTransport({ baseURL: 'https://api.openai.com/v1/' }), 'responses');
    assert.equal(imageTransport({ baseURL: 'https://api.proxyapi.ru/v1/', image: { transport: 'responses' } }), 'responses');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/' }), 'openai/gpt-image-2.5-flare');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/' }, { hasImage: true }), 'openai/gpt-image-2.5-sunburst');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/', imageModel: 'custom/model' }, { hasImage: true }), 'custom/model');
    const body = generationBody({ model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', size: 'auto', quality: 'auto', n: 1, format: 'png', background: 'transparent' });
    assert.deepEqual(body, { model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', image_format: 'png' });
    assert.deepEqual(
        generationBody({ model: 'openai/gpt-image-2.5-flare', prompt: 'маяк', size: 'auto', quality: 'auto', n: 1, format: 'png', background: 'transparent' }),
        { model: 'openai/gpt-image-2.5-flare', prompt: 'маяк', output_format: 'png', background: 'transparent' },
    );
    assert.equal('partial_images' in body, false);
    assert.deepEqual(
        generationBody({ model: 'openai/gpt-image-1', prompt: 'маяк', format: 'png', background: 'transparent' }),
        { model: 'openai/gpt-image-1', prompt: 'маяк', output_format: 'png', background: 'transparent' },
    );
    assert.equal(supportsTransparentBackground('openai/gpt-image-2.5-flare'), true);
    assert.equal(supportsTransparentBackground('gpt-image-1'), true);
    assert.equal(supportsTransparentBackground('openai/gpt-image-2'), false);
    assert.equal(supportsTransparentBackground('openai/gpt-image-2-2026-04-21'), false);
    assert.equal(supportsTransparentBackground('recraft/recraft-v4.1-utility'), false);
    assert.equal('background' in generationBody({ model: 'openai/gpt-image-2', prompt: 'маяк', background: 'transparent' }), false);
    assert.equal(imageFormatField('openai/gpt-image-2'), 'output_format');
    assert.equal(imageFormatField('openai/gpt-image-2.5-flare'), 'output_format');
    assert.equal(imageFormatField('openai/gpt-image-1'), 'output_format');
    assert.equal(imageFormatField('recraft/recraft-v4.1-utility'), 'image_format');
    assert.equal(backgroundValue({ model: 'openai/gpt-image-2.5-flare', format: 'png', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: 'openai/gpt-image-2.5-flare', format: 'webp', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: 'openai/gpt-image-2.5-flare', format: 'jpeg', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: 'openai/gpt-image-2.5-flare', format: 'png', background: 'opaque' }), 'opaque');
    assert.equal(backgroundValue({ model: 'openai/gpt-image-2.5-flare', format: 'png', background: 'auto' }), null);
    assert.equal(backgroundValue({ model: 'openai/gpt-image-2', format: 'png', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: 'recraft/recraft-v4.1-utility', format: 'png', background: 'transparent' }), null);
    assert.deepEqual(
        generationBody({ model: 'openai/gpt-image-2.5-flare', prompt: 'маяк', format: 'jpeg', background: 'transparent' }),
        { model: 'openai/gpt-image-2.5-flare', prompt: 'маяк', output_format: 'jpeg' },
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
    assert.equal(PROXY_VECTOR_MODEL, 'recraft/recraft-v4.1-vector');
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
        model: 'recraft/recraft-v4.1-vector', prompt: 'логотип', size: '1024x1024', format: 'png', quality: 'high', background: 'transparent',
    });
    assert.deepEqual(vectorBody, { model: 'recraft/recraft-v4.1-vector', prompt: 'логотип', aspect_ratio: '1:1', image_format: 'svg' });
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
            assert.match(form, /name="model"\r\n\r\nrecraft\/recraft-v4\.1-vector\r\n/);
            assert.match(form, /name="image_format"\r\n\r\nsvg\r\n/);
            assert.match(form, /name="image"; filename="source\.png"/);
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
        assert.match(raw, /name="model"\r\n\r\nopenai\/gpt-image-1\r\n/);
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
            model: 'openai/gpt-image-1', prompt: 'утро', format: 'png', background: 'transparent',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.equal(payloads[0], TINY_PNG);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
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
        assert.equal(generations[1].model, 'openai/gpt-image-2.5-flare');
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
