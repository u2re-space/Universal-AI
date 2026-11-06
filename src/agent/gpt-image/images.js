/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose Image generation and edits through POST /images/generations and /images/edits.
 * @depends node:crypto
 * @usedBy openai/client, agent/loop, agent/tools, commands/image, commands/run
 * @exports PROXY_IMAGE_MODEL, PROXY_IMAGE_EDIT_MODEL, PROXY_VECTOR_MODEL, IMAGE_SIZES, VECTOR_RATIOS,
 *   imageTransport, imageModelFor, normalizeImageSize, normalizeImageFormat, resolveImageFormat, normalizeVectorRatio,
 *   isVectorModel, supportsTransparentBackground, backgroundValue, imageFormatField, generationBody, encodeMultipart,
 *   imagePayloads, imageSources, acceptsResponseFormat, pngHasAlphaChannel, sniffImage
 * @ai.tags images, proxyapi
 * @ai.hint pure
 * @changed 2026-10-22 gpt-image-2.5 defaults for raster, gpt-image-2 alpha exception, vector model support.
 * @changed 2026-10-30 response_format only where the model takes it; imageSources reads b64_json or url.
 */

import {
    IMAGE_SIZES, VECTOR_RATIOS, encodeMultipart, imagePayloads, imageSources,
    isVectorModel, normalizeImageFormat, normalizeVectorRatio, pngHasAlphaChannel, sniffImage,
    sameAspectImageSize
} from '../shared/images.js';
import {
    PROXY_IMAGE_MODEL,
    PROXY_IMAGE_EDIT_MODEL,
    GPT_IMAGE_25,
    GPT_IMAGE_26
} from '../shared/constants.js';

/**
 * Retry only errors that explicitly identify an invalid or unsupported image size.
 * @param {Error & { status?: number, param?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isImageSizeError(error) {
    if (![400, 413, 422].includes(error?.status)) return false;
    if (/^(?:size|image_size|dimensions?)$/i.test(String(error?.param ?? ''))) return true;
    return /\b(size|dimensions?|resolution|aspect ratio|pixel count)\b/i.test(String(error?.message ?? ''));
}

/**
 * Ordered image-size attempts: the exact request, a valid same-ratio size, then the nearest preset.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function imageSizeAttempts(size, model) {
    const initial = imageRequestSize(size, model);
    if (!initial || !(GPT_IMAGE_25.test(String(model ?? '')) || GPT_IMAGE_26.test(String(model ?? ''))) || !/^\d+x\d+$/.test(initial)) return initial ? [initial] : [];
    const attempts = [initial];
    const sameRatio = sameAspectImageSize(initial);
    const preset = normalizeImageSize(initial);
    for (const candidate of [sameRatio, preset]) {
        if (candidate && !attempts.includes(candidate)) attempts.push(candidate);
    }
    return attempts;
}

/**
 * `images` uses /images/generations and /images/edits. `responses` uses the Responses image_generation tool.
 * A proxyapi.ru host selects `images` unless image.transport is set. Any other gateway only gets the
 * images route when its own backend entry declares it, because the Responses image tool is a
 * server-side feature most OpenAI-compatible hosts do not implement, while /images/generations is.
 * @param {{ baseURL?: string, apiKey?: string, backends?: object[], image?: { transport?: string | null } }} config
 * @returns {'images' | 'responses'}
 * @exports
 * @ai.hint pure
 */
export function imageTransport(config) {
    const chosen = config?.image?.transport;
    if (chosen === 'images' || chosen === 'responses') return chosen;
    const declared = Array.isArray(config?.backends) ? config.backends : [];
    const primary = String(config?.baseURL ?? '').replace(/\/+$/, '');
    const entry = declared.find((item) => String(item?.baseURL ?? '').replace(/\/+$/, '') === primary);
    const wants = (supports) => supports?.images === true || supports?.imageAPI === true;
    if (wants(entry?.supports)) return 'images';
    try {
        const host = new URL(config?.baseURL ?? '').hostname;
        if (host === 'proxyapi.ru' || host.endsWith('.proxyapi.ru')) return 'images';
    } catch { /* an unusable base URL stays on the Responses tool */ }
    if (primary.startsWith('https://api.openai.com')) return 'responses';
    return 'images';
}

