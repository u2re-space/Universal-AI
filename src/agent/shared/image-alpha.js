/**
 * @file src/agent/image-alpha.js
 * @module agent/image-alpha
 * @purpose Build a real alpha channel for a generated picture: paint the background with the
 *          subject color, draw an anti-aliased matte from the clean source, and merge the matte as alpha.
 * @depends node:path, node:fs/promises, agent/image-magick, openai/images
 * @usedBy commands/image, agent/image-tools
 * @exports ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask, hasRealAlpha, frameFor,
 *          judgeAlphaShares, clearedShare, softShare, askModel, isRaster, isFakePlate, localMatte,
 *          flatAlphaFallback
 * @ai.tags images, alpha, imagemagick
 * @ai.hint io
 * @changed 2026-10-23 Paint + anti-aliased matte pipeline; the matte is drawn from the clean source,
 *           never from the painted picture.
 * @changed 2026-11-05 A picture counts as already transparent only by its cleared share, so a painted
 *           plate with a translucent fringe runs the matte pipeline instead of being kept as is.
 */

import path from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, MASK_EXT, MAX_SOFT_SHARE, MIN_CLEARED_SHARE, MIN_SOFT_PIXELS, MODEL_MATES, RGB_SOURCE_EXT } from './constants.js';
import { detectMagick, ensureTransparentBackground, magickAlphaShare, magickAlphaSoftShare, magickApplyAlphaMask, magickContourAlphaMask, magickDetectFakeTransparency, magickIdentify, magickIsOpaque, magickSaturationAlphaMask } from './image-magick.js';
import { rasterAlphaShare, rasterAlphaSoftShare, rasterApplyAlphaMask, rasterColorKeyAlpha, rasterDetectFakeTransparency, rasterEngine, rasterInfo, rasterIsOpaque, rasterLocalAlphaMatte } from './image-raster.js';
import { isVectorModel, PROXY_IMAGE_EDIT_MODEL, imageModelProfile, sniffImage, normalizeImageSize } from '../../openai/images.js';
import { backgroundColor, frameFromFile } from '../../quantizer/kmeans.js';

/**
 * Cut a flat background locally, by the color the frame is resting on, with no model call at all.
 *
 * The plate color is read off the frame border, so nothing has to be told to the model and nothing
 * has to be asked of it: this is the cheap answer for a family that cannot emit alpha and paints a
 * plate instead. It cannot recover an edge the model blended into that plate — that is what the paint
 * pass exists for — which is why `auto` keeps the two-pass pipeline and this is the `key` mode.
 * @param {{ engine?: string, base: string, abs: string, cwd: string, signal?: AbortSignal, feather?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string, key?: { r: number, g: number, b: number } }>}
 * @exports
 * @ai.hint io
 */
export async function localKeyAlpha({ engine = 'auto', base, abs, cwd, signal, feather = 1 }) {
    const frame = await frameFromFile(base, { engine }).catch(() => null);
    if (!frame) return { changed: false, reason: 'unreadable' };
    const key = backgroundColor(frame, { alphaThreshold: 128, borderSamples: 512 });
    if (!key) return { changed: false, reason: 'no-plate-color' };
    return rasterColorKeyAlpha({ input: base, output: abs, key, cwd, signal, low: 16, high: 56, feather, engine });
}

/**
 * Cleared share of the frame (`1 - mean(alpha)`), measured by whichever engine is available.
 * @param {{ abs: string, cwd?: string, raster?: object|null, engine?: string, exe?: string|null, signal?: AbortSignal }} options
 * @returns {Promise<number|null>}
 * @ai.hint io
 */
export async function clearedShare({ abs, cwd = path.dirname(abs), raster = null, engine = 'auto', exe = null, signal }) {
    if (raster) return await rasterAlphaShare({ input: abs, cwd, engine }).catch(() => null);
    if (exe) return await magickAlphaShare({ exe, input: abs, cwd, signal });
    return null;
}

/**
 * Share of the frame whose alpha is neither cleared nor opaque — the width of the edge transition.
 * @param {{ abs: string, cwd?: string, raster?: object|null, engine?: string, exe?: string|null, signal?: AbortSignal }} options
 * @returns {Promise<number|null>}
 * @ai.hint io
 */
export async function softShare({ abs, cwd = path.dirname(abs), raster = null, engine = 'auto', exe = null, signal }) {
    if (raster) return await rasterAlphaSoftShare({ input: abs, cwd, engine }).catch(() => null);
    if (exe) return await magickAlphaSoftShare({ exe, input: abs, cwd, signal });
    return null;
}

