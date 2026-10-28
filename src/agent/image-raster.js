/**
 * @file src/agent/image-raster.js
 * @module agent/image-raster
 * @purpose Local raster operations on sharp with a node-canvas fallback: comparison sheets, pixel
 *          differences, alpha masks, crops, trims, splits, and SVG-to-raster conversion.
 * @depends node:path, node:fs/promises
 * @usedBy agent/tools, agent/image-alpha
 * @exports rasterEngine, rasterInfo, rasterCompare, rasterApplyAlphaMask, rasterLocalAlphaMatte, rasterDetectFakeTransparency, rasterCrop, rasterTrim, rasterSplit, rasterizeSvg, fitBox, frameFor
 * @ai.tags sharp, canvas, image, compare, alpha, crop, svg
 * @ai.hint io
 * @changed 2026-10-28 First version: comparison and matte work moved off the browser and off ImageMagick.
 *
 * Why this module exists: a comparison built as an SVG document and rasterized by a browser engine
 * loses the input rasters — the snapshot comes back empty, and the agent repeats the request. sharp
 * reads the pixels directly (PNG, WebP, JPEG, and SVG through librsvg), so a comparison sheet is one
 * local call with no browser, no ImageMagick spawn, and no second AI request. node-canvas covers the
 * same operations when the native sharp binary is unavailable.
 */

import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

/** Cached module handles. null = not tried yet, false = unavailable, object = the module. */
let _sharp = null;
let _canvas = null;

/** Longest side of a comparison sheet when the caller does not ask for a frame. */
const DEFAULT_MAX_SIDE = 768;

/** Names that choose a common frame instead of a literal WIDTHxHEIGHT. */
const NAMED_FRAMES = { square: 1, landscape: 16 / 10, portrait: 10 / 16 };

/** Raster and vector inputs a comparison or a matte can read. */
const READABLE_EXT = /\.(png|jpe?g|webp|gif|tiff?|bmp|avif|svg)$/i;

/**
 * Load sharp once. Returns the module or null when the native binary is missing.
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function sharpLib() {
    if (_sharp === null) {
        try {
            const module = await import('sharp');
            _sharp = module.default ?? module;
        } catch { _sharp = false; }
    }
    return _sharp || null;
}

/**
 * Load node-canvas once. Returns the module or null when the native build is missing.
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function canvasLib() {
    if (_canvas === null) {
        try { _canvas = await import('canvas'); }
        catch { _canvas = false; }
    }
    return _canvas || null;
}

/**
 * Pick the preferred engine, falling back to the other native implementation.
 * @param {'auto'|'sharp'|'canvas'} preferred
 * @returns {Promise<{ name: 'sharp'|'canvas', lib: object }|null>}
 * @ai.hint io
 */
async function getEngine(preferred = 'auto') {
    if (preferred === 'canvas') {
        const canvas = await canvasLib();
        if (canvas) return { name: 'canvas', lib: canvas };
    }
    const sharp = await sharpLib();
    if (sharp) return { name: 'sharp', lib: sharp };
    const canvas = await canvasLib();
    return canvas ? { name: 'canvas', lib: canvas } : null;
}

/**
 * Which local raster engine this process has: 'sharp', 'canvas', or null for neither.
 * @returns {Promise<'sharp'|'canvas'|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterEngine(preferred = 'auto') {
    const engine = await getEngine(preferred);
    return engine?.name ?? null;
}

/**
 * Resolve a project-relative or absolute path to an absolute one.
 * @param {string} cwd
 * @param {string} file
 * @returns {string}
 * @ai.hint pure
 */
const toAbs = (cwd, file) => (path.isAbsolute(file) ? file : path.join(cwd, file));

/**
 * Parse a padding color: 'transparent', a named color, or #rgb/#rrggbb.
 * @param {string} value
 * @returns {{ r: number, g: number, b: number, alpha: number }}
 * @ai.hint pure
 */
function parseColor(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text || text === 'transparent' || text === 'none') return { r: 0, g: 0, b: 0, alpha: 0 };
    const named = { white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080' };
    const hex = named[text] ?? text;
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
    if (short) return { r: parseInt(short[1] + short[1], 16), g: parseInt(short[2] + short[2], 16), b: parseInt(short[3] + short[3], 16), alpha: 1 };
    const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
    if (long) return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16), alpha: 1 };
    return { r: 0, g: 0, b: 0, alpha: 0 };
}

/**
 * The box that fits a source proportionally into a cell: centered, never stretched.
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @returns {{ x: number, y: number, width: number, height: number, scale: number }}
 * @exports
 * @ai.hint pure
 */
export function fitBox(sourceWidth, sourceHeight, cellWidth, cellHeight) {
    if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(cellWidth > 0) || !(cellHeight > 0)) {
        return { x: 0, y: 0, width: Math.max(1, cellWidth), height: Math.max(1, cellHeight), scale: 1 };
    }
    const scale = Math.min(cellWidth / sourceWidth, cellHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    return { x: Math.round((cellWidth - width) / 2), y: Math.round((cellHeight - height) / 2), width, height, scale };
}

/**
 * The common frame every candidate is fitted into.
 * @param {{ frame?: string, sources: Array<{ width: number, height: number }>, maxSide?: number }} options
 * @returns {{ width: number, height: number }}
 * @exports
 * @ai.hint pure
 */
