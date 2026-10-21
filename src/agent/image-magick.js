/**
 * @file src/agent/image-magick.js
 * @module agent/image-magick
 * @purpose Detect ImageMagick and provide crop, split, resize, convert operations via CLI.
 * @depends node:path, node:fs/promises, agent/shell
 * @usedBy agent/tools
 * @exports detectMagick, magickCrop, magickSplit, magickResize, magickConvert, magickIdentify
 * @ai.tags imagemagick, image, crop, split
 * @ai.hint io
 * @changed 2026-10-22 Initial implementation.
 */

import path from 'node:path';
import { stat, mkdir } from 'node:fs/promises';
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
