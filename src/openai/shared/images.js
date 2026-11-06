/**
 * Shared model-independent image API constants and payload utilities.
 * @module openai/shared/images
 * @exports IMAGE_SIZES, VECTOR_RATIOS, imageModelFamily, isVectorModel, normalizeVectorRatio, normalizeImageFormat,
 *   encodeMultipart, imagePayloads, imageSources, pngHasAlphaChannel, readImageSize, sniffImage
 */
import { randomBytes } from 'node:crypto';
import { IMAGE_SIZES, VECTOR_RATIOS } from '../../agent/shared/constants.js';

/** Sizes accepted by POST /images/generations and /images/edits. */
export { IMAGE_SIZES, VECTOR_RATIOS };

/** Resolve the image model family used by agent-level dispatchers. */
export function imageModelFamily(model) {
    const name = String(model ?? '').trim();
    if (/^(?:openai\/)?gpt-image-/i.test(name)) return 'gpt-image';
    if (/(?:^|\/)riverflow-/i.test(name)) return 'riverflow';
    return 'other';
}

/** True when the model id names a vector (SVG) variant. */
export function isVectorModel(model) {
    return /(?:^|[-/])vector\b/i.test(String(model ?? '').trim());
}

/** Map a requested vector aspect ratio to the nearest supported ratio. */
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

/** Normalize an image format; auto and empty values omit the field. */
export function normalizeImageFormat(format) {
    const value = String(format ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (value === 'jpg') return 'jpeg';
    return value;
}

/** Encode the fields and files for POST /images/edits as multipart form data. */
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

/** Base64 payloads from an images response. */
export function imagePayloads(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((row) => row?.b64_json).filter((value) => typeof value === 'string' && value);
}

/** Every image response as inline base64 or a URL, in response order. */
export function imageSources(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    const out = [];
    for (const row of rows) {
        if (typeof row?.b64_json === 'string' && row.b64_json.trim()) out.push({ kind: 'b64', value: row.b64_json.trim() });
        else if (typeof row?.url === 'string' && row.url.trim()) out.push({ kind: 'url', value: row.url.trim() });
    }
    return out;
}

/** True when a PNG buffer carries an alpha channel. */
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

/** Read raster dimensions from PNG, JPEG, WebP or GIF bytes. */
export function readImageSize(buffer) {
    if (!buffer || buffer.length < 10) return null;
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const tag = (at) => b.length >= at + 4 && String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
    const u16be = (at) => (b[at] << 8) | b[at + 1];
    const u32be = (at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
    const u32le = (at) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + (b[at + 3] << 24);
    const frame = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        if (b.length < 24 || tag(12) !== 'IHDR') return null;
        return frame(u32be(16), u32be(20));
    }
    if (tag(0) === 'GIF8') return frame(b[6] | (b[7] << 8), b[8] | (b[9] << 8));
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
        for (let offset = 12; offset + 8 <= b.length;) {
            const chunk = tag(offset);
            const size = u32le(offset + 4);
            const data = offset + 8;
            if (chunk === 'VP8X' && size >= 10 && data + 10 <= b.length) {
                return frame(1 + b[data + 4] + (b[data + 5] << 8) + (b[data + 6] << 16),
                    1 + b[data + 7] + (b[data + 8] << 8) + (b[data + 9] << 16));
            }
            if (chunk === 'VP8L' && size >= 5 && data + 5 <= b.length && b[data] === 0x2f) {
                const bits = u32le(data + 1);
                return frame(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
            }
            if (chunk === 'VP8 ' && size >= 10 && data + 10 <= b.length
                && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
                return frame(((b[data + 7] & 0x3f) << 8) | b[data + 6], ((b[data + 9] & 0x3f) << 8) | b[data + 8]);
            }
            offset = data + size + (size & 1);
        }
        return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
        for (let i = 2; i + 9 < b.length;) {
            if (b[i] !== 0xff) { i += 1; continue; }
            let marker = b[i + 1];
            while (marker === 0xff && i + 2 < b.length) { i += 1; marker = b[i + 1]; }
            if (marker === 0xda || marker === 0xd9) return null;
            if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return frame(u16be(i + 7), u16be(i + 5));
            }
            const length = u16be(i + 2);
            if (length < 2) return null;
            i += 2 + length;
        }
    }
    return null;
}

/** Extension and MIME from image magic bytes. Unknown bytes default to PNG. */
export function sniffImage(buffer) {
    if (!Buffer.isBuffer(buffer)) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (buffer.length >= 6 && (buffer.toString('latin1', 0, 6) === 'GIF87a' || buffer.toString('latin1', 0, 6) === 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
    const head = buffer.subarray(0, 64).toString('utf8', 0, 64).replace(/^\s+/, '');
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return { ext: 'svg', mime: 'image/svg+xml' };
    return { ext: 'png', mime: 'image/png' };
}