export function frameFor({ frame = '', sources = [], maxSide = DEFAULT_MAX_SIDE }) {
    const cap = Math.max(64, Math.min(2048, Math.round(maxSide) || DEFAULT_MAX_SIDE));
    const ratio = NAMED_FRAMES[String(frame ?? '').trim().toLowerCase()];
    const literal = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(frame ?? '').trim());
    if (Number.isFinite(ratio)) {
        return ratio >= 1
            ? { width: cap, height: Math.max(1, Math.round(cap / ratio)) }
            : { width: Math.max(1, Math.round(cap * ratio)), height: cap };
    }
    if (literal) {
        return { width: Math.max(1, Math.min(cap * 4, Number(literal[1]))), height: Math.max(1, Math.min(cap * 4, Number(literal[2]))) };
    }
    const largest = sources.reduce((best, item) => (item.width * item.height > best.width * best.height ? item : best), { width: 1, height: 1 });
    const long = Math.max(largest.width, largest.height);
    if (long <= cap) return { width: largest.width, height: largest.height };
    return { width: Math.max(1, Math.round(largest.width * cap / long)), height: Math.max(1, Math.round(largest.height * cap / long)) };
}

/**
 * Number of columns a layout puts `count` cells into.
 * @param {'row'|'column'|'grid'} layout
 * @param {number} count
 * @returns {number}
 * @ai.hint pure
 */
function columnsFor(layout, count) {
    if (layout === 'column') return 1;
    if (layout === 'grid') return Math.min(count, Math.ceil(Math.sqrt(count)));
    return count;
}

/**
 * Width, height, and per-cell origin of a comparison sheet.
 * @param {{ count: number, cell: { width: number, height: number }, layout: string, gap: number }} options
 * @returns {{ width: number, height: number, boxes: Array<{ x: number, y: number }> }}
 * @ai.hint pure
 */
function sheetLayout({ count, cell, layout, gap }) {
    const cols = columnsFor(layout, count);
    const rows = Math.ceil(count / cols);
    const width = cols * cell.width + (cols - 1) * gap;
    const height = rows * cell.height + (rows - 1) * gap;
    const boxes = [];
    for (let index = 0; index < count; index++) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        boxes.push({ x: col * (cell.width + gap), y: row * (cell.height + gap) });
    }
    return { width, height, boxes };
}

/**
 * Metadata of one local picture, read without a browser and without ImageMagick.
 * @param {string} file Absolute path or a path inside `cwd`.
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function rasterInfo(file, { cwd = process.cwd(), engine = 'auto' } = {}) {
    const abs = toAbs(cwd, file);
    const bytes = await readFile(abs);
    const active = await getEngine(engine);
    if (active?.name === 'sharp') {
        const meta = await active.lib(bytes).metadata();
        const swap = [5, 6, 7, 8].includes(meta.orientation);
        return {
            width: (swap ? meta.height : meta.width) ?? 0,
            height: (swap ? meta.width : meta.height) ?? 0,
            format: meta.format ?? '',
            hasAlpha: Boolean(meta.hasAlpha),
        };
    }
    if (active?.name === 'canvas') {
        const image = await active.lib.loadImage(bytes);
        return { width: image.width ?? 0, height: image.height ?? 0, format: '', hasAlpha: true };
    }
    throw new Error('Нет локального растрового движка: установите sharp или canvas.');
}

/**
 * Whether the image has a pixel with alpha below 255; an alpha-capable format alone is not enough.
 * @param {string} file Absolute path or a path inside `cwd`.
 * @param {{ cwd?: string, engine?: 'auto'|'sharp'|'canvas' }} [options]
 * @returns {Promise<boolean|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterIsOpaque(file, { cwd = process.cwd(), engine = 'auto' } = {}) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, file)), engine);
        for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] < 255) return false;
        return true;
    } catch {
        return null;
    }
}

/**
 * Decode one picture into raw RGBA.
 * @param {Buffer} bytes
 * @returns {Promise<{ width: number, height: number, channels: 4, data: Buffer }>}
 * @ai.hint io
 */
async function decodeRgba(bytes, preferred = 'auto', maxSide = null) {
    const active = await getEngine(preferred);
    if (active?.name === 'sharp') {
        let pipe = active.lib(bytes).rotate();
        if (maxSide) pipe = pipe.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
        const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, channels: 4, data };
    }
    if (active?.name !== 'canvas') throw new Error('Нет локального растрового движка: установите sharp или canvas.');
    const image = await active.lib.loadImage(bytes);
    const scale = maxSide ? Math.min(1, maxSide / Math.max(image.width, image.height)) : 1;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const surface = active.lib.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length) };
}

/**
 * Scale an RGBA buffer to a box with bilinear weights, keeping the pixels proportional.
 * @param {{ width: number, height: number, data: Buffer }} source
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number, channels: 4, data: Buffer }}
 * @ai.hint pure
 */
