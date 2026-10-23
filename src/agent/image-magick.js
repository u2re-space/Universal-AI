/**
 * @file src/agent/image-magick.js
 * @module agent/image-magick
 * @purpose Detect ImageMagick and provide crop, split, resize, convert operations via CLI.
 * @depends node:path, node:fs/promises, agent/shell
 * @usedBy agent/tools
 * @exports detectMagick, magickCrop, magickSplit, magickResize, magickConvert, magickIdentify, magickIsOpaque, magickColorCount, magickPaletteStats, assessVectorSuitability, magickRemoveFlatBackground, magickApplyAlphaMask, ensureTransparentBackground, magickDetectFakeTransparency, magickContourAlphaMask, magickSaturationAlphaMask
 * @ai.tags imagemagick, image, crop, split, alpha, vector
 * @ai.hint io
 * @changed 2026-10-23 Added the fake-transparency check (painted checkerboard) and the contour matte.
 */

import path from 'node:path';
import { stat, mkdir, rename, unlink } from 'node:fs/promises';
import { runProgram } from './shell.js';

/** Cached detection result. null = not checked, false = not available, string = executable path. */
let _magickPath = null;

/**
 * Detect ImageMagick executable (magick or convert).
 * @param {{ magickPath?: string|null }} [opts]
 * @returns {Promise<string|null>} executable path or null if not found
 * @exports
 * @ai.hint io
 */
export async function detectMagick({ magickPath = null } = {}) {
    if (_magickPath !== null && !magickPath) return _magickPath;
    if (magickPath) {
        const res = await runProgram({ file: magickPath, args: ['-version'], cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 4096 }).catch(() => null);
        return res?.exitCode === 0 && /ImageMagick/i.test(res.stdout) ? magickPath : null;
    }
    const candidates = process.platform === 'win32'
        ? ['magick', 'convert']
        : ['magick', 'convert', '/usr/bin/magick', '/usr/local/bin/convert'];
    for (const exe of candidates) {
        try {
            const res = await runProgram({ file: exe, args: ['-version'], cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 4096 });
            if (res.exitCode === 0 && /ImageMagick/i.test(res.stdout)) {
                _magickPath = exe;
                return exe;
            }
        } catch { /* not found */ }
    }
    _magickPath = false;
    return null;
}

/**
 * Run an ImageMagick command.
 * @param {string} exe
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 * @ai.hint io
 */