/**
 * Judge an alpha channel the picture already carries.
 *
 * `magickIsOpaque` alone is not enough: it answers "not opaque" for a single semi-transparent
 * pixel, so a painted plate passes, and it says nothing about edge quality, so a matte drawn with
 * a wide glow passes too. Two shares settle it — how much of the frame is cleared, and how much of
 * it sits in the soft band. A null share means the engine could not measure, and the alpha is then
 * taken at its word rather than forcing a rebuild. `totalPixels` below MIN_SOFT_PIXELS skips the
 * soft check: a tiny frame gives a meaningless ratio.
 * @param {{ abs: string, cwd?: string, raster?: object|null, engine?: string, exe?: string|null, signal?: AbortSignal, totalPixels?: number }} options
 * @returns {Promise<{ usable: boolean, cleared: number|null, soft: number|null }>}
 * @ai.hint io
 */
export async function judgeAlphaShares(options) {
    const { totalPixels = Infinity } = options;
    const [cleared, rawSoft] = await Promise.all([clearedShare(options), softShare(options)]);
    const soft = totalPixels < MIN_SOFT_PIXELS ? null : rawSoft;
    const usable
        = (cleared === null || cleared >= MIN_CLEARED_SHARE)
        && (soft === null || soft <= MAX_SOFT_SHARE);
    return { usable, cleared, soft };
}

/**
 * Whether a saved picture carries a usable alpha channel: a real cut-out, not a painted plate and
 * not a genuine channel whose soft edge would leave a halo.
 * @param {{ abs: string, cwd?: string, raster?: object|null, engine?: string, exe?: string|null, signal?: AbortSignal }} options
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function hasRealAlpha(options) {
    const { abs, cwd = path.dirname(abs), raster = null, engine = 'auto', exe = null, signal } = options;
    const opaque = raster
        ? await rasterIsOpaque(abs, { cwd, engine }).catch(() => null)
        : exe ? await magickIsOpaque({ exe, input: abs, cwd, signal }).catch(() => null) : null;
    if (opaque !== false) return false;
    // Fetch frame dimensions so judgeAlphaShares can skip softShare for tiny images.
    let totalPixels = Infinity;
    if (raster) {
        const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
        if (info?.width && info?.height) totalPixels = info.width * info.height;
    } else if (exe) {
        const info = await magickIdentify({ exe, input: abs, cwd, signal }).catch(() => null);
        if (info?.width && info?.height) totalPixels = info.width * info.height;
    }
    return (await judgeAlphaShares({ abs, cwd, raster, engine, exe, signal, totalPixels })).usable;
}

/**
 * Pick the frame for a technical pass so the matte is not squeezed into a square.
 *
 * A model that takes an arbitrary frame (`customSizes`) gets the source frame exactly: the painted
 * picture this pass returns becomes the RGB base of the final file, so a preset frame here would
 * rescale the whole result to the preset and the caller would lose the source dimensions.
 * A preset-only model cannot take anything else, so the nearest frame that keeps the aspect wins.
 * @param {{ width: number, height: number }|null} info
 * @param {string|null} [model]
 * @returns {string|null}
 * @ai.hint pure
 */
export function frameFor(info, model = null) {
    if (!info?.width || !info?.height) return null;

    //
    const normalized = normalizeImageSize(`${info.width}x${info.height}`, null, model);
    if (normalized) return normalized;

    //
    if (imageModelProfile(model).customSizes) return `${info.width}x${info.height}`;
    if (info.width === info.height) return '1024x1024';

    const { width, height } = info;

    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        return null;
    }

    // Для квадратных изображений (или близкиз к тому) сохраняем квадратный формат.
    if (width === height || Math.max(width / height, height / width) < 1.005) {
        // Оба измерения не больше 512 — выбираем квадрат 512×512.
        if (width <= 512 && height <= 512) {
            return '512x512';
        }
        return '1024x1024';
    }

    if (height > width) {
        // Portrait: 768x1024 is 3:4, 1024x1536 is 2:3. The matte is resized onto the RGB base,
        // so the frame that keeps the source aspect is the one that must win — a stretched matte
        // puts alpha on the wrong pixels.
        return Math.abs(width / height - 3 / 4) <= Math.abs(width / height - 2 / 3)
            ? '768x1024'
            : '1024x1536';
    }

    // Landscape: 1024x768 is 4:3, 1536x1024 is 3:2. Same aspect-first rule as the portrait branch.
    return Math.abs(width / height - 4 / 3) <= Math.abs(width / height - 3 / 2)
        ? '1024x768'
        : '1536x1024';
}