/**
 * Model id for an images API call. ProxyAPI needs an explicit id such as openai/gpt-image-2.5-sunburst.
 * Requests with a source image use the edit default.
 * @param {{ imageModel?: string | null, baseURL?: string, image?: { transport?: string | null } }} config
 * @param {{ hasImage?: boolean }} [request]
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function imageModelFor(config, { hasImage = false } = {}) {
    if (config?.imageModel) return config.imageModel;
    if (imageTransport(config) !== 'images') return null;
    return hasImage ? PROXY_IMAGE_EDIT_MODEL : PROXY_IMAGE_MODEL;
}

/**
 * True when the model id names a vector (SVG) variant such as recraft/recraft-v4.1-pro-vector.
 * @param {string | null | undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */

/**
 * Map a requested aspect ratio to one the vector models accept. Accepts ratio words (square,
 * portrait, landscape), ratio strings (1:1, 4:3, …), and pixel sizes (1024x1536). `auto` and
 * an empty value return null so the field is omitted.
 * @param {string | number | null | undefined} ratio
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */

/**
 * Normalize a requested output format. `auto` and an empty value return null.
 * @param {string | null | undefined} format
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */

/**
 * Format field for a request: the requested one, or PNG for the models that read `output_format`.
 * gpt-image-* answers in its own default when the field is left out, and every intermediate file
 * (mask, painted plate, crop under .tmp) must be PNG, so the field is sent explicitly instead of
 * being omitted. Vendor models that only take `image_format` keep the field out when it is not asked
 * for, so a Recraft request is not changed by this.
 * @param {{ model: string, format?: string | null }} request
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function resolveImageFormat({ model, format = null }) {
    const fmt = normalizeImageFormat(format);
    if (fmt) return fmt;
    return imageFormatField(model) === 'output_format' ? 'png' : null;
}

/**
 * OpenAI image models accept `output_format`; Recraft and most other vendors accept only
 * `image_format`.
 * @param {string | null | undefined} model
 * @returns {'output_format' | 'image_format'}
 * @exports
 * @ai.hint pure
 */
export function imageFormatField(model) {
    return /^(?:openai\/)?gpt-image-/i.test(String(model ?? '').trim()) ? 'output_format' : 'image_format';
}

/**
 * OpenAI gpt-image models accept `background: transparent`; gpt-image-2 is the exception and
 * rejects the field, so it is treated as an opaque-only model. Recraft and most other vendors
 * render an opaque background. The caller uses this to decide whether native alpha is possible
 * or a local background removal is needed.
 * @param {string | null | undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function supportsTransparentBackground(model) {
    const version = /^(?:openai\/)?gpt-image-(\d+(?:\.\d+)?)/i.exec(String(model ?? '').trim())?.[1];
    return Boolean(version) && version !== '2';
}

/**
 * Value for the `background` field, or null to omit it. Transparent output needs a model that
 * accepts the field and a format that can store alpha: the API rejects transparent JPEG, so that
 * combination falls back to a local background removal (reported by the caller).
 * @param {{ model: string, format?: string | null, background?: string | null }} request
 * @returns {'transparent' | 'opaque' | null}
 * @exports
 * @ai.hint pure
 */
export function backgroundValue({ model, format = null, background = null }) {
    if (background !== 'transparent' && background !== 'opaque') return null;
    if (!supportsTransparentBackground(model)) return null;
    if (background === 'transparent' && normalizeImageFormat(format) === 'jpeg') return null;
    return background;
}

