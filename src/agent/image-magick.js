/**
 * @file src/agent/image-magick.js
 * @module agent/image-magick
 * @purpose Detect ImageMagick and provide crop, split, resize, convert operations via CLI.
 * @depends node:path, node:fs/promises, agent/shell
 * @usedBy agent/tools
 * @exports detectMagick, magickCrop, magickSplit, magickResize, magickConvert, magickIdentify, magickIsOpaque, magickColorCount, magickPaletteStats, assessVectorSuitability, magickRemoveFlatBackground, ensureTransparentBackground
 * @ai.tags imagemagick, image, crop, split, alpha, vector
 * @ai.hint io
 * @changed 2026-10-22 Added the color count and the vector-suitability check; relative paths work in ensureTransparentBackground.
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
 * Make a saved image's flat background transparent, in place. Already transparent images are left alone.
 * The file is resolved to an absolute path first: ImageMagick runs with the file's directory as cwd,
 * so a relative path would otherwise be looked up inside that directory and fail.
 * JPEG cannot carry alpha, so it is reported instead of silently flattened.
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
