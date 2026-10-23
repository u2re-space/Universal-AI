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
 */

import path from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { detectMagick, ensureTransparentBackground, magickApplyAlphaMask, magickContourAlphaMask, magickDetectFakeTransparency, magickIdentify, magickIsOpaque, magickSaturationAlphaMask } from './image-magick.js';
import { isVectorModel, PROXY_IMAGE_EDIT_MODEL, sniffImage } from '../openai/images.js';

/**
 * Prompt for the mask pass. A matte rather than a transparent picture: most vendors cannot emit
 * alpha and paint a checkerboard or a flat plate instead, and a matte converts cleanly into a real
 * alpha channel. The matte must be anti-aliased: a one- or two-pixel gray transition along the
 * silhouette is what keeps the cut free of stair-stepping, while a wide soft gradient would make
 * the rim milky and eat into the artwork.
 */
export const ALPHA_MASK_PROMPT = 'Return an alpha matte of the attached image as a grayscale picture. '
    + 'White marks the subject that must stay visible (the artwork, logo, product, or person); '
    + 'black marks everything that must become transparent, including a checkerboard, grid, or flat '
    + 'plate that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Edges must be anti-aliased: a one- or two-pixel gray transition exactly on the silhouette, '
    + 'not a wide soft glow, and the interior of the subject pure white. '
    + 'Output the matte only: grayscale, no colors, no text, no border, no shadow.';

/**
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same '
    + 'proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or '
    + 'pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';

/** Raster matte formats ImageMagick can read. */
const MASK_EXT = /\.(png|webp|jpe?g)$/i;

/** Extensions that can carry a clean RGB source (no alpha, no fake plate). */
const RGB_SOURCE_EXT = /\.(png|webp)$/i;

/** Alpha modes that run model passes (paint + matte). */
const MODEL_MATES = new Set(['auto', 'mask']);

/**
 * Pick the frame that keeps the source aspect ratio, so the matte is not squeezed into a square.
 * @param {{ width: number, height: number }|null} info
 * @returns {string|null}
 * @ai.hint pure
 */
function frameFor(info) {
    if (!info?.width || !info?.height) return null;
    if (info.width === info.height) return '1024x1024';
    return info.height > info.width ? '1024x1536' : '1536x1024';
}

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
    const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
    const info = exe ? await magickIdentify({ exe, input: abs, cwd: path.dirname(abs), signal }).catch(() => null) : null;
    const configured = config?.imageModel && !isVectorModel(config.imageModel) ? config.imageModel : null;
    const techModel = model || config?.image?.maskModel || configured || PROXY_IMAGE_EDIT_MODEL;
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
    const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
    if (!exe) return { changed: false, reason: 'no-magick' };
    const cwd = path.dirname(abs);
    const opaque = await magickIsOpaque({ exe, input: abs, cwd, signal }).catch(() => null);
    if (opaque === false) return { changed: false, reason: 'already' };
    if (opaque === null) return { changed: false, reason: 'unknown' };

    // The base for the matte: a clean RGB file when the caller named one, otherwise the saved picture.
    const base = alphaSource && RGB_SOURCE_EXT.test(path.extname(alphaSource).toLowerCase())
        ? path.resolve(cwd, alphaSource)
        : abs;
    const merged = {
        model: null,
        painted: false,
        source: base === abs ? null : path.relative(process.cwd(), base).split(path.sep).join('/'),
    };
    /** Why the model passes did not deliver a matte; reported with the local fallback result. */
    let lastError = null;

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
                const applied = await magickApplyAlphaMask({ exe, input: matteBase, mask: maskPath, output: abs, cwd, signal, feather });
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
        const local = await localMatte({ exe, base: matteBase, cwd, signal, fake: await isFakePlate({ exe, base: matteBase, cwd, signal }) });
        if (local) {
            const applied = await magickApplyAlphaMask({ exe, input: matteBase, mask: local.mask, output: abs, cwd, signal, feather });
            await unlink(local.mask).catch(() => {});
            if (applied.changed) return { ...merged, ...applied, reason: local.reason, model: merged.model, error: lastError };
        }
    }

    if (paintedPath) await unlink(paintedPath).catch(() => {});
    const flat = await ensureTransparentBackground({ file: abs, magickPath: config?.magickPath ?? null, signal });
    return { ...merged, ...flat, reason: flat.changed ? 'flat' : flat.reason, error: lastError ?? flat.error };
}

/**
 * True when the picture imitates transparency with a neutral checkerboard or a gray plate instead of
 * carrying an alpha channel. Such a file must never be used as the RGB base, and its matte has to be
 * drawn from saturation rather than from a corner color.
 * @param {{ exe: string, base: string, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function isFakePlate({ exe, base, cwd, signal }) {
    const check = await magickDetectFakeTransparency({ exe, input: base, cwd, signal }).catch(() => null);
    return Boolean(check?.fake);
}

/**
 * Draw a matte without an API request. A painted checkerboard is separated by saturation (the plate
 * is neutral, the artwork is not); any other flat plate is separated by its own contour. When the
 * first choice covers nothing, the other one is tried.
 * @param {{ exe: string, config?: object|null, base: string, cwd: string, signal?: AbortSignal, fake?: boolean }} options
 * @returns {Promise<{ mask: string, reason: string }|null>}
 * @ai.hint io
 */
async function localMatte({ exe, base, cwd, signal, fake = false }) {
    const order = fake
        ? [['saturation', magickSaturationAlphaMask], ['contour', magickContourAlphaMask]]
        : [['contour', magickContourAlphaMask], ['saturation', magickSaturationAlphaMask]];
    for (const [reason, make] of order) {
        const mask = path.join(cwd, `.tmp-alpha-${reason}-${process.pid}-${Date.now()}.png`);
        try {
            const built = await make({ exe, input: base, output: mask, cwd, signal });
            if (built.changed) return { mask, reason };
            await unlink(mask).catch(() => {});
        } catch {
            await unlink(mask).catch(() => {});
        }
    }
    return null;
}
