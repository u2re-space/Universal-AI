/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose Image generation and edits through POST /images/generations and /images/edits.
 * @depends node:crypto
 * @usedBy openai/client, agent/loop, agent/tools, commands/image, commands/run
 * @exports PROXY_IMAGE_MODEL, PROXY_IMAGE_EDIT_MODEL, PROXY_VECTOR_MODEL, IMAGE_SIZES, VECTOR_RATIOS,
 *   imageTransport, imageModelFor, normalizeImageSize, normalizeImageFormat, normalizeVectorRatio,
 *   isVectorModel, supportsTransparentBackground, imageFormatField, generationBody, encodeMultipart,
 *   imagePayloads, pngHasAlphaChannel, sniffImage
 * @ai.tags images, proxyapi
 * @ai.hint pure
 * @changed 2026-10-22 Model-aware background/output_format fields, PNG alpha check, and vector model support.
 */

import { randomBytes } from 'node:crypto';

/** Default ProxyAPI text-to-image model when imageModel is unset. See https://proxyapi.ru/models/browse/image */
export const PROXY_IMAGE_MODEL = 'recraft/recraft-v4.1-utility';

/** Default ProxyAPI model for edits and image-conditioned generation; the flash model has no vision input. */
export const PROXY_IMAGE_EDIT_MODEL = 'recraft/recraft-v4.1-utility-pro';

/** Default ProxyAPI vector (SVG) model. See https://proxyapi.ru/models/recraft/recraft-v4.1-vector */
export const PROXY_VECTOR_MODEL = 'recraft/recraft-v4.1-vector';

/** Sizes accepted by POST /images/generations and /images/edits. */
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024']);

/** Aspect ratios accepted by recraft vector models. */
export const VECTOR_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', 'auto']);

/**
 * Map a requested size to the nearest supported one. `auto` and an empty value omit the field.
 * Common words portrait, landscape, and square are accepted.
 * @param {string | null | undefined} size
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function normalizeImageSize(size) {
    const value = String(size ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (IMAGE_SIZES.includes(value)) return value;
    if (value === 'portrait') return '1024x1536';
    if (value === 'landscape') return '1536x1024';
    if (value === 'square') return '1024x1024';
    const match = /^(\d+)\s*x\s*(\d+)$/.exec(value);
    if (!match) return value;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return value;
    if (width === height) return '1024x1024';
    return height > width ? '1024x1536' : '1536x1024';
}

/**
 * `images` uses /images/generations and /images/edits. `responses` uses the Responses image_generation tool.
 * A proxyapi.ru host selects `images` unless image.transport is set.
 * @param {{ baseURL?: string, image?: { transport?: string | null } }} config
 * @returns {'images' | 'responses'}
 * @exports
 * @ai.hint pure
 */
export function imageTransport(config) {
    const chosen = config?.image?.transport;
    if (chosen === 'images' || chosen === 'responses') return chosen;
    try {
        const host = new URL(config?.baseURL ?? '').hostname;
        if (host === 'proxyapi.ru' || host.endsWith('.proxyapi.ru')) return 'images';
    } catch { /* an unusable base URL stays on the Responses tool */ }
    return 'responses';
}

