/**
 * @file src/agent/riverflow/image-alpha.js
 * @module agent/riverflow/image-alpha
 * @purpose Riverflow-specific alpha pipeline: the background color for the paint pass is picked
 *          locally (the model picks "whatever" for this family), so the plate is a known flat color.
 *          The matte still comes from the model, then from the local contour fallback.
 * @ai.tags images, riverflow, alpha, color-pick
 * @ai.hint io
 */

import path from 'node:path';
import { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, MODEL_MATES, RGB_SOURCE_EXT, paintPromptWithColor } from '../shared/constants.js';
export { ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, paintPromptWithColor } from '../shared/constants.js';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { detectMagick, ensureTransparentBackground, magickApplyAlphaMask, magickIdentify, magickIsOpaque } from '../shared/image-magick.js';
import { rasterApplyAlphaMask, rasterEngine, rasterInfo, rasterIsOpaque } from '../shared/image-raster.js';
import { PROXY_IMAGE_EDIT_MODEL } from '../../openai/images.js';
import { dominantSubjectColorFromFile } from '../../quantizer/kmeans.js';
import { frameFor, judgeAlphaShares, askModel, isRaster, isFakePlate, localMatte, localKeyAlpha, flatAlphaFallback, maskPassModel } from '../shared/image-alpha.js';

/**
 * Apply alpha with a riverflow-specific pipeline:
 *
 * 1. **Color pick** — the dominant color of the subject is computed locally from the clean source,
 *    excluding the flat plate that the picture rests on, so the model paints with the correct color.
 * 2. **Paint pass** — the background is painted with that exact hex color.
 * 3. **Model matte** — the geometry of the subject (the model's best cut-out).
 * 4. **Fallback** — local contour matte → flat fallback.
 *
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

    // Quick opaque check.
    const opaque = raster
        ? await rasterIsOpaque(abs, { cwd, engine })
        : await magickIsOpaque({ exe, input: abs, cwd, signal }).catch(() => null);
    if (opaque === null) return { changed: false, reason: 'unknown' };
    if (opaque === false) {
        let totalPixels = Infinity;
        if (raster) {
            const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
            if (info?.width && info?.height) totalPixels = info.width * info.height;
        } else if (exe) {
            const info = await magickIdentify({ exe, input: abs, cwd, signal }).catch(() => null);
            if (info?.width && info?.height) totalPixels = info.width * info.height;
        }
        const verdict = await judgeAlphaShares({ abs, cwd, raster, engine, exe, signal, totalPixels });
        if (verdict.usable) return { changed: false, reason: 'already' };
    }

    const base = alphaSource && RGB_SOURCE_EXT.test(path.extname(alphaSource).toLowerCase())
        ? path.resolve(cwd, alphaSource)
        : abs;

    const merged = {
        model: null,
        painted: false,
        source: base === abs ? null : path.relative(process.cwd(), base).split(path.sep).join('/'),
    };
    let lastError = null;

    // 0. Key mode: cut the flat plate locally, zero extra generations (same helper as the shared tract).
    if (alphaMode === 'key' && raster) {
        const keyed = await localKeyAlpha({ engine, base, abs, cwd, signal, feather });
        if (keyed.changed) return { ...merged, ...keyed, reason: 'key', model: merged.model };
        lastError = keyed.error ?? lastError;
    }

    // 1. Local color pick — the dominant color of the subject, with the plate left out of the vote.
    // Used only in the paint pass to give the model an explicit hex target.
    const hex = await dominantSubjectColorFromFile(base, { k: 3, alphaThreshold: 128, maxSamples: 4096 })
        .catch(() => null);
    if (hex) merged.backgroundColor = hex;
    const paintPrompt = hex ? paintPromptWithColor(hex) : BACKGROUND_PAINT_PROMPT;

    // Technical model: a named `image.maskModel`, or `self` to run the passes on riverflow itself
    // (better edges, billed as full generations), otherwise the cheap edit default. By default the
    // generator is never charged for a technical pass.
    const techModel = maskPassModel({ maskModel: config?.image?.maskModel, model, imageModel: config?.imageModel })
        || PROXY_IMAGE_EDIT_MODEL;

    // 2. Paint pass with explicit hex.
    let paintedPath = null;
    if (MODEL_MATES.has(alphaMode) && paintBackground && client?.images) {
        const painted = await askModel({ client, config, file: base, prompt: paintPrompt, signal, model: techModel });
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
        // 3. Model matte.
        if (MODEL_MATES.has(alphaMode) && client?.images && paintedPath) {
            const matte = await askModel({ client, config, file: base, prompt: ALPHA_MASK_PROMPT, signal, model: techModel });
            if (isRaster(matte)) {
                const maskPath = path.join(cwd, `.tmp-alpha-mask-${process.pid}-${Date.now()}.${matte.ext}`);
                await writeFile(maskPath, matte.bytes);
                try {
                    const applied = raster
                        ? await rasterApplyAlphaMask({ input: matteBase, mask: maskPath, output: abs, cwd, signal, feather, engine })
                        : await magickApplyAlphaMask({ exe, input: matteBase, mask: maskPath, output: abs, cwd, signal, feather });
                    if (applied.reason === 'full-mask') return { ...merged, ...applied, model: matte.model };
                    if (applied.changed) return { ...merged, ...applied, model: matte.model };
                } finally {
                    await unlink(maskPath).catch(() => {});
                }
            } else {
                lastError = matte?.error ?? lastError;
            }
        }

        // 4. Local matte.
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

    // 5. Flat fallback.
    if (raster) {
        const flat = await flatAlphaFallback({ raster, engine, file: abs, cwd, signal, feather });
        return { ...merged, ...flat, reason: flat.changed ? 'flat' : flat.reason, error: lastError ?? flat.error };
    }
    const flat = await ensureTransparentBackground({ file: abs, magickPath: config?.magickPath ?? null, signal });
    return { ...merged, ...flat, reason: flat.changed ? 'flat' : flat.reason, error: lastError ?? flat.error };
}

// Re-export shared utilities that callers may depend on.
export { hasRealAlpha, frameFor } from '../shared/image-alpha.js';
