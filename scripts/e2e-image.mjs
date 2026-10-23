/**
 * Real-API probe of the four image stages. Credentials come from the environment or the project
 * `.env`; nothing is hardcoded. Run it when a key is available:
 *
 *   node scripts/e2e-image.mjs [source.png] [--model openai/gpt-image-2.5-sunburst] [--keep]
 *
 * Stages:
 *   1. source → image-to-image with `background: transparent` (native alpha when the model honors it)
 *   2. source → RGB painted with the subject color, then the same picture → soft grayscale matte
 *   3. RGB + matte → RGBA composition with ImageMagick
 *   4. RGBA → SVG with the vector model
 *
 * Artifacts stay in `.tmp/e2e-<stamp>/` unless `--keep` is absent, in which case the folder is
 * removed after a successful run. Exit code 0 means every stage produced a usable file.
 */

import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/core/config.js';
import { envValue, refreshRuntimeEnv, setLiveEnv } from '../src/core/runtime-env.js';
import { createFallbackClient } from '../src/openai/fallback.js';
import { runProgram } from '../src/agent/shell.js';
import { detectMagick, magickApplyAlphaMask, magickIdentify, magickIsOpaque } from '../src/agent/image-magick.js';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT } from '../src/agent/image-alpha.js';
import { PROXY_VECTOR_MODEL, sniffImage } from '../src/openai/images.js';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        model: { type: 'string' },
        vector: { type: 'string' },
        keep: { type: 'boolean', default: false },
        size: { type: 'string', default: '1024x1024' },
    },
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = process.cwd();
const dir = path.join(root, '.tmp', `e2e-${stamp}`);
const abs = (name) => path.join(dir, name);
const log = (step, text) => console.log(`[${step}] ${text}`);

/**
 * Run ImageMagick inside the artifact folder.
 * @param {string} exe
 * @param {string[]} args
 * @returns {Promise<import('node:child_process').SpawnSyncReturns<string>>}
 */
const magick = (exe, args) => runProgram({ file: exe, args, cwd: dir, timeoutMs: 120_000, maxOutputBytes: 65_536 });

/**
 * One pixel as `r,g,b,a`.
 * @param {string} exe
 * @param {string} file
 * @param {number} x
 * @param {number} y
 * @returns {Promise<number[]>}
 */
async function pixel(exe, file, x, y) {
    const res = await magick(exe, [file, '-format',
        `%[fx:round(255*p{${x},${y}}.r)],%[fx:round(255*p{${x},${y}}.g)],%[fx:round(255*p{${x},${y}}.b)],%[fx:round(255*p{${x},${y}}.a)]`, 'info:']);
    return res.stdout.trim().split(',').map(Number);
}

/**
 * Distinct gray levels, mean, and corner intensity of a matte.
 * @param {string} exe
 * @param {string} file
 * @returns {Promise<{ levels: number, mean: number, corner: number }>}
 */
async function matteStats(exe, file) {
    const res = await magick(exe, [file, '-colorspace', 'Gray', '-format',
        '%k %[fx:mean] %[fx:(p{0,0}.intensity+p{w-1,0}.intensity+p{0,h-1}.intensity+p{w-1,h-1}.intensity)/4]', 'info:']);
    const [levels, mean, corner] = res.stdout.trim().split(/\s+/).map(Number);
    return { levels, mean, corner };
}

/**
 * Save the first base64 payload next to the other artifacts.
 * @param {string[]} payloads
 * @param {string} name
 * @returns {Promise<{ file: string, kind: { ext: string, mime: string }, bytes: Buffer }>}
 */
async function save(payloads, name) {
    const bytes = Buffer.from(payloads[0], 'base64');
    const kind = sniffImage(bytes);
    const file = abs(`${name}.${kind.ext}`);
    await writeFile(file, bytes);
    return { file, kind, bytes };
}