async function scaleRgba(source, width, height, preferred = 'auto') {
    if (source.width === width && source.height === height) return source;
    const active = await getEngine(preferred);
    if (active?.name === 'sharp') {
        const { data } = await active.lib(source.data, { raw: { width: source.width, height: source.height, channels: 4 } })
            .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width, height, channels: 4, data };
    }
    if (active?.name !== 'canvas') throw new Error('Нет локального растрового движка: установите sharp или canvas.');
    const surface = active.lib.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const imageData = ctx.createImageData(source.width, source.height);
    imageData.data.set(source.data);
    const sourceCanvas = active.lib.createCanvas(source.width, source.height);
    sourceCanvas.getContext('2d').putImageData(imageData, 0, 0);
    ctx.drawImage(sourceCanvas, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length) };
}

/**
 * Paint one RGBA frame onto a sheet at an offset, honouring its alpha.
 * @param {{ width: number, height: number, data: Buffer }} sheet
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {number} x
 * @param {number} y
 * @returns {void}
 * @ai.hint pure
 */
function blit(sheet, frame, x, y) {
    for (let row = 0; row < frame.height; row++) {
        const targetY = y + row;
        if (targetY < 0 || targetY >= sheet.height) continue;
        for (let col = 0; col < frame.width; col++) {
            const targetX = x + col;
            if (targetX < 0 || targetX >= sheet.width) continue;
            const from = (row * frame.width + col) * 4;
            const alpha = frame.data[from + 3];
            if (alpha === 0) continue;
            const to = (targetY * sheet.width + targetX) * 4;
            if (alpha === 255 || sheet.data[to + 3] === 0) {
                sheet.data[to] = frame.data[from];
                sheet.data[to + 1] = frame.data[from + 1];
                sheet.data[to + 2] = frame.data[from + 2];
                sheet.data[to + 3] = Math.max(sheet.data[to + 3], alpha);
                continue;
            }
            // Source-over on an already painted pixel keeps the composite honest.
            const outAlpha = alpha + sheet.data[to + 3] * (1 - alpha / 255);
            for (let channel = 0; channel < 3; channel++) {
                const top = frame.data[from + channel] * alpha + sheet.data[to + channel] * sheet.data[to + 3] * (1 - alpha / 255);
                sheet.data[to + channel] = Math.round(outAlpha > 0 ? top / outAlpha : 0);
            }
            sheet.data[to + 3] = Math.round(outAlpha);
        }
    }
}

/**
 * Encode an RGBA frame as PNG bytes.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @returns {Promise<Buffer>}
 * @ai.hint io
 */
async function encodePng(frame, preferred = 'auto') {
    const active = await getEngine(preferred);
    if (active?.name === 'sharp') return await active.lib(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer();
    if (active?.name !== 'canvas') throw new Error('Нет локального растрового движка: установите sharp или canvas.');
    const surface = active.lib.createCanvas(frame.width, frame.height);
    const ctx = surface.getContext('2d');
    const image = ctx.createImageData(frame.width, frame.height);
    image.data.set(frame.data);
    ctx.putImageData(image, 0, 0);
    return surface.toBuffer('image/png');
}

/**
 * Mean gray level of a matte and the gray level of its top-left corner.
 * @param {{ width: number, height: number, data: Buffer }} matte
 * @returns {{ mean: number, corner: number }}
 * @ai.hint pure
 */
function matteProbe(matte) {
    let sum = 0;
    let seen = 0;
    const step = matte.width > 256 || matte.height > 256 ? 4 : 1;
    for (let y = 0; y < matte.height; y += step) {
        for (let x = 0; x < matte.width; x += step) {
            const at = (y * matte.width + x) * 4;
            sum += 0.2126 * matte.data[at] + 0.7152 * matte.data[at + 1] + 0.0722 * matte.data[at + 2];
            seen++;
        }
    }
    const corner = 0.2126 * matte.data[0] + 0.7152 * matte.data[1] + 0.0722 * matte.data[2];
    return { mean: seen ? sum / seen / 255 : 0, corner: corner / 255 };
}

/**
 * Turn a grayscale matte into an alpha channel and write the RGBA picture.
 * Mirrors `magickApplyAlphaMask`: an all-white or all-black matte is refused, a matte whose corner is
 * white is inverted, and `feather` smooths the transition band.
 * @param {{ input: string, mask: string, output?: string, cwd: string, signal?: AbortSignal, feather?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string, inverted?: boolean, feathered?: number, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterApplyAlphaMask({ input, mask, output = input, cwd, signal, feather = 1, engine = 'auto' }) {
    const inputBytes = await readFile(toAbs(cwd, input)).catch(() => null);
    if (!inputBytes) return { changed: false, reason: 'unreadable' };
    const base = await decodeRgba(inputBytes, engine).catch(() => null);
    if (!base?.width || !base.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();
    const matteBytes = await readFile(toAbs(cwd, mask)).catch(() => null);
    const matteSource = matteBytes && await decodeRgba(matteBytes, engine).catch(() => null);
    if (!matteSource?.width || !matteSource.height) return { changed: false, reason: 'unreadable' };
    const matte = await scaleRgba(matteSource, base.width, base.height, engine);
    const probe = matteProbe(matte);
    if (probe.mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (probe.mean >= 0.995) return { changed: false, reason: 'full-mask' };
    const inverted = probe.corner > 0.5;
    const alpha = Buffer.alloc(matte.width * matte.height);
    for (let i = 0, p = 0; i < matte.data.length; i += 4, p++) alpha[p] = inverted ? 255 - matte.data[i] : matte.data[i];
    const smooth = Number.isFinite(feather) ? Math.max(0, Math.min(8, feather)) : 1;
    const blurred = smooth > 0 ? boxBlur(alpha, matte.width, matte.height, Math.max(1, Math.round(smooth))) : alpha;
    const rgba = Buffer.alloc(base.width * base.height * 4);
    for (let p = 0, i = 0; p < blurred.length; p++, i += 4) {
        rgba[i] = base.data[i];
        rgba[i + 1] = base.data[i + 1];
        rgba[i + 2] = base.data[i + 2];
        rgba[i + 3] = blurred[p];
    }
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, await encodePng({ width: base.width, height: base.height, data: rgba }, engine));
    return { changed: true, reason: 'mask', inverted, feathered: smooth, width: base.width, height: base.height };
}

/**
 * Average a single channel over a square window: the transition band of a hard matte.
 * @param {Buffer} channel
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Buffer}
 * @ai.hint pure
 */
function boxBlur(channel, width, height, radius) {
    if (radius <= 0) return channel;
    const horizontal = Buffer.alloc(channel.length);
    const out = Buffer.alloc(channel.length);
    for (let y = 0; y < height; y++) {
        let sum = 0;
        let count = 0;
        for (let x = 0; x < width; x++) {
            const enter = x === 0 ? radius : x + radius;
            const leave = x - radius - 1;
            if (x === 0) {
                for (let first = 0; first <= Math.min(radius, width - 1); first++) { sum += channel[y * width + first]; count++; }
            } else if (enter < width) { sum += channel[y * width + enter]; count++; }
            if (x > 0 && leave >= 0) { sum -= channel[y * width + leave]; count--; }
            horizontal[y * width + x] = Math.round(sum / Math.max(1, count));
        }
    }
    for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let y = 0; y < height; y++) {
            const enter = y === 0 ? radius : y + radius;
            const leave = y - radius - 1;
            if (y === 0) {
                for (let first = 0; first <= Math.min(radius, height - 1); first++) { sum += horizontal[first * width + x]; count++; }
            } else if (enter < height) { sum += horizontal[enter * width + x]; count++; }
            if (y > 0 && leave >= 0) { sum -= horizontal[leave * width + x]; count--; }
            out[y * width + x] = Math.round(sum / Math.max(1, count));
        }
    }
    return out;
}

