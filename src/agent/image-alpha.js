/**
 * @file src/agent/image-alpha.js
 * @module agent/image-alpha
 * @purpose Build a real alpha channel from a black-and-white mask drawn by the image model.
 * @depends node:path, node:fs/promises, agent/image-magick, openai/images
 * @usedBy commands/image, agent/image-tools
 * @exports ALPHA_MASK_PROMPT, applyGeneratedAlphaMask
 * @ai.tags images, alpha, imagemagick
 * @ai.hint io
 * @changed 2026-10-22 Mask-based transparency replaces the chroma-key flood fill as the primary path.
 */

import path from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { detectMagick, ensureTransparentBackground, magickApplyAlphaMask, magickIdentify, magickIsOpaque } from './image-magick.js';
import { PROXY_IMAGE_EDIT_MODEL, sniffImage } from '../openai/images.js';

/**
 * Prompt for the mask pass. The model is asked for a grayscale matte instead of a transparent
 * picture: image models that cannot emit alpha paint a checkerboard or a flat plate instead, and a
 * matte converts cleanly into a real alpha channel.
 */
export const ALPHA_MASK_PROMPT = 'Return a black-and-white alpha mask for the attached image. '
    + 'White marks the subject that must stay visible (the artwork, logo, product, or person); '
    + 'black marks everything that must become transparent: the background, including a checkerboard, '
    + 'grid, or flat color that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Output the mask only: grayscale, pure white and pure black, no colors, no shadows, no text, no border.';

/** Raster mask formats ImageMagick can read. */
const MASK_EXT = /\.(png|webp|jpe?g)$/i;

/**
 * Ask the image model for a grayscale mask of the subject and merge it into the file as alpha.
 * Native transparency is impossible for most vendors, and a flat fill only works while the
 * background is one color; a matte also survives a painted checkerboard or a soft shadow.
 * The mask is drawn by the edit model rather than the user's `--image-model`, because it is a
 * technical pass and must not inherit a generator that cannot see the source. `image.maskModel`
 * overrides that choice. When the mask pass fails, the local flat fill still runs as a fallback.
 * @param {{ client?: object|null, config?: object|null, file: string, signal?: AbortSignal, model?: string|null }} options
 * @returns {Promise<{ changed: boolean, reason: string, model?: string, inverted?: boolean, error?: Error }>}
 * @exports
 * @ai.hint io
 */
export async function applyGeneratedAlphaMask({ client = null, config = null, file, signal, model = null }) {
    const abs = path.resolve(file);
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return { changed: false, reason: 'format' };
    const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
    if (!exe) return { changed: false, reason: 'no-magick' };
    const cwd = path.dirname(abs);
    const opaque = await magickIsOpaque({ exe, input: abs, cwd, signal }).catch(() => null);
    if (opaque === false) return { changed: false, reason: 'already' };
    if (opaque === null) return { changed: false, reason: 'unknown' };
    if (!client?.images) return flatFill({ file: abs, config, signal });

    const source = await readFile(abs);
    const kind = sniffImage(source);
    const info = await magickIdentify({ exe, input: abs, cwd, signal }).catch(() => null);
    // Keep the source aspect ratio, so the matte is not squeezed into a square frame.
    const frame = !info?.width || !info?.height ? null
        : info.width === info.height ? '1024x1024' : info.height > info.width ? '1024x1536' : '1536x1024';
    const maskModel = model || config?.image?.maskModel || PROXY_IMAGE_EDIT_MODEL;
    let payloads;
    try {
        payloads = await client.images.edit({
            model: maskModel,
            prompt: ALPHA_MASK_PROMPT,
            size: frame,
            format: 'png',
            signal,
            files: [{ filename: path.basename(abs), mime: kind.mime, bytes: source }],
        });
    } catch (error) {
        return flatFill({ file: abs, config, signal, error });
    }

    const maskBytes = Buffer.from(payloads[0], 'base64');
    const maskKind = sniffImage(maskBytes);
    if (!MASK_EXT.test(`.${maskKind.ext}`)) return flatFill({ file: abs, config, signal });
    const maskPath = path.join(cwd, `.tmp-alpha-mask-${process.pid}-${Date.now()}.${maskKind.ext}`);
    await writeFile(maskPath, maskBytes);
    try {
        const applied = await magickApplyAlphaMask({ exe, input: abs, mask: maskPath, output: abs, cwd, signal });
        // A full-white matte means the model found nothing to cut: keep the picture as it is
        // instead of letting the corner fill eat a corner of the subject.
        if (applied.reason === 'full-mask') return { changed: false, reason: 'opaque', model: maskModel };
        if (!applied.changed) return flatFill({ file: abs, config, signal });
        return { ...applied, model: maskModel };
    } catch (error) {
        return flatFill({ file: abs, config, signal, error });
    } finally {
        await unlink(maskPath).catch(() => {});
    }
}

/**
 * Local fallback: flood-fill the corner color. Reported as `flat` so the caller can tell it apart
 * from the mask pass.
 * @param {{ file: string, config?: object|null, signal?: AbortSignal, error?: Error }} options
 * @returns {Promise<{ changed: boolean, reason: string, error?: Error }>}
 * @ai.hint io
 */
async function flatFill({ file, config = null, signal, error = null }) {
    const flat = await ensureTransparentBackground({ file, magickPath: config?.magickPath ?? null, signal });
    const result = { ...flat, reason: flat.changed ? 'flat' : flat.reason };
    if (error) result.error = error;
    return result;
}