async function main() {
    const exe = await detectMagick();
    if (!exe) throw new Error('ImageMagick не найден: установите magick и повторите запуск.');

    // Credentials come from .env or the environment — never from the script.
    const env = await refreshRuntimeEnv({ cwd: root });
    setLiveEnv(env);
    if (!envValue('OPENAI_API_KEY') && !envValue('AI_FALLBACK_API_KEY') && !envValue('SPRUTDOCK_API_KEY')) {
        throw new Error('Нет ключа: задайте OPENAI_API_KEY или AI_FALLBACK_API_KEY в .env либо в окружении.');
    }
    const config = await loadConfig({ env, ensureHome: false });
    const model = values.model || config.imageModel || 'openai/gpt-image-2.5-sunburst';
    const vectorModel = values.vector || config.image.vectorModel || PROXY_VECTOR_MODEL;
    const client = createFallbackClient(config);
    await mkdir(dir, { recursive: true });

    log('setup', `каталог ${path.relative(root, dir)}`);
    log('setup', `модель ${model}, вектор ${vectorModel}, хост ${config.baseURL}`);

    // The source is either the file given on the command line or a generated flat mark.
    let source = positionals[0] ? path.resolve(root, positionals[0]) : null;
    if (!source) {
        source = abs('src.png');
        await magick(exe, ['-size', values.size, 'xc:white',
            '-fill', '#1E3A8A', '-draw', 'circle 512,512 512,190',
            '-fill', '#F59E0B', '-draw', 'polygon 512,300 700,700 324,700',
            '-fill', 'white', '-draw', 'rectangle 470,470 554,700',
            'src.png']);
        log('setup', 'источник сгенерирован локально: src.png (синий круг, янтарный треугольник, белая полоса)');
    }
    const srcBytes = await readFile(source);
    const srcKind = sniffImage(srcBytes);
    const srcFile = { filename: path.basename(source), mime: srcKind.mime, bytes: srcBytes };
    log('setup', `источник ${path.relative(root, source)} (${srcKind.ext}, ${srcBytes.length} bytes)`);

    const result = { dir: path.relative(root, dir), model, vectorModel, stages: {} };

    // --- Stage 1: image-to-image with a transparent background.
    log('1', 'image-to-image с background=transparent');
    const native = await save(await client.images.edit({
        model,
        prompt: 'Recreate this flat logo exactly: same shapes, same colors, same proportions, centered, '
            + 'no text, no shadow, no gradient, transparent background.',
        size: values.size, format: 'png', background: 'transparent', files: [srcFile],
    }), '1-native');
    const nativeOpaque = await magickIsOpaque({ exe, input: native.file, cwd: dir });
    const nativeCorner = await pixel(exe, native.file, 4, 4);
    result.stages.native = { file: path.basename(native.file), nativeAlpha: nativeOpaque === false, corner: nativeCorner };
    log('1', `${path.basename(native.file)}: настоящая прозрачность ${nativeOpaque === false ? 'ДА' : 'НЕТ'}, угол ${JSON.stringify(nativeCorner)}`);

    // --- Stage 2a: paint the background with the subject color.
    log('2a', 'заливка фона доминирующим цветом объекта');
    const painted = await save(await client.images.edit({
        model, prompt: BACKGROUND_PAINT_PROMPT, size: values.size, format: 'png', files: [srcFile],
    }), '2a-painted');
    const paintedCorner = await pixel(exe, painted.file, 4, 4);
    result.stages.painted = { file: path.basename(painted.file), corner: paintedCorner };
    log('2a', `${path.basename(painted.file)}: угол ${JSON.stringify(paintedCorner)}`);

    // --- Stage 2b: a soft grayscale matte drawn from the clean source.
    log('2b', 'anti-aliased grayscale-маска по чистому src');
    const matte = await save(await client.images.edit({
        model, prompt: ALPHA_MASK_PROMPT, size: values.size, format: 'png',
        files: [{ filename: 'src.png', mime: srcKind.mime, bytes: srcBytes }],
    }), '2b-matte');
    const stats = await matteStats(exe, matte.file);
    result.stages.matte = { file: path.basename(matte.file), levels: stats.levels, mean: Number(stats.mean.toFixed(3)), corner: Number(stats.corner.toFixed(3)) };
    log('2b', `${path.basename(matte.file)}: уровней серого ${stats.levels}, mean ${stats.mean.toFixed(3)}, угол ${stats.corner.toFixed(3)}`);

    // --- Stage 3: compose RGB + matte into RGBA.
    log('3', 'композиция RGB и маски в RGBA');
    const composed = await magickApplyAlphaMask({
        exe, input: painted.file, mask: matte.file, output: abs('3-rgba.png'), cwd: dir, feather: config.image.alphaFeather ?? 1,
    });
    const rgbaFile = composed.changed ? abs('3-rgba.png') : painted.file;
    const rgbaCorner = await pixel(exe, rgbaFile, 4, 4);
    const rgbaCenter = await pixel(exe, rgbaFile, 512, 512);
    result.stages.rgba = { file: path.basename(rgbaFile), changed: composed.changed, reason: composed.reason, corner: rgbaCorner, center: rgbaCenter };
    log('3', `${path.basename(rgbaFile)}: changed=${composed.changed} reason=${composed.reason} угол ${JSON.stringify(rgbaCorner)} центр ${JSON.stringify(rgbaCenter)}`);

    // --- Stage 4: vectorize the cut-out.
    log('4', `векторизация через ${vectorModel}`);
    const rgba = await readFile(rgbaFile);
    const vector = await save(await client.images.vectorize({
        model: vectorModel,
        prompt: 'Vectorize the attached logo exactly: flat shapes, smooth paths, transparent background, '
            + 'keep the palette and the proportions; do not redesign it or add text.',
        image: { mime: 'image/png', bytes: rgba, filename: 'rgba.png' },
    }), '4-vector');
    const svgHead = vector.bytes.subarray(0, 64).toString('utf8').replace(/\s+/g, ' ').trim();
    result.stages.svg = { file: path.basename(vector.file), isSvg: vector.kind.ext === 'svg', bytes: vector.bytes.length };
    log('4', `${path.basename(vector.file)}: ${vector.kind.ext}, ${vector.bytes.length} bytes, ${svgHead.slice(0, 48)}`);

    const ok = result.stages.svg.isSvg
        && result.stages.matte.levels >= 2
        && result.stages.rgba.changed
        && result.stages.rgba.corner[3] === 0;
    console.log('\n=== ИТОГ ===');
    console.log(JSON.stringify({ ...result, ok }, null, 2));

    client.close();
    if (ok && !values.keep) {
        await rm(dir, { recursive: true, force: true });
        console.log(`Артефакты удалены; повторите с --keep, чтобы сохранить ${result.dir}.`);
    } else {
        console.log(`Артефакты: ${result.dir}`);
    }
    if (!ok) process.exitCode = 1;
}

main().catch((error) => {
    console.error('ОШИБКА:', error?.stack ?? error?.message ?? error);
    process.exitCode = 1;
});