/**
 * Draw a local alpha matte from the picture itself, without a model or ImageMagick.
 *
 * `contour` floods the four corners with the corner color (within `fuzz`) and keeps the rest opaque.
 * `saturation` uses HSL saturation: colored pixels become the subject, neutral pixels become transparent.
 * Both return the same `{ changed, reason }` contract as `magickContourAlphaMask`/`magickSaturationAlphaMask`.
 * @param {{ input: string, output?: string, cwd: string, signal?: AbortSignal, mode: 'contour'|'saturation', fuzz?: number, threshold?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterLocalAlphaMatte({ input, output = input, cwd, signal, mode, fuzz = 10, threshold = 15, engine = 'auto' }) {
    const base = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    if (!base.width || !base.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();
    let alpha = Buffer.alloc(base.width * base.height);
    if (mode === 'contour') {
        const corner = [base.data[0], base.data[1], base.data[2]];
        const tol = Math.max(0, Math.min(255, Math.round(fuzz * 2.55)));
        const queue = [];
        const push = (x, y) => { const p = y * base.width + x; if (!alpha[p]) { alpha[p] = 1; queue.push(p); } };
        push(0, 0); push(base.width - 1, 0); push(0, base.height - 1); push(base.width - 1, base.height - 1);
        for (let head = 0; head < queue.length; head++) {
            const p = queue[head];
            const x = p % base.width;
            const y = (p / base.width) | 0;
            const at = p * 4;
            const near = Math.abs(base.data[at] - corner[0]) <= tol
                && Math.abs(base.data[at + 1] - corner[1]) <= tol
                && Math.abs(base.data[at + 2] - corner[2]) <= tol;
            if (!near) { alpha[p] = 0; continue; }
            if (x > 0) push(x - 1, y);
            if (x + 1 < base.width) push(x + 1, y);
            if (y > 0) push(x, y - 1);
            if (y + 1 < base.height) push(x, y + 1);
        }
        for (let p = 0; p < alpha.length; p++) alpha[p] = alpha[p] ? 0 : 255;
    } else {
        for (let p = 0, i = 0; i < base.data.length; i += 4, p++) {
            const r = base.data[i] / 255, g = base.data[i + 1] / 255, b = base.data[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
            const sat = max === 0 ? 0 : delta / max;
            alpha[p] = sat * 100 >= threshold ? 255 : 0;
        }
    }
    // The matte is a grayscale picture: white keeps the subject, black cuts it. Writing the source
    // colors here would make `rasterApplyAlphaMask` read a color channel as alpha.
    const matteRgba = Buffer.alloc(alpha.length * 4);
    for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
        matteRgba[i] = alpha[p];
        matteRgba[i + 1] = alpha[p];
        matteRgba[i + 2] = alpha[p];
        matteRgba[i + 3] = 255;
    }
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, await encodePng({ width: base.width, height: base.height, data: matteRgba }, engine));
    const probe = matteProbe({ width: base.width, height: base.height, data: matteRgba });
    if (probe.mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (probe.mean >= 0.995) return { changed: false, reason: 'full-mask' };
    return { changed: true, reason: mode, width: base.width, height: base.height };
}

/**
 * Detect a painted transparency plate without ImageMagick: a checkerboard or a gray grid that an
 * image model draws instead of an alpha channel. Two corner patches are read; a fake plate holds a
 * handful of neutral tones (the color count does not change in grayscale), while a real background
 * is one flat color or a colored picture.
 * @param {{ input: string, cwd: string, signal?: AbortSignal, patch?: number, engine?: string }} options
 * @returns {Promise<{ fake: boolean, reason: string, colors: number|null, mean: number|null }>}
 * @exports
 * @ai.hint io
 */