/**
 * Whether a model accepts the `response_format` field. `gpt-image-1` rejects it and always answers
 * in base64, and vendor models that take `image_format` do not document it at all, so a strict
 * gateway answers 400 for the whole request. Only the newer OpenAI image models are asked for it.
 * @param {string | null | undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function acceptsResponseFormat(model) {
    const name = String(model ?? '').trim();
    if (!/^(?:openai\/)?gpt-image-/i.test(name)) return false;
    const version = /^(?:openai\/)?gpt-image-(\d+(?:\.\d+)?)/i.exec(name)?.[1];
    return Boolean(version) && version !== '1';
}

/**
 * JSON body for POST /images/generations. `auto` size and quality are omitted; partial frames
 * are never sent. An unsupported size is snapped to the nearest supported frame. `background`
 * and the format field are sent only where the model understands them, so a Recraft request
 * never gets OpenAI-only fields.
 *
 * For vector models (`recraft/...-vector`) the body uses `aspect_ratio` and forces `image_format:
 * svg`; image-conditioned vectorization goes through /images/edits with a multipart file.
 * @param {{ model: string, prompt: string, size?: string | null, quality?: string | null, n?: number | null, format?: string | null, background?: string | null }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function generationBody({ model, prompt, size = null, quality = null, n = null, format = null, background = null }) {
    const body = { model, prompt };
    if (isVectorModel(model)) {
        const aspect = normalizeVectorRatio(size);
        if (aspect) body.aspect_ratio = aspect;
        if (Number.isInteger(n) && n > 1) body.n = n;
        body[imageFormatField(model)] = 'svg';
        //if (acceptsResponseFormat(model)) body.response_format = 'b64_json';
        return body;
    }
    const frame = imageRequestSize(size, model);
    if (frame) body.size = frame;
    const size_pair = (frame || body.size)?.trim?.()?.split?.("x")?.map?.((ns)=>parseInt(ns || "0"));
    if (size_pair?.[0] <= 1024 && size_pair?.[1] <= 1024) body.model = body.model?.replace?.(/\-pro$/, "") || body.model;
    if (quality && quality !== 'auto') body.quality = quality;
    if (Number.isInteger(n) && n > 1) body.n = n;
    const fmt = resolveImageFormat({ model, format });
    if (fmt) body[imageFormatField(model)] = fmt;
    const backgroundField = backgroundValue({ model, format: fmt, background });
    if (backgroundField) body.background = backgroundField;
    //if (acceptsResponseFormat(model)) body.response_format = 'b64_json';
    return body;
}

/**
 * multipart/form-data for POST /images/edits. The documented field name for the file is `image`.
 * @param {{ fields: object, files: Array<{ field?: string, filename: string, mime: string, bytes: Buffer }> }} form
 * @returns {{ body: Buffer, contentType: string }}
 * @exports
 * @ai.hint pure
 */

/**
 * Base64 payloads from an images response. The documented field is data[0].b64_json.
 * A gateway that ignores `response_format` answers with `url` instead; those rows are skipped here,
 * so use `imageSources` when both shapes have to work.
 * @param {object} body
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */

/**
 * Every image a response carries, in the order returned, as either inline base64 or a URL to
 * fetch. Gateways differ here: OpenAI and ProxyAPI honor `response_format: b64_json`, while many
 * OpenAI-compatible hosts always return `data[].url`. Reading only one of the two fields made the
 * same call succeed on one backend and fail with "нет b64_json" on another.
 * @param {object} body
 * @returns {Array<{ kind: 'b64' | 'url', value: string }>}
 * @exports
 * @ai.hint pure
 */

/**
 * True when a PNG buffer carries an alpha channel: color type 4/6 in IHDR or a tRNS chunk.
 * This does not prove that any pixel is actually transparent, but it rules out alpha entirely.
 * @param {Buffer} buffer
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */

/**
 * Extension and MIME from magic bytes. Unknown bytes are treated as PNG.
 * Also detects SVG text (from vector model output) starting with <svg or <?xml.
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string }}
 * @exports
 * @ai.hint pure
 */