async function magickRun(exe, args, { cwd, signal, timeoutMs = 30000 }) {
    const result = await runProgram({ file: exe, args, cwd, timeoutMs, maxOutputBytes: 16384, signal });
    if (result.exitCode !== 0) {
        throw new Error(`ImageMagick (${args.join(' ')}): ${result.stderr || `exit code ${result.exitCode}`}`);
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Crop a region from an image.
 * @param {{ exe: string, input: string, output: string, x: number, y: number, width: number, height: number, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickCrop({ exe, input, output, x, y, width, height, cwd, signal }) {
    const geometry = `${width}x${height}+${x}+${y}`;
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await magickRun(exe, [input, '-crop', geometry, '+repage', output], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Split an image into a grid of rows x cols tiles.
 * @param {{ exe: string, input: string, outputDir: string, rows: number, cols: number, cwd: string, signal?: AbortSignal, baseName?: string }} opts
 * @returns {Promise<Array<{ rel: string, row: number, col: number, x: number, y: number, width: number, height: number, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function magickSplit({ exe, input, outputDir, rows, cols, cwd, signal, baseName = 'tile' }) {
    // Get image dimensions first
    const identify = await magickRun(exe, [input, '-format', '%w %h', 'info:'], { cwd, signal });
    const [imgW, imgH] = identify.stdout.trim().split(/\s+/).map(Number);
    if (!imgW || !imgH) throw new Error(`Не удалось определить размеры: ${input}`);
    const tileW = Math.floor(imgW / cols);
    const tileH = Math.floor(imgH / rows);
    const outAbs = path.isAbsolute(outputDir) ? outputDir : path.join(cwd, outputDir);
    await mkdir(outAbs, { recursive: true });
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = col * tileW;
            const y = row * tileH;
            const w = col === cols - 1 ? imgW - x : tileW;
            const h = row === rows - 1 ? imgH - y : tileH;
            const geometry = `${w}x${h}+${x}+${y}`;
            const rel = `${outputDir}/${baseName}_r${row + 1}c${col + 1}.png`;
            await magickRun(exe, [input, '-crop', geometry, '+repage', rel], { cwd, signal });
            const info = await stat(path.join(cwd, rel)).catch(() => null);
            tiles.push({ rel, row: row + 1, col: col + 1, x, y, width: w, height: h, bytes: info?.size ?? 0 });
        }
    }
    return tiles;
}

/**
 * Resize an image to given dimensions.
 * @param {{ exe: string, input: string, output: string, width: number, height?: number|null, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickResize({ exe, input, output, width, height = null, cwd, signal }) {
    const size = height ? `${width}x${height}` : `${width}x`;
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await magickRun(exe, [input, '-resize', size, output], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Convert image format.
 * @param {{ exe: string, input: string, output: string, quality?: number|null, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickConvert({ exe, input, output, quality = null, cwd, signal }) {
    const args = [input];
    if (quality != null) args.push('-quality', String(quality));
    args.push(output);
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await magickRun(exe, args, { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Get image metadata (width, height, format, size).
 * @param {{ exe: string, input: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ width: number, height: number, format: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickIdentify({ exe, input, cwd, signal }) {
    const res = await magickRun(exe, [input, '-format', '%w %h %m %B', 'info:'], { cwd, signal });
    const parts = res.stdout.trim().split(/\s+/);
    return { width: Number(parts[0]) || 0, height: Number(parts[1]) || 0, format: parts[2] ?? '', bytes: Number(parts[3]) || 0 };
}

/**
 * Whether every pixel of the image is fully opaque. `false` means at least one pixel is transparent.
 * @param {{ exe: string, input: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<boolean|null>} null when ImageMagick cannot answer
 * @exports
 * @ai.hint io
 */
export async function magickIsOpaque({ exe, input, cwd, signal }) {
    const res = await magickRun(exe, [input, '-format', '%[opaque]', 'info:'], { cwd, signal });
    const value = res.stdout.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

/**
 * Remove a flat background by flood-filling from all four corners with the corner color.
 * Interior areas of the same color stay untouched because the fill is connected only to the edges.
 * @param {{ exe: string, input: string, output?: string, cwd: string, signal?: AbortSignal, fuzz?: number }} opts
 * @returns {Promise<{ changed: boolean, reason: string, color?: string }>}
 * @exports
 * @ai.hint io
 */
export async function magickRemoveFlatBackground({ exe, input, output = input, cwd, signal, fuzz = 10 }) {
    const info = await magickIdentify({ exe, input, cwd, signal });
    if (!info.width || !info.height) return { changed: false, reason: 'unreadable' };
    const colorRes = await magickRun(exe, [input, '-format', '%[pixel:p{0,0}]', 'info:'], { cwd, signal });
    const color = colorRes.stdout.trim();
    if (!color || /\bnone\b/i.test(color) || /,\s*0(?:\.0+)?\s*\)$/.test(color)) return { changed: false, reason: 'already' };
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    const suffix = path.extname(outPath) || '.png';
    const tmpPath = path.join(path.dirname(outPath), `.tmp-alpha-${process.pid}-${Date.now()}${suffix}`);
    const corners = [
        [0, 0],
        [Math.max(0, info.width - 1), 0],
        [0, Math.max(0, info.height - 1)],
        [Math.max(0, info.width - 1), Math.max(0, info.height - 1)],
    ];
    const args = [input, '-alpha', 'set', '-channel', 'RGBA', '-fuzz', `${fuzz}%`, '-fill', 'none'];
    for (const [x, y] of corners) args.push('-floodfill', `+${x}+${y}`, color);
    args.push('+channel', tmpPath);
    try {
        await magickRun(exe, args, { cwd, signal });
        await rename(tmpPath, outPath);
    } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
    }
    return { changed: true, reason: 'removed', color };
}

/**
 * Number of unique colors in the image, or null when ImageMagick cannot answer.
 * A low count means flat fills — the kind of artwork (logos, badges, icons) that vectorizes well.
 * @param {{ exe: string, input: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<number|null>}
 * @exports
 * @ai.hint io
 */
export async function magickColorCount({ exe, input, cwd, signal }) {
    const res = await magickRun(exe, [input, '-format', '%k', 'info:'], { cwd, signal }).catch(() => null);
    const value = Number(String(res?.stdout ?? '').trim());
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Quantized palette shares: how much of the picture the few dominant colors cover.
 * Anti-aliased logos and badges keep two colors over most pixels even when the raw
 * unique-color count is high; a photograph spreads evenly across the palette.
 * @param {{ exe: string, input: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ colors: number, total: number, top1: number, top2: number, top4: number }|null>}
 * @exports
 * @ai.hint io
 */
export async function magickPaletteStats({ exe, input, cwd, signal }) {
    const res = await magickRun(exe, [input, '-colors', '8', '-format', '%c', 'histogram:info:'], { cwd, signal }).catch(() => null);
    const counts = [];
    for (const line of String(res?.stdout ?? '').split(/\r?\n/)) {
        const match = /^\s*(\d+):/.exec(line);
        if (match && Number(match[1]) > 0) counts.push(Number(match[1]));
    }
    const total = counts.reduce((sum, value) => sum + value, 0);
    if (!total) return null;
    counts.sort((a, b) => b - a);
    const share = (count) => counts.slice(0, count).reduce((sum, value) => sum + value, 0) / total;
    return { colors: counts.length, total, top1: share(1), top2: share(2), top4: share(4) };
}

/**
 * Decide whether a raster is worth sending to a vector model. Logos, badges, and icons have a
 * small palette or two dominant colors; photographs spread across the palette and lose detail.
 * `maxColors` is the raw unique-color ceiling; above it the quantized top-two coverage decides.
 * A null color count is reported as unknown, not refused.
 * @param {{ exe: string, input: string, cwd: string, signal?: AbortSignal, maxColors?: number }} opts
 * @returns {Promise<{ suitable: boolean, reason: string, colors: number|null, width: number, height: number, ratio: number, coverage: number|null }>}
 * @exports
 * @ai.hint io
 */
export async function assessVectorSuitability({ exe, input, cwd, signal, maxColors = 256 }) {
    let width = 0;
    let height = 0;
    try {
        const info = await magickIdentify({ exe, input, cwd, signal });
        width = info.width;
        height = info.height;
    } catch { /* an unreadable size stays 0 and is reported as unknown */ }
    const colors = await magickColorCount({ exe, input, cwd, signal });
    const ratio = width && height ? width / height : 0;
    if (!width || !height) return { suitable: false, reason: 'unreadable', colors, width, height, ratio, coverage: null };
    if (colors === null) return { suitable: true, reason: 'unknown', colors, width, height, ratio, coverage: null };
    if (colors <= maxColors) {
        return { suitable: true, reason: colors <= 8 ? 'flat' : 'limited-palette', colors, width, height, ratio, coverage: null };
    }
    const palette = await magickPaletteStats({ exe, input, cwd, signal });
    if (palette && palette.top2 >= 0.8) {
        return { suitable: true, reason: 'two-tone', colors, width, height, ratio, coverage: palette.top2 };
    }
    if (palette && palette.top4 >= 0.9) {
        return { suitable: true, reason: 'flat', colors, width, height, ratio, coverage: palette.top4 };
    }
    return { suitable: false, reason: 'too-many-colors', colors, width, height, ratio, coverage: palette?.top2 ?? null };
}

/**
 * Use a grayscale matte as the alpha channel of the image: white stays visible, black becomes
 * transparent, gray gives a soft edge. The matte is resized to the image frame, so a matte drawn
 * on a coarser grid still fits. A matte whose corners are white is inverted first: the background
 * is expected to be black, and a model occasionally returns the polarity the other way round.
 *
 * The matte is smoothed before it is applied (`feather` pixels of blur) and its extremes are
 * stretched to full black and full white. A model-drawn matte is rarely a clean gradient — it comes
 * back posterized or washed out — and without this the cut has stair-stepped edges and a halo.
 * @param {{ exe: string, input: string, mask: string, output?: string, cwd: string, signal?: AbortSignal, feather?: number }} opts
 * @returns {Promise<{ changed: boolean, reason: string, inverted?: boolean, feathered?: number, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickApplyAlphaMask({ exe, input, mask, output = input, cwd, signal, feather = 1 }) {
    const info = await magickIdentify({ exe, input, cwd, signal });
    if (!info.width || !info.height) return { changed: false, reason: 'unreadable' };
    const probe = await magickRun(exe, [mask, '-colorspace', 'Gray', '-format',
        '%[fx:mean] %[fx:(p{0,0}.intensity+p{w-1,0}.intensity+p{0,h-1}.intensity+p{w-1,h-1}.intensity)/4]', 'info:'], { cwd, signal });
    const [mean, corner] = probe.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(mean) || !Number.isFinite(corner)) return { changed: false, reason: 'unreadable' };
    if (mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (mean >= 0.995) return { changed: false, reason: 'full-mask' };
    const inverted = corner > 0.5;
    const blur = Number.isFinite(feather) ? Math.max(0, Math.min(8, feather)) : 1;
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    const suffix = path.extname(outPath) || '.png';
    const tmpPath = path.join(path.dirname(outPath), `.tmp-mask-${process.pid}-${Date.now()}${suffix}`);
    const args = [input, '(', mask, '-colorspace', 'Gray'];
    if (inverted) args.push('-negate');
    // Normalize first, then blur: stretching the matte keeps the interior solid while the blur
    // softens only the transition band.
    args.push('-auto-level');
    if (blur > 0) args.push('-gaussian-blur', `0x${blur}`);
    args.push('-resize', `${info.width}x${info.height}!`, ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', tmpPath);
    try {
        await magickRun(exe, args, { cwd, signal });
        await rename(tmpPath, outPath);
    } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
    }
    return { changed: true, reason: 'mask', inverted, feathered: blur, width: info.width, height: info.height };
}

/**
 * A painted transparency plate: a picture that imitates transparency with a checkerboard or a gray
 * grid instead of an alpha channel. Image models that cannot emit alpha draw exactly that.
 * The check reads two corner patches: a fake plate holds a handful of neutral tones (the number of
 * unique colors does not change when the patch is converted to grayscale), while a real background
 * is either one flat color or a colored, non-neutral picture.
 * @param {{ exe: string, input: string, cwd: string, signal?: AbortSignal, patch?: number }} opts
 * @returns {Promise<{ fake: boolean, reason: string, colors: number|null, mean: number|null }>}
 * @exports
 * @ai.hint io
 */
export async function magickDetectFakeTransparency({ exe, input, cwd, signal, patch = 16 }) {
    let info;
    try {
        info = await magickIdentify({ exe, input, cwd, signal });
    } catch {
        return { fake: false, reason: 'unreadable', colors: null, mean: null };
    }
    if (!info.width || !info.height) return { fake: false, reason: 'unreadable', colors: null, mean: null };
    const side = Math.max(4, Math.min(patch, info.width, info.height));
    const corners = [[0, 0], [Math.max(0, info.width - side), 0]];
    const samples = [];
    for (const [x, y] of corners) {
        const crop = `${side}x${side}+${x}+${y}`;
        const colorRes = await magickRun(exe, [input, '-alpha', 'off', '-crop', crop, '+repage', '-format', '%k %[fx:mean]', 'info:'], { cwd, signal }).catch(() => null);
        const grayRes = await magickRun(exe, [input, '-alpha', 'off', '-crop', crop, '+repage', '-colorspace', 'Gray', '-format', '%k', 'info:'], { cwd, signal }).catch(() => null);
        const [colors, mean] = String(colorRes?.stdout ?? '').trim().split(/\s+/).map(Number);
        const grayColors = Number(String(grayRes?.stdout ?? '').trim());
        if (!Number.isFinite(colors) || !Number.isFinite(mean) || !Number.isFinite(grayColors)) continue;
        samples.push({ colors, grayColors, mean });
    }
    if (!samples.length) return { fake: false, reason: 'unreadable', colors: null, mean: null };
    const neutral = (item) => item.colors >= 2 && item.colors <= 16 && item.colors === item.grayColors
        && item.mean >= 0.2 && item.mean <= 0.97;
    const hits = samples.filter(neutral);
    const first = samples[0];
    if (hits.length === samples.length) return { fake: true, reason: 'checkerboard', colors: first.colors, mean: first.mean };
    return { fake: false, reason: hits.length ? 'partly-neutral' : 'plain', colors: first.colors, mean: first.mean };
}

/**
 * Draw a matte from the object contour without any API request: the canny edges of the picture are
 * thickened into a closed barrier, painted over the source, and the background is flooded away from
 * all four corners. What stays opaque is the subject, and `-alpha extract` turns it into a grayscale
 * matte for `magickApplyAlphaMask`, so the RGB pixels of the source are never touched.
 * @param {{ exe: string, input: string, output: string, cwd: string, signal?: AbortSignal, close?: number, canny?: string, fuzz?: number, barrier?: string }} opts
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickContourAlphaMask({ exe, input, output, cwd, signal, close = 3, canny = '0x1+10%+30%', fuzz = 10, barrier = 'magenta' }) {
    const info = await magickIdentify({ exe, input, cwd, signal });
    if (!info.width || !info.height) return { changed: false, reason: 'unreadable' };
    const colorRes = await magickRun(exe, [input, '-format', '%[pixel:p{0,0}]', 'info:'], { cwd, signal }).catch(() => null);
    const color = String(colorRes?.stdout ?? '').trim();
    if (!color || /\bnone\b/i.test(color)) return { changed: false, reason: 'already' };
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    const corners = [
        [0, 0],
        [Math.max(0, info.width - 1), 0],
        [0, Math.max(0, info.height - 1)],
        [Math.max(0, info.width - 1), Math.max(0, info.height - 1)],
    ];
    const args = [input, '-alpha', 'set',
        '(', '-clone', '0', '-colorspace', 'Gray', '-canny', canny, '-morphology', 'Close', `Disk:${close}`,
        '-fuzz', `${fuzz}%`, '-transparent', 'black', '-fill', barrier, '-opaque', 'white', ')',
        '-compose', 'Over', '-composite',
        '-channel', 'RGBA', '-fuzz', `${fuzz}%`, '-fill', 'none'];
    for (const [x, y] of corners) args.push('-floodfill', `+${x}+${y}`, color);
    args.push('+channel', '-alpha', 'extract', output);
    try {
        await magickRun(exe, args, { cwd, signal });
    } catch (error) {
        await unlink(outPath).catch(() => {});
        throw error;
    }
    return await probeMatte({ exe, output, cwd, signal, width: info.width, height: info.height, reason: 'contour' });
}

/**
 * Draw a matte from color: an image model that cannot emit alpha paints a neutral checkerboard or a
 * gray plate behind the artwork, and saturation separates them — colored pixels are the subject,
 * neutral pixels become transparent. Only useful for that neutral-plate case; a black-and-white logo
 * has no saturation and is reported as an empty matte.
 * @param {{ exe: string, input: string, output: string, cwd: string, signal?: AbortSignal, threshold?: number }} opts
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickSaturationAlphaMask({ exe, input, output, cwd, signal, threshold = 15 }) {
    const info = await magickIdentify({ exe, input, cwd, signal });
    if (!info.width || !info.height) return { changed: false, reason: 'unreadable' };
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    try {
        await magickRun(exe, [input, '-alpha', 'off', '-colorspace', 'HSL', '-channel', 'G', '-separate', '+channel',
            '-threshold', `${threshold}%`, output], { cwd, signal });
    } catch (error) {
        await unlink(outPath).catch(() => {});
        throw error;
    }
    return await probeMatte({ exe, output, cwd, signal, width: info.width, height: info.height, reason: 'saturation' });
}

/**
 * Reject a matte that covers nothing or everything: either the barrier leaked or there is no
 * background to cut, and such a mask would eat the picture.
 * @param {{ exe: string, output: string, cwd: string, signal?: AbortSignal, width: number, height: number, reason: string }} opts
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number }>}
 * @ai.hint io
 */
async function probeMatte({ exe, output, cwd, signal, width, height, reason }) {
    const probe = await magickRun(exe, [output, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:'], { cwd, signal }).catch(() => null);
    const mean = Number(String(probe?.stdout ?? '').trim());
    if (!Number.isFinite(mean)) return { changed: false, reason: 'unreadable' };
    if (mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (mean >= 0.995) return { changed: false, reason: 'full-mask' };
    return { changed: true, reason, width, height };
}

/**
 * Make a saved image's flat background transparent, in place. Already transparent images are left alone.
 * The file is resolved to an absolute path first: ImageMagick runs with the file's directory as cwd,
 * so a relative path would otherwise be looked up inside that directory and fail.
 * JPEG cannot carry alpha, so it is reported instead of silently flattened.
 * This is the fallback path: `applyGeneratedAlphaMask` prefers a mask drawn by the model.
 * @param {{ file: string, magickPath?: string|null, signal?: AbortSignal, fuzz?: number }} opts
 * @returns {Promise<{ changed: boolean, reason: string, color?: string, error?: Error }>}
 * @exports
 * @ai.hint io
 */
export async function ensureTransparentBackground({ file, magickPath = null, signal, fuzz = 10 }) {
    const abs = path.resolve(file);
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return { changed: false, reason: 'format' };
    const exe = await detectMagick({ magickPath });
    if (!exe) return { changed: false, reason: 'no-magick' };
    const cwd = path.dirname(abs);
    const opaque = await magickIsOpaque({ exe, input: abs, cwd, signal }).catch(() => null);
    if (opaque === false) return { changed: false, reason: 'already' };
    if (opaque === null) return { changed: false, reason: 'unknown' };
    try {
        return await magickRemoveFlatBackground({ exe, input: abs, output: abs, cwd, signal, fuzz });
    } catch (error) {
        return { changed: false, reason: 'failed', error };
    }
}