export async function rasterDetectFakeTransparency({ input, cwd, signal, patch = 16, engine = 'auto' }) {
    const bytes = await readFile(toAbs(cwd, input)).catch(() => null);
    if (!bytes) return { fake: false, reason: 'unreadable', colors: null, mean: null };
    const frame = await decodeRgba(bytes, engine).catch(() => null);
    if (!frame?.width || !frame.height) return { fake: false, reason: 'unreadable', colors: null, mean: null };
    signal?.throwIfAborted();
    const side = Math.max(4, Math.min(patch, frame.width, frame.height));
    const samples = [];
    for (const [x0, y0] of [[0, 0], [Math.max(0, frame.width - side), 0]]) {
        const colors = new Set();
        const grays = new Set();
        let neutral = true;
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y0 + side; y++) {
            for (let x = x0; x < x0 + side; x++) {
                const at = (y * frame.width + x) * 4;
                if (frame.data[at + 3] < 255) return { fake: false, reason: 'already', colors: null, mean: null };
                const r = frame.data[at], g = frame.data[at + 1], b = frame.data[at + 2];
                colors.add(`${r},${g},${b}`);
                grays.add(Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
                if (Math.max(r, g, b) - Math.min(r, g, b) > 8) neutral = false;
                sum += (r + g + b) / 3;
                count++;
            }
        }
        samples.push({ colors: colors.size, grayColors: grays.size, mean: count ? sum / count / 255 : 0, neutral });
    }
    const hit = (item) => item.neutral && item.colors >= 2 && item.colors <= 16
        && item.colors === item.grayColors && item.mean >= 0.2 && item.mean <= 0.97;
    const hits = samples.filter(hit);
    const first = samples[0];
    if (hits.length === samples.length) return { fake: true, reason: 'checkerboard', colors: first.colors, mean: first.mean };
    return { fake: false, reason: hits.length ? 'partly-neutral' : 'plain', colors: first.colors, mean: first.mean };
}

/**
 * Cut a box out of a picture.
 * @param {{ input: string, output: string, x: number, y: number, width: number, height: number, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterCrop({ input, output, x = 0, y = 0, width, height, cwd, signal, engine = 'auto' }) {
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const cropWidth = Math.max(1, Math.round(width));
    const cropHeight = Math.max(1, Math.round(height));
    const active = await getEngine(engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    if (active?.name === 'sharp') {
        const info = await active.lib(bytes).metadata();
        const box = {
            left: Math.min(left, Math.max(0, info.width - 1)),
            top: Math.min(top, Math.max(0, info.height - 1)),
            width: Math.min(cropWidth, info.width - Math.min(left, Math.max(0, info.width - 1))),
            height: Math.min(cropHeight, info.height - Math.min(top, Math.max(0, info.height - 1))),
        };
        const png = await active.lib(bytes).rotate().extract(box).png().toBuffer();
        await writeFile(outAbs, png);
        return { rel: String(output).split(path.sep).join('/'), bytes: png.length, width: box.width, height: box.height };
    }
    const source = await decodeRgba(bytes, engine);
    const box = { left: Math.min(left, source.width - 1), top: Math.min(top, source.height - 1) };
    box.width = Math.min(cropWidth, source.width - box.left);
    box.height = Math.min(cropHeight, source.height - box.top);
    const data = Buffer.alloc(box.width * box.height * 4);
    for (let row = 0; row < box.height; row++) {
        source.data.copy(data, row * box.width * 4, ((box.top + row) * source.width + box.left) * 4, ((box.top + row) * source.width + box.left) * 4 + box.width * 4);
    }
    const png = await encodePng({ width: box.width, height: box.height, data }, engine);
    await writeFile(outAbs, png);
    return { rel: String(output).split(path.sep).join('/'), bytes: png.length, width: box.width, height: box.height };
}

/**
 * Cut uniform or transparent padding off all four edges.
 * @param {{ input: string, output?: string, cwd: string, signal?: AbortSignal, fuzz?: number|null }} options
 * @returns {Promise<{ changed: boolean, reason: string, before?: {width:number,height:number}, after?: {width:number,height:number} }>}
 * @exports
 * @ai.hint io
 */
