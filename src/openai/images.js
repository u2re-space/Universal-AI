/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose Image generation and edits through POST /images/generations and /images/edits.
 * @depends node:crypto
 * @usedBy openai/client, agent/loop, agent/tools, commands/image, commands/run
 * @exports PROXY_IMAGE_MODEL, imageTransport, imageModelFor, generationBody, encodeMultipart, imagePayloads, sniffImage
 * @ai.tags images, proxyapi
 * @ai.hint pure
 * @changed 2026-10-15 ProxyAPI images endpoints. Docs: https://proxyapi.ru/docs/image-generation
 */

import { randomBytes } from 'node:crypto';

/** Default ProxyAPI image model when imageModel is unset. See https://proxyapi.ru/models/browse/image */
export const PROXY_IMAGE_MODEL = 'openai/gpt-image-1-mini';

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
 * Model id for an images API call. ProxyAPI needs an explicit id such as openai/gpt-image-1-mini.
 * @param {{ imageModel?: string | null, baseURL?: string, image?: { transport?: string | null } }} config
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function imageModelFor(config) {
    if (config?.imageModel) return config.imageModel;
    return imageTransport(config) === 'images' ? PROXY_IMAGE_MODEL : null;
}

/**
 * JSON body for POST /images/generations. `auto` size and quality are omitted; partial frames are never sent.
 * @param {{ model: string, prompt: string, size?: string | null, quality?: string | null, n?: number | null }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function generationBody({ model, prompt, size = null, quality = null, n = null }) {
    const body = { model, prompt };
    if (size && size !== 'auto') body.size = size;
    if (quality && quality !== 'auto') body.quality = quality;
    if (Number.isInteger(n) && n > 1) body.n = n;
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
 * Extension and MIME from magic bytes. Unknown bytes are treated as PNG.
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string }}
 * @exports
 * @ai.hint pure
 */
export function sniffImage(buffer) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (buffer.length >= 6 && (buffer.toString('latin1', 0, 6) === 'GIF87a' || buffer.toString('latin1', 0, 6) === 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
    return { ext: 'png', mime: 'image/png' };
}