/**
 * `image.maskModel` values that ask for the technical passes to run on the model that drew the
 * picture itself. A generator draws a cleaner matte than a cheap edit model — and for a family that
 * takes an arbitrary frame it also returns the matte in the exact source frame, so nothing is
 * stretched onto the RGB base. The price is a full generation per pass, so this is opt-in.
 */
const SELF_MASK_MODELS = new Set(['self', 'same', 'generator']);

/**
 * The model the paint pass and the matte pass are charged to.
 *
 * - a name in `image.maskModel` → that model, whatever generated the picture;
 * - `self` → the model that drew the picture (best edge, billed as extra generations);
 * - `null` → the family default: `preferGenerator` keeps the caller's raster model (gpt-image answers
 *   natively, so a matte is only built when it did not), while a family that always paints a plate
 *   falls back to `null` and lets its caller pick the cheap edit model instead.
 * @param {{ maskModel?: unknown, model?: string|null, imageModel?: string|null, preferGenerator?: boolean }} options
 * @returns {string|null} the model to use, or `null` when the caller decides its own default
 * @ai.hint pure
 */
export function maskPassModel({ maskModel = null, model = null, imageModel = null, preferGenerator = false }) {
    const requested = typeof maskModel === 'string' ? maskModel.trim() : '';
    const configured = imageModel && !isVectorModel(imageModel) ? imageModel : null;
    if (SELF_MASK_MODELS.has(requested.toLowerCase())) return model || configured || PROXY_IMAGE_EDIT_MODEL;
    if (requested) return requested;
    return preferGenerator ? (model || configured || PROXY_IMAGE_EDIT_MODEL) : null;
}

/**
 * Send one picture to the technical edit model and return the decoded reply when it is a readable
 * raster. Both the paint pass and the matte pass use this: they are technical requests, so they go
 * to `image.maskModel` (`self` = the model that drew the picture), then to the raster model the
 * caller already uses, and only then to the edit default — a vector model can never draw a matte.
 * `error` is set when the pass did not produce a readable raster, so the caller can report why the
 * model matte is missing instead of failing silently.
 * @param {{ client: object, config?: object|null, file: string, prompt: string, signal?: AbortSignal, model?: string|null }} options
 * @returns {Promise<{ bytes: Buffer, ext: string, mime: string, model: string }|{ error: Error }|null>}
 * @ai.hint io
 */
export async function askModel({ client, config = null, file, prompt, signal, model = null }) {
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
            size: frameFor(info, techModel),
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
export function isRaster(reply) { return Boolean(reply?.bytes); }

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
    // A frame the model already cleared may still be unusable: a plate leaves only a fringe, and a
    // matte drawn with a wide glow leaves a halo. Both go through the pipeline rather than staying.
    // softShare is meaningless for a tiny frame, so pass totalPixels.
    let totalPixels = Infinity;
    if (raster) {
        const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
        if (info?.width && info?.height) totalPixels = info.width * info.height;
    } else if (exe) {
        const info = await magickIdentify({ exe, input: abs, cwd, signal }).catch(() => null);
        if (info?.width && info?.height) totalPixels = info.width * info.height;
    }
    let softEdge = false;
    if (opaque === false) {
        const verdict = await judgeAlphaShares({ abs, cwd, raster, engine, exe, signal, totalPixels });
        if (verdict.usable) return { changed: false, reason: 'already' };
        softEdge = (verdict.cleared ?? 0) >= MIN_CLEARED_SHARE;
    }

    // The base for the matte: a clean RGB file when the caller named one, otherwise the saved picture.
    const base = alphaSource && RGB_SOURCE_EXT.test(path.extname(alphaSource).toLowerCase())
        ? path.resolve(cwd, alphaSource)
        : abs;
    const merged = {
        model: null,
        painted: false,
        source: base === abs ? null : path.relative(process.cwd(), base).split(path.sep).join('/'),
        // The reply did carry an alpha channel, just a soft-edged one, so the rebuild is a fix-up.
        ...(softEdge ? { softEdge: true } : {}),
    };
    /** Why the model passes did not deliver a matte; reported with the local fallback result. */
    let lastError = null;

    // 0. Key mode: the plate is removed by its own color, so the cut costs no generation at all.
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
export async function flatAlphaFallback({ raster, engine, file, cwd, signal, feather }) {
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
export async function isFakePlate({ raster, engine = 'auto', exe, base, cwd, signal }) {
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
export async function localMatte({ raster, engine = 'auto', exe, base, cwd, signal, fake = false }) {
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