export async function rasterTrim({ input, output = input, cwd, signal, fuzz = 6, engine = 'auto' }) {
    const before = await rasterInfo(input, { cwd, engine }).catch(() => null);
    if (!before?.width || !before.height) return { changed: false, reason: 'unreadable' };
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    signal?.throwIfAborted();
    const tolerance = Math.max(0, Math.min(255, Math.round((Number.isFinite(fuzz) ? fuzz : 6) * 2.55)));
    const edge = { r: frame.data[0], g: frame.data[1], b: frame.data[2], a: frame.data[3] };
    const matches = (index) => {
        const a = frame.data[index + 3];
        if (edge.a === 0 || a === 0) return a === edge.a || (a <= tolerance && edge.a <= tolerance);
        return Math.abs(frame.data[index] - edge.r) <= tolerance
            && Math.abs(frame.data[index + 1] - edge.g) <= tolerance
            && Math.abs(frame.data[index + 2] - edge.b) <= tolerance;
    };
    const rowUniform = (y) => {
        for (let x = 0; x < frame.width; x++) if (!matches((y * frame.width + x) * 4)) return false;
        return true;
    };
    const columnUniform = (x) => {
        for (let y = 0; y < frame.height; y++) if (!matches((y * frame.width + x) * 4)) return false;
        return true;
    };
    let top = 0;
    let bottom = frame.height - 1;
    let left = 0;
    let right = frame.width - 1;
    while (top < bottom && rowUniform(top)) top++;
    while (bottom > top && rowUniform(bottom)) bottom--;
    while (left < right && columnUniform(left)) left++;
    while (right > left && columnUniform(right)) right--;
    const box = { width: right - left + 1, height: bottom - top + 1 };
    if (box.width === frame.width && box.height === frame.height) return { changed: false, reason: 'no-padding', before, after: before };
    if (box.width < frame.width * 0.1 || box.height < frame.height * 0.1) return { changed: false, reason: 'too-small', before, after: box };
    const result = await rasterCrop({ input, output, x: left, y: top, width: box.width, height: box.height, cwd, signal, engine });
    return { changed: true, reason: 'trimmed', before, after: { width: result.width, height: result.height } };
}

/**
 * Cut a picture into a rows×cols grid, the same tile geometry as `magickSplit`.
 * @param {{ input: string, outputDir: string, rows: number, cols: number, cwd: string, signal?: AbortSignal, baseName?: string }} options
 * @returns {Promise<Array<{ rel: string, row: number, col: number, x: number, y: number, width: number, height: number, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function rasterSplit({ input, outputDir, rows, cols, cwd, signal, baseName = 'tile', engine = 'auto' }) {
    const info = await rasterInfo(input, { cwd, engine });
    if (!info.width || !info.height) throw new Error(`Не удалось определить размеры: ${input}`);
    const tileW = Math.floor(info.width / cols);
    const tileH = Math.floor(info.height / rows);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = col * tileW;
            const y = row * tileH;
            const width = col === cols - 1 ? info.width - x : tileW;
            const height = row === rows - 1 ? info.height - y : tileH;
            const rel = `${outputDir}/${baseName}_r${row + 1}c${col + 1}.png`;
            const cut = await rasterCrop({ input, output: rel, x, y, width, height, cwd, signal, engine });
            tiles.push({ rel, row: row + 1, col: col + 1, x, y, width, height, bytes: cut.bytes });
        }
    }
    return tiles;
}

/**
 * Rasterize an SVG document locally: librsvg through sharp, or node-canvas. No browser is started.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterPadImageBytes({ bytes, engine = 'auto' }) {
    const active = await getEngine(engine);
    if (!active) return null;
    const info = await rasterInfoFromBytes(bytes, active);
    if (!info.width || !info.height) throw new Error('Не удалось определить размеры входного изображения.');
    const width = Math.ceil(info.width / 16) * 16;
    const height = Math.ceil(info.height / 16) * 16;
    const padded = width !== info.width || height !== info.height;
    const frame = await decodeRgba(bytes, active.name);
    if (!padded) return { bytes, width, height, originalWidth: frame.width, originalHeight: frame.height, padded: false, engine: active.name };
    if (active.name === 'sharp') {
        const output = await active.lib(bytes).rotate().extend({ right: width - frame.width, bottom: height - frame.height, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        return { bytes: output, width, height, originalWidth: frame.width, originalHeight: frame.height, padded: true, engine: active.name };
    }
    const output = { width, height, channels: 4, data: Buffer.alloc(width * height * 4) };
    for (let row = 0; row < frame.height; row++) frame.data.copy(output.data, row * width * 4, row * frame.width * 4, (row + 1) * frame.width * 4);
    return { bytes: await encodePng(output, active.name), width, height, originalWidth: frame.width, originalHeight: frame.height, padded: true, engine: active.name };
}

/**
 * Restore the exact original top-left frame after a provider returns a padded frame.
 * @param {{ bytes: Buffer, width: number, height: number, originalWidth: number, originalHeight: number, engine?: 'auto'|'sharp'|'canvas' }} options
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function rasterRemoveImagePadding({ bytes, width, height, originalWidth, originalHeight, engine = 'auto' }) {
    if (width === originalWidth && height === originalHeight) return bytes;
    const active = await getEngine(engine);
    if (!active) return null;
    const info = await rasterInfoFromBytes(bytes, active);
    if (info.width !== width || info.height !== height || originalWidth > width || originalHeight > height) return bytes;
    if (active.name === 'sharp') {
        return await active.lib(bytes).extract({ left: 0, top: 0, width: originalWidth, height: originalHeight }).png().toBuffer();
    }
    const frame = await decodeRgba(bytes, active.name);
    const data = Buffer.alloc(originalWidth * originalHeight * 4);
    for (let row = 0; row < originalHeight; row++) frame.data.copy(data, row * originalWidth * 4, row * width * 4, row * width * 4 + originalWidth * 4);
    return await encodePng({ width: originalWidth, height: originalHeight, data }, active.name);
}

/** Metadata of a buffer using an already-selected native engine. */
async function rasterInfoFromBytes(bytes, active) {
    if (active.name === 'sharp') {
        const info = await active.lib(bytes).metadata();
        const swap = [5, 6, 7, 8].includes(info.orientation);
        return { width: (swap ? info.height : info.width) ?? 0, height: (swap ? info.width : info.height) ?? 0 };
    }
    const image = await active.lib.loadImage(bytes);
    return { width: image.width ?? 0, height: image.height ?? 0 };
}

