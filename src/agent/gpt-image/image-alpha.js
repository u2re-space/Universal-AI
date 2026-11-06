/**
 * @file src/agent/image-alpha.js
 * @module agent/image-alpha
 * @purpose Build a real alpha channel for a generated picture: paint the background with the
 *          subject color, draw an anti-aliased matte from the clean source, and merge the matte as alpha.
 * @depends node:path, node:fs/promises, agent/image-magick, openai/images
 * @usedBy commands/image, agent/image-tools
 * @exports ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask
 * @ai.tags images, alpha, imagemagick
 * @ai.hint io
 * @changed 2026-10-23 Paint + anti-aliased matte pipeline; the matte is drawn from the clean source,
 *           never from the painted picture.
 * @changed 2026-11-06 `alphaMode: 'key'` cuts the flat plate locally through the shared key helper,
 *           so the mode means the same thing in both model families and costs no generation.
 */

import path from 'node:path';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, MASK_EXT, MAX_SOFT_SHARE, MIN_CLEARED_SHARE, MIN_SOFT_PIXELS, MODEL_MATES, RGB_SOURCE_EXT } from '../shared/constants.js';
export { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT } from '../shared/constants.js';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { detectMagick, ensureTransparentBackground, magickApplyAlphaMask, magickContourAlphaMask, magickDetectFakeTransparency, magickIdentify, magickIsOpaque, magickSaturationAlphaMask } from '../shared/image-magick.js';
import { rasterApplyAlphaMask, rasterDetectFakeTransparency, rasterEngine, rasterInfo, rasterIsOpaque, rasterLocalAlphaMatte } from '../shared/image-raster.js';
import { isVectorModel, PROXY_IMAGE_EDIT_MODEL, sniffImage } from '../../openai/images.js';
import { hasRealAlpha as hasUsableAlpha } from '../riverflow/image-alpha.js';
import { frameFor, localKeyAlpha, maskPassModel } from '../shared/image-alpha.js';

/**
 * Pick the frame that keeps the source aspect ratio, so the matte is not squeezed into a square.
 * @param {{ width: number, height: number }|null} info
 * @returns {string|null}
 * @ai.hint pure
 */
/*function frameFor(info) {
    if (!info?.width || !info?.height) return null;
    if (info.width === info.height) return '1024x1024';
    return info.height > info.width ? '1024x1536' : '1536x1024';
}*/

/**
 * Send one picture to the technical edit model and return the decoded reply when it is a readable
 * raster. Both the paint pass and the matte pass use this: they are technical requests, so they go
 * to `image.maskModel`, then to the raster model the caller already uses, and only then to the edit
 * default — a vector model can never draw a matte.
 * `error` is set when the pass did not produce a readable raster, so the caller can report why the
 * model matte is missing instead of failing silently.
 * @param {{ client: object, config?: object|null, file: string, prompt: string, signal?: AbortSignal, model?: string|null }} options
 * @returns {Promise<{ bytes: Buffer, ext: string, mime: string, model: string }|{ error: Error }|null>}
 * @ai.hint io
 */
async function askModel({ client, config = null, file, prompt, signal, model = null }) {
    const abs = path.resolve(file);
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) return null;
    const kind = sniffImage(bytes);
    const engine = config?.image?.rasterEngine ?? 'auto';
    const raster = engine !== 'magick' ? await rasterEngine(engine) : null;
    const exe = raster ? null : await detectMagick({ magickPath: config?.magickPath ?? null });
    const info = raster
        ? await rasterInfo(abs, { cwd: path.dirname(abs), engine }).catch(() => null)
        : exe ? await magickIdentify({ exe, input: abs, cwd: path.dirname(abs), signal }).catch(() => null) : null;
    const techModel = maskPassModel({ maskModel: config?.image?.maskModel, model, imageModel: config?.imageModel, preferGenerator: true });
    try {
        const payloads = await client.images.edit({
            model: techModel,
            prompt,
            size: frameFor(info),
            format: 'png',
            signal,
            files: [{ filename: path.basename(abs), mime: kind.mime, bytes }],
        });
        const reply = Buffer.from(payloads[0], 'base64');
        const out = sniffImage(reply);
        if (!MASK_EXT.test(`.${out.ext}`)) return { error: new Error(`модель вернула не растр (${out.ext})`) };
        return { bytes: reply, ext: out.ext, mime: out.mime, model: techModel };
    } catch (error) {
        return { error };
    }
}

/**
 * Distinguish a raster reply from a failed pass.
 * @param {{ bytes?: Buffer }|{ error?: Error }|null} reply
 * @returns {boolean}
 * @ai.hint pure
 */
const isRaster = (reply) => Boolean(reply?.bytes);