/**
 * Model id for an images API call. ProxyAPI needs an explicit id such as recraft/recraft-v4.1.
 * Requests with a source image use the vision-capable default.
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
 * True when the model id names a vector (SVG) variant such as recraft/recraft-v4.1-vector.
 * @param {string | null | undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isVectorModel(model) {
    return /(?:^|[-/])vector\b/i.test(String(model ?? '').trim());
}

/**
 * Map a requested aspect ratio to one the vector models accept. Accepts ratio words (square,
 * portrait, landscape), ratio strings (1:1, 4:3, …), and pixel sizes (1024x1536). `auto` and
 * an empty value return null so the field is omitted.
 * @param {string | number | null | undefined} ratio
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function normalizeVectorRatio(ratio) {
    const value = String(ratio ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (VECTOR_RATIOS.includes(value)) return value;
    const word = value === 'square' ? '1:1' : value === 'portrait' ? '3:4' : value === 'landscape' ? '4:3' : null;
    if (word) return word;
    const match = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(value);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return null;
    const wanted = Math.log(width / height);
    let best = '1:1';
    let bestDelta = Infinity;
    for (const candidate of VECTOR_RATIOS) {
        if (candidate === 'auto') continue;
        const [cw, ch] = candidate.split(':').map(Number);
        const delta = Math.abs(Math.log(cw / ch) - wanted);
        if (delta < bestDelta) { bestDelta = delta; best = candidate; }
    }
    return best;
}

/**
 * Normalize a requested output format. `auto` and an empty value return null.
 * @param {string | null | undefined} format
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function normalizeImageFormat(format) {
    const value = String(format ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (value === 'jpg') return 'jpeg';
    return value;
}

/**
 * OpenAI image models accept `background: transparent` and `output_format`; Recraft and most
 * other vendors accept only `image_format` and render an opaque background. The caller uses
 * this to decide whether native alpha is possible or a local background removal is needed.
 * @param {string | null | undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function supportsTransparentBackground(model) {
    return /^(?:openai\/)?gpt-image-/i.test(String(model ?? '').trim());
}

/**
 * Field name for the output format: OpenAI uses `output_format`, Recraft uses `image_format`.
 * @param {string | null | undefined} model
 * @returns {'output_format' | 'image_format'}
 * @exports
 * @ai.hint pure
 */
export function imageFormatField(model) {
    return supportsTransparentBackground(model) ? 'output_format' : 'image_format';
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
        return body;
    }
    const frame = normalizeImageSize(size);
    if (frame) body.size = frame;
    const size_pair = (frame || body.size)?.trim?.()?.split?.("x")?.map?.((ns)=>parseInt(ns || "0"));
    if (size_pair?.[0] <= 1024 && size_pair?.[1] <= 1024) body.model = body.model?.replace?.(/\-pro$/, "") || body.model;
    if (quality && quality !== 'auto') body.quality = quality;
    if (Number.isInteger(n) && n > 1) body.n = n;
    const fmt = normalizeImageFormat(format);
    if (fmt) body[imageFormatField(model)] = fmt;
    if ((background === 'transparent' || background === 'opaque') && supportsTransparentBackground(model)) body.background = background;
    return body;
}

/**
 * multipart/form-data for POST /images/edits. The documented field name for the file is `image`.
 * @param {{ fields: object, files: Array<{ field?: string, filename: string, mime: string, bytes: Buffer }> }} form
 * @returns {{ body: Buffer, contentType: string }}
 * @exports
 * @ai.hint pure
 */
export function encodeMultipart({ fields, files }) {
    const boundary = `ai${randomBytes(12).toString('hex')}`;
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === null || value === '') continue;
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    for (const file of files) {
        const filename = String(file.filename).replace(/["\r\n]/g, '');
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'image'}"; filename="${filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
        chunks.push(file.bytes);
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Base64 payloads from an images response. The documented field is data[0].b64_json.
 * @param {object} body
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function imagePayloads(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((row) => row?.b64_json).filter((value) => typeof value === 'string' && value);
}

/**
 * True when a PNG buffer carries an alpha channel: color type 4/6 in IHDR or a tRNS chunk.
 * This does not prove that any pixel is actually transparent, but it rules out alpha entirely.
 * @param {Buffer} buffer
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function pngHasAlphaChannel(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33) return false;
    if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return false;
    const colorType = buffer[25];
    if (colorType === 4 || colorType === 6) return true;
    if (colorType !== 3) return false;
    for (let offset = 8; offset + 8 <= buffer.length;) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (type === 'tRNS') return true;
        offset += 12 + length;
    }
    return false;
}

/**
 * Extension and MIME from magic bytes. Unknown bytes are treated as PNG.
 * Also detects SVG text (from vector model output) starting with <svg or <?xml.
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string }}
 * @exports
 * @ai.hint pure
 */
export function sniffImage(buffer) {
    if (!Buffer.isBuffer(buffer)) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (buffer.length >= 6 && (buffer.toString('latin1', 0, 6) === 'GIF87a' || buffer.toString('latin1', 0, 6) === 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
    // Detect SVG text (vector model output): <svg ... or <?xml ...
    const head = buffer.subarray(0, 64).toString('utf8', 0, 64).replace(/^\s+/, '');
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return { ext: 'svg', mime: 'image/svg+xml' };
    return { ext: 'png', mime: 'image/png' };
}