/**
 * Rasterize an SVG document locally: librsvg through sharp, or node-canvas. No browser is started.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterizeSvg({ input, output, width = null, height = null, cwd, signal, engine = 'auto' }) {
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const active = await getEngine(engine);
    if (active?.name === 'sharp') {
        let pipe = active.lib(bytes, { density: 96 });
        if (width || height) pipe = pipe.resize(width || undefined, height || undefined, { fit: 'inside' });
        const out = pipe.png();
        const outAbs = toAbs(cwd, output);
        await mkdir(path.dirname(outAbs), { recursive: true });
        await out.toFile(outAbs);
        const info = await active.lib(await readFile(outAbs)).metadata();
        return { rel: String(output).split(path.sep).join('/'), bytes: (await stat(outAbs)).size, width: info.width, height: info.height };
    }
    if (active?.name !== 'canvas') throw new Error('Нет локального растрового движка: установите sharp или canvas.');
    const image = await active.lib.loadImage(bytes);
    const box = width || height
        ? fitBox(image.width, image.height, width ?? image.width, height ?? image.height)
        : { width: image.width, height: image.height };
    const surface = active.lib.createCanvas(box.width, box.height);
    surface.getContext('2d').drawImage(image, 0, 0, box.width, box.height);
    const png = surface.toBuffer('image/png');
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return { rel: String(output).split(path.sep).join('/'), bytes: png.length, width: box.width, height: box.height };
}

/**
 * Absolute per-channel difference of two frames of the same size.
 * @param {{ data: Buffer }} a
 * @param {{ data: Buffer }} b
 * @returns {{ heat: { width: number, height: number, channels: 4, data: Buffer }, mean: number }}
 * @ai.hint pure
 */
function differenceFrame(a, b) {
    const heat = { width: a.width, height: a.height, channels: 4, data: Buffer.alloc(a.width * a.height * 4) };
    let sum = 0;
    for (let i = 0, p = 0; i < a.data.length; i += 4, p += 4) {
        let peak = 0;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a.data[i + channel] - b.data[i + channel]);
            sum += delta;
            if (delta > peak) peak = delta;
        }
        heat.data[p] = peak;
        heat.data[p + 1] = peak;
        heat.data[p + 2] = peak;
        heat.data[p + 3] = 255;
    }
    return { heat, mean: sum / Math.max(1, a.data.length) };
}

/**
 * Stamp the source name of every cell in the corner of the sheet.
 * @param {{ width: number, height: number, data: Buffer }} sheet
 * @param {Array<{ x: number, y: number, label: string }>} labels
 * @returns {Promise<boolean>} false when no text engine is available
 * @ai.hint io
 */
async function drawLabels(sheet, labels) {
    const canvas = await canvasLib();
    if (!canvas) return false;
    const surface = canvas.createCanvas(sheet.width, sheet.height);
    const ctx = surface.getContext('2d');
    const image = ctx.createImageData(sheet.width, sheet.height);
    image.data.set(Buffer.from(sheet.data.buffer, sheet.data.byteOffset, sheet.data.length));
    ctx.putImageData(image, 0, 0);
    const size = Math.max(11, Math.min(22, Math.round(sheet.height / 24)));
    ctx.font = `${size}px sans-serif`;
    ctx.textBaseline = 'top';
    for (const item of labels) {
        const text = item.label;
        const box = ctx.measureText(text);
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(item.x + 4, item.y + 4, box.width + 12, size + 10);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, item.x + 10, item.y + 9);
    }
    const frame = ctx.getImageData(0, 0, sheet.width, sheet.height);
    sheet.data.set(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length));
    return true;
}