/**
 * Build a real alpha channel for a saved picture.
 *
 * The pipeline, in order:
 * 1. Paint the background with the dominant color of the subject (model pass). An anti-aliased matte
 *    always leaves semi-transparent pixels along the edge; over a white or checkerboard plate those
 *    pixels keep the plate color and read as a halo, over the subject color they disappear.
 * 2. Draw the matte from the same clean source (model pass). The matte is the geometry of the
 *    subject, so it must come from the source pixels: a painted picture may have shifted or
 *    repainted the edge, and a matte taken from it would then not match the artwork.
 * 3. Merge the matte into the painted picture as alpha, keeping the anti-aliased edge.
 * 4. When a pass is unavailable, fall back to the local contour matte, then to the corner flood fill.
 *
 * `alphaSource` names the clean RGB base — the reference, the measurement crop, or the pre-upscale
 * file — so the alpha is never derived from an image that already carries a fake transparency plate.
 * @param {{ client?: object|null, config?: object|null, file: string, signal?: AbortSignal, model?: string|null, alphaSource?: string|null, paintBackground?: boolean, feather?: number, alphaMode?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, model?: string, inverted?: boolean, painted?: boolean, source?: string, error?: Error }>}
 * @exports
 * @ai.hint io
 */
export async function applyGeneratedAlphaMask({
    client = null,
    config = null,
    file,
    signal,
    model = null,
    alphaSource = null,
    paintBackground = config?.image?.paintBackground !== false,
    feather = config?.image?.alphaFeather ?? 1,
    alphaMode = config?.image?.alphaMode ?? 'auto',
}) {
    if (alphaMode === 'off') return { changed: false, reason: 'off' };
    const abs = path.resolve(file);
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return { changed: false, reason: 'format' };
    const engine = config?.image?.rasterEngine ?? 'auto';
    const raster = engine !== 'magick' ? await rasterEngine(engine) : null;
    const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
    if (!raster && !exe) return { changed: false, reason: 'no-raster-engine' };
    const cwd = path.dirname(abs);
    const opaque = raster
        ? await rasterIsOpaque(abs, { cwd, engine })
        : await magickIsOpaque({ exe, input: abs, cwd, signal }).catch(() => null);
    if (opaque === null) return { changed: false, reason: 'unknown' };
    let softEdge = false;
    if (opaque === false) {
        if (await hasUsableAlpha({ abs, cwd, raster, engine, exe, signal })) {
            return { changed: false, reason: 'already' };
        }
        softEdge = true;
    }

    // The base for the matte: a clean RGB file when the caller named one, otherwise the saved picture.
    const base = alphaSource && RGB_SOURCE_EXT.test(path.extname(alphaSource).toLowerCase())
        ? path.resolve(cwd, alphaSource)
        : abs;
    const merged = {
        model: null,
        painted: false,
        source: base === abs ? null : path.relative(process.cwd(), base).split(path.sep).join('/'),
        ...(softEdge ? { softEdge: true } : {}),
    };
    /** Why the model passes did not deliver a matte; reported with the local fallback result. */
    let lastError = null;

    // 0. Key mode: cut the flat plate locally, zero extra generations (same helper as riverflow).
    if (alphaMode === 'key' && raster) {
        const keyed = await localKeyAlpha({ engine, base, abs, cwd, signal, feather });
        if (keyed.changed) return { ...merged, ...keyed, reason: 'key', model: merged.model };
        lastError = keyed.error ?? lastError;
    }

    // 1. Paint pass: the background takes the subject color, the subject itself stays untouched.
    let paintedPath = null;
    if (MODEL_MATES.has(alphaMode) && paintBackground && client?.images) {
        const painted = await askModel({ client, config, file: base, prompt: BACKGROUND_PAINT_PROMPT, signal, model });
        if (isRaster(painted)) {
            paintedPath = path.join(cwd, `.tmp-alpha-painted-${process.pid}-${Date.now()}.png`);
            await writeFile(paintedPath, painted.bytes);
            merged.model = painted.model;
            merged.painted = true;
        } else {
            lastError = painted?.error ?? lastError;
        }
    }
    const matteBase = paintedPath || base;
    try {
        // 2. The model matte from the clean source, then the local contour matte, then the corner fill.
        // The matte is the geometry of the subject: it is drawn from `base`, never from the painted
        // picture, whose edge the paint pass may have moved or repainted.
        if (MODEL_MATES.has(alphaMode) && client?.images) {
            const matte = await askModel({ client, config, file: base, prompt: ALPHA_MASK_PROMPT, signal, model });
            if (isRaster(matte)) {
                const maskPath = path.join(cwd, `.tmp-alpha-mask-${process.pid}-${Date.now()}.${matte.ext}`);
                await writeFile(maskPath, matte.bytes);
                try {
                    // The alpha is applied to the painted picture, so the anti-aliased rim carries the
                    // subject color instead of the plate color; without a paint pass the source is used.
                    const applied = raster
                        ? await rasterApplyAlphaMask({ input: matteBase, mask: maskPath, output: abs, cwd, signal, feather, engine })
                        : await magickApplyAlphaMask({ exe, input: matteBase, mask: maskPath, output: abs, cwd, signal, feather });
                    // A fully white matte means the model found nothing to cut: keep the picture as it is
                    // instead of letting the corner fill eat a corner of the subject.
                    if (applied.reason === 'full-mask') return { changed: false, reason: 'opaque', model: matte.model };
                    if (applied.changed) return { ...merged, ...applied, model: matte.model };
                } finally {
                    await unlink(maskPath).catch(() => {});
                }
            } else {
                lastError = matte?.error ?? lastError;
            }
        }

        if (alphaMode !== 'mask') {
            const local = await localMatte({
                raster, engine, exe, base: matteBase, cwd, signal,
                fake: await isFakePlate({ raster, engine, exe, base: matteBase, cwd, signal }),
            });
            if (local) {
                let applied = null;
                if (raster) {
                    applied = await rasterApplyAlphaMask({ input: matteBase, mask: local.mask, output: abs, cwd, signal, feather, engine });
                } else if (exe) {
                    applied = await magickApplyAlphaMask({ exe, input: matteBase, mask: local.mask, output: abs, cwd, signal, feather });
                }
                await unlink(local.mask).catch(() => {});
                if (applied?.changed) return { ...merged, ...applied, reason: local.reason, model: merged.model, error: lastError };
            }
        }
    } finally {
        if (paintedPath) await unlink(paintedPath).catch(() => {});
    }

    if (raster) {
        const flat = await flatAlphaFallback({ raster, engine, file: abs, cwd, signal, feather });
        return { ...merged, ...flat, reason: flat.changed ? 'flat' : flat.reason, error: lastError ?? flat.error };
    }
    const flat = await ensureTransparentBackground({ file: abs, magickPath: config?.magickPath ?? null, signal });
    return { ...merged, ...flat, reason: flat.changed ? 'flat' : flat.reason, error: lastError ?? flat.error };
}