/**
 * Build a comparison sheet from existing pictures, locally.
 *
 * Every candidate is fitted proportionally into one common frame — centered on transparent or neutral
 * padding — and never stretched. An SVG candidate is rasterized by the same engine, so no browser is
 * involved. With two candidates and `diff` the absolute per-pixel difference is written next to the
 * sheet together with a mean error, which answers "how close are these two" without a model request.
 * @param {{ files: Array<{ abs: string, rel: string }>, output: string, cwd: string, layout?: 'row'|'column'|'grid', frame?: string, gap?: number, background?: string, maxSide?: number, labels?: boolean, diff?: boolean, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, width: number, height: number, cell: {width:number,height:number}, items: Array<object>, diff: object|null, engine: string, labelsDrawn: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function rasterCompare(options) {
    const { files, output, cwd, layout = 'row', frame = '', background = 'transparent', maxSide = DEFAULT_MAX_SIDE, labels = false, signal, engine: preferred = 'auto' } = options;
    const mode = options.mode === 'difference' || options.mode === 'both' ? options.mode : 'sheet';
    const engine = await rasterEngine(preferred);
    if (!engine) throw new Error('Нет локального растрового движка: установите sharp или canvas.');
    if (!Array.isArray(files) || files.length < 2 || files.length > 12) throw new Error('Для compare_images передайте от 2 до 12 путей.');
    if (mode !== 'sheet' && files.length !== 2) throw new Error('Режим difference поддерживает ровно два изображения.');
    const gap = Math.max(0, Math.min(64, Math.round(options.gap ?? 8)));
    const decoded = [];
    for (const file of files) {
        if (!READABLE_EXT.test(file.abs)) throw new Error(`${file.rel}: читаются PNG, JPEG, WebP, GIF, TIFF, BMP, AVIF и SVG.`);
        const bytes = await readFile(file.abs);
        const image = await decodeRgba(bytes, preferred, Math.max(4096, maxSide));
        if (!image.width || !image.height) throw new Error(`${file.rel}: размеры не читаются.`);
        decoded.push({ ...file, frame: image });
        signal?.throwIfAborted();
    }
    const cell = frameFor({ frame, sources: decoded.map((item) => ({ width: item.frame.width, height: item.frame.height })), maxSide });
    const sheetBox = sheetLayout({ count: decoded.length, cell, layout, gap });
    const pad = parseColor(background);
    const sheet = { width: sheetBox.width, height: sheetBox.height, channels: 4, data: Buffer.alloc(sheetBox.width * sheetBox.height * 4) };
    if (pad.alpha > 0) {
        for (let p = 0; p < sheet.data.length; p += 4) {
            sheet.data[p] = pad.r;
            sheet.data[p + 1] = pad.g;
            sheet.data[p + 2] = pad.b;
            sheet.data[p + 3] = 255;
        }
    }
    const items = [];
    const comparisonFrames = [];
    for (const [index, entry] of decoded.entries()) {
        const fit = fitBox(entry.frame.width, entry.frame.height, cell.width, cell.height);
        const scaled = await scaleRgba(entry.frame, fit.width, fit.height, preferred);
        const cellOrigin = sheetBox.boxes[index];
        blit(sheet, scaled, cellOrigin.x + fit.x, cellOrigin.y + fit.y);
        const normalized = { width: cell.width, height: cell.height, channels: 4, data: Buffer.alloc(cell.width * cell.height * 4) };
        if (pad.alpha > 0) {
            for (let p = 0; p < normalized.data.length; p += 4) {
                normalized.data[p] = pad.r;
                normalized.data[p + 1] = pad.g;
                normalized.data[p + 2] = pad.b;
                normalized.data[p + 3] = 255;
            }
        }
        blit(normalized, scaled, fit.x, fit.y);
        comparisonFrames.push(normalized);
        items.push({
            rel: entry.rel, index: index + 1,
            x: cellOrigin.x + fit.x, y: cellOrigin.y + fit.y,
            width: fit.width, height: fit.height,
            cell: { x: cellOrigin.x, y: cellOrigin.y, width: cell.width, height: cell.height },
            sourceWidth: entry.frame.width, sourceHeight: entry.frame.height,
            scale: Number(fit.scale.toFixed(4)),
        });
    }
    let labelsDrawn = false;
    if (mode !== 'difference' && labels) labelsDrawn = await drawLabels(sheet, items.map((item) => ({ x: item.cell.x, y: item.cell.y, label: path.basename(item.rel) })));
    let sheetRel = null;
    if (mode !== 'difference') {
        const sheetAbs = toAbs(cwd, output);
        await mkdir(path.dirname(sheetAbs), { recursive: true });
        await writeFile(sheetAbs, await encodePng(sheet, preferred));
        sheetRel = String(output).split(path.sep).join('/');
    }
    let diffResult = null;
    if (mode !== 'sheet') {
        const { heat, mean } = differenceFrame(comparisonFrames[0], comparisonFrames[1]);
        const diffRel = mode === 'difference' ? output : `${output.replace(/\.\w+$/, '')}-diff.png`;
        const diffAbs = toAbs(cwd, diffRel);
        await mkdir(path.dirname(diffAbs), { recursive: true });
        await writeFile(diffAbs, await encodePng(heat, preferred));
        diffResult = {
            rel: String(diffRel).split(path.sep).join('/'),
            width: cell.width, height: cell.height,
            meanError: Number(mean.toFixed(2)),
            similarity: Number((100 * (1 - mean / 255)).toFixed(1)),
        };
    }
    return { rel: sheetRel, width: sheetBox.width, height: sheetBox.height, cell, items, diff: diffResult, engine, labelsDrawn };
}