/**
 * Remove a flat background without an API request and without ImageMagick: the four-corner flood
 * matte is written to a temporary file and merged as alpha, then removed.
 * @param {{ raster: string, engine: string, file: string, cwd: string, signal?: AbortSignal, feather: number }} options
 * @returns {Promise<{ changed: boolean, reason: string }>}
 * @ai.hint io
 */
async function flatAlphaFallback({ raster, engine, file, cwd, signal, feather }) {
    const mask = path.join(cwd, `.tmp-alpha-flat-${process.pid}-${Date.now()}.png`);
    try {
        const built = await rasterLocalAlphaMatte({ input: file, output: mask, cwd, signal, mode: 'contour', engine });
        if (!built.changed) return { changed: false, reason: built.reason };
        const applied = await rasterApplyAlphaMask({ input: file, mask, output: file, cwd, signal, feather, engine });
        return { changed: applied.changed, reason: applied.reason };
    } catch {
        return { changed: false, reason: 'failed' };
    } finally {
        await unlink(mask).catch(() => {});
    }
}

/**
 * True when the picture imitates transparency with a neutral checkerboard or a gray plate instead of
 * carrying an alpha channel. Such a file must never be used as the RGB base, and its matte has to be
 * drawn from saturation rather than from a corner color.
 * @param {{ raster?: string|null, engine?: string, exe?: string|null, base: string, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function isFakePlate({ raster, engine = 'auto', exe, base, cwd, signal }) {
    if (raster) {
        const local = await rasterDetectFakeTransparency({ input: base, cwd, engine, signal }).catch(() => null);
        if (local) return local.fake;
    }
    if (!exe) return false;
    const check = await magickDetectFakeTransparency({ exe, input: base, cwd, signal }).catch(() => null);
    return Boolean(check?.fake);
}

/**
 * Draw a matte without an API request. Prefers the local raster engine (sharp/node-canvas) and falls
 * back to ImageMagick when both native engines are unavailable. A painted checkerboard is separated
 * by saturation (the plate is neutral, the artwork is not); any other flat plate is separated by its
 * own contour. When the first choice covers nothing, the other one is tried.
 * @param {{ raster?: string|null, engine?: string, exe?: string|null, base: string, cwd: string, signal?: AbortSignal, fake?: boolean }} options
 * @returns {Promise<{ mask: string, reason: string }|null>}
 * @ai.hint io
 */
async function localMatte({ raster, engine = 'auto', exe, base, cwd, signal, fake = false }) {
    const order = fake
        ? [['saturation', raster ? rasterLocalAlphaMatte : magickSaturationAlphaMask], ['contour', raster ? rasterLocalAlphaMatte : magickContourAlphaMask]]
        : [['contour', raster ? rasterLocalAlphaMatte : magickContourAlphaMask], ['saturation', raster ? rasterLocalAlphaMatte : magickSaturationAlphaMask]];
    for (const [reason, make] of order) {
        const mask = path.join(cwd, `.tmp-alpha-${reason}-${process.pid}-${Date.now()}.png`);
        try {
            const built = raster
                ? await make({ input: base, output: mask, cwd, signal, mode: reason, engine })
                : await make({ exe, input: base, output: mask, cwd, signal });
            if (built.changed) return { mask, reason };
            await unlink(mask).catch(() => {});
        } catch {
            await unlink(mask).catch(() => {});
        }
    }
    return null;
}
