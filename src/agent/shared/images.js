/**
 * Shared model-independent image API constants and payload utilities.
 * @module openai/shared/images
 * @exports IMAGE_SIZES, VECTOR_RATIOS, isVectorModel, normalizeVectorRatio, normalizeImageFormat,
 *   encodeMultipart, imagePayloads, imageSources, pngHasAlphaChannel, readImageSize, sniffImage
 */
import { randomBytes } from 'node:crypto';
import {
    IMAGE_SIZES, VECTOR_RATIOS, IMAGE_CAPABILITIES, IMAGE_MODEL_PROFILES, IMAGE_SIZES_BY_RESOLUTION,
    RIVERFLOW, RIVERFLOW_RATIOS, MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, MAX_IMAGE_RATIO,
    GPT_IMAGE_25, GPT_IMAGE_26
} from './constants.js';

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

/** Return base64 image payloads from an images API response. */
export function imagePayloads(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((row) => row?.b64_json).filter((value) => typeof value === 'string' && value);
}

/** Return image payloads as inline base64 or URL, in response order. */
export function imageSources(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    const out = [];
    for (const row of rows) {
        if (typeof row?.b64_json === 'string' && row.b64_json.trim()) out.push({ kind: 'b64', value: row.b64_json.trim() });
        else if (typeof row?.url === 'string' && row.url.trim()) out.push({ kind: 'url', value: row.url.trim() });
    }
    return out;
}

/** True when a PNG carries an alpha channel or a transparency chunk. */
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

/** Read a raster frame from PNG, JPEG, WebP, or GIF bytes without a raster engine. */
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

/** Detect common raster formats and SVG text from magic bytes. */
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


/**
 * Capabilities of one image model id, merged over the defaults.
 * @param {string | null | undefined} model
 * @returns {{ customSizes: boolean, div16Padding: boolean, keepProSuffix: boolean, omitSizeOnReject: boolean, complexity: string|null, routeEditsThroughGeneration: boolean, resolutionTiers: boolean, paintsFakeTransparency: boolean }}
 * @exports
 * @ai.hint pure
 */
export function imageModelProfile(model) {
    const name = String(model ?? '').trim();
    const rule = IMAGE_MODEL_PROFILES.find((p) => p.match.test(name));
    if (!rule) return { ...IMAGE_CAPABILITIES };
    const { match, ...caps } = rule;
    return { ...IMAGE_CAPABILITIES, ...caps };
}

/**
 * Whether /images/edits inputs for this model need the 16-pixel padding. `auto` follows the model
 * profile; `always` and `never` are the operator override for a gateway whose behaviour the profile
 * does not describe — padding is a crutch, and a model that accepts the frame as-is gets it as-is.
 * @param {string | null | undefined} model
 * @param {'auto' | 'always' | 'never' | null | undefined} setting
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function needsDiv16Padding(model, setting = 'auto') {
    if (setting === 'always') return true;
    if (setting === 'never') return false;
    return imageModelProfile(model).div16Padding;
}

export function parseImageSize(value) {
    const match = /^(\d+)\s*x\s*(\d+)$/.exec(value);
    if (!match) return null;

    const width = Number(match[1]);
    const height = Number(match[2]);

    if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) {
        return null;
    }

    return { width, height };
}

export function getOrientation({ width, height }) {
    if (width === height) return 'square';
    return height > width ? 'portrait' : 'landscape';
}

export function getAspectDifference(a, b) {
    return Math.abs(Math.log((a.width / a.height) / (b.width / b.height)));
}

export function inferResolution({ width, height }) {
    const maxSide = Math.max(width, height);

    if (maxSide <= 512) return '512';
    if (maxSide <= 1024) return '1k';
    if (maxSide <= 2048) return '2k';

    // 4k — максимальный уровень; запросы больше него попадут в 4k.
    return '4k';
}

/**
 * Read a resolution tier out of a bare token: `512`, `1k`/`2k`/`4k`, or a plain pixel number
 * (`512`, `1024`, `2048`, `4096`) which names the tier by its longest side. This is what lets a
 * caller ask for `size: "2048"` and land on the 2K tier instead of leaking an unusable token to
 * the gateway (where it is dropped and the model answers with its default square).
 * Returns a key of `IMAGE_SIZES_BY_RESOLUTION`, or null when the token names no tier.
 * @param {string|null|undefined} value
 * @returns {string|null}
 * @ai.hint pure
 */
export function tierFromToken(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (!token) return null;
    if (token === '512') return '512';
    if (/^\d+k$/.test(token)) return IMAGE_SIZES_BY_RESOLUTION[token] ? token : null;
    if (/^\d+$/.test(token)) return inferResolution({ width: Number(token), height: Number(token) });
    return null;
}

/**
 * The frame a preset-only model gets when its family serves no resolution tiers: the nearest
 * `IMAGE_SIZES` entry that keeps the orientation. Kept separate from the tier table because a model
 * such as gpt-image-1 has no 2048x2048 at all — mapping a size by its own pixel count would ask the
 * gateway for a frame it cannot produce.
 * @param {string} value lowercased, non-empty size token
 * @returns {string|null}
 * @ai.hint pure
 */
export function presetImageSize(value) {
    if (IMAGE_SIZES.includes(value)) return value;
    if (value === 'portrait') return '1024x1536';
    if (value === 'landscape') return '1536x1024';
    if (value === 'square') return '1024x1024';
    const parsed = parseImageSize(value);
    if (!parsed) return value;
    if (parsed.width === parsed.height) return '1024x1024';
    return parsed.height > parsed.width ? '1024x1536' : '1536x1024';
}

/**
 * Map a requested size to the nearest supported one.
 *
 * The resolution tier decides the pixel budget; the requested size only decides orientation and
 * aspect. The tier comes from the explicit `resolution` argument, from a tier token inside `size`
 * (`512`, `2K`), or — when the size names pixels — from its longest side, so `1280x720` is a 2K
 * request and stays a 2K frame rather than collapsing to the 1024 preset.
 * A family that serves no tiers never reaches this function: `imageRequestSize` sends it to
 * `presetImageSize` instead, so it keeps getting the frames it actually has.
 * `auto` and an empty value omit the field.
 * @param {string | null | undefined} size
 * @param {string | null} [resolution] one of `512`/`1K`/`2K`/`4K`
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function normalizeImageSize(size, resolution = null) {
    const value = String(size ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;

    let requested;
    let isOrientationWord = true;
    if (value === 'portrait') requested = { width: 1, height: 2 };
    else if (value === 'landscape') requested = { width: 2, height: 1 };
    else if (value === 'square') requested = { width: 1, height: 1 };
    else {
        isOrientationWord = false;
        requested = parseImageSize(value) || (tierFromToken(value) ? { width: 1, height: 1 } : null);
        // Неизвестное значение оставляем без изменений.
        if (!requested) return value;
    }

    const resolutionKey = tierFromToken(resolution) || tierFromToken(value)
        || (isOrientationWord ? '1k' : inferResolution(requested));
    const supportedSizes = IMAGE_SIZES_BY_RESOLUTION[resolutionKey];
    if (!supportedSizes) return presetImageSize(value);

    const candidates = supportedSizes.map((size) => ({
        size,
        ...parseImageSize(size),
    }));

    const orientation = getOrientation(requested);
    const matchingOrientation = candidates.filter(
        (candidate) => getOrientation(candidate) === orientation,
    );

    const pool = matchingOrientation.length ? matchingOrientation : candidates;

    // A bare orientation word or a bare tier asks for the largest frame the tier offers in that shape.
    if (isOrientationWord || !parseImageSize(value)) {
        return pool
            .slice()
            .sort((a, b) => b.width * b.height - a.width * b.height)[0]
            .size;
    }

    const fitting = pool.filter(
        (candidate) =>
            candidate.width >= requested.width &&
            candidate.height >= requested.height,
    );

    if (fitting.length) {
        return fitting
            .slice()
            .sort(
                (a, b) =>
                    a.width * a.height - b.width * b.height ||
                    getAspectDifference(a, requested) -
                        getAspectDifference(b, requested),
            )[0]
            .size;
    }

    return pool
        .slice()
        .sort((a, b) => {
            const scaleA = Math.min(
                a.width / requested.width,
                a.height / requested.height,
            );
            const scaleB = Math.min(
                b.width / requested.width,
                b.height / requested.height,
            );

            return (
                scaleB - scaleA ||
                getAspectDifference(a, requested) -
                    getAspectDifference(b, requested)
            );
        })[0].size;
}


/**
 * Resolve an image complexity tier: the caller's value when it names one, otherwise the
 * model's own default from the profile. `auto` and empty strings return null so the field is
 * omitted. Accepted values: `low`, `medium`, `high` — the default for models that support it is
 * `high`. Replaces the former `reasoning` and `quality` fields in the images API.
 * @param {{ model: string, complexity?: string | null }} request
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function imageComplexityValue({ model, complexity = null }) {
    const value = String(complexity ?? imageModelProfile(model).complexity ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    return value;
}

export function makePad16Size(value) {
    const size = parseImageSize(String(value ?? '').trim().replace(/\s+/g, ''));
    if (!size) return null;
    size.width = Math.ceil(size.width / 16) * 16;
    size.height = Math.ceil(size.height / 16) * 16;
    return `${size.width}x${size.height}`;
}

/**
 * Keep custom dimensions for the models that take them (GPT Image 2.6); a family that serves
 * resolution tiers gets the frame of the tier its request names; every other model gets its
 * supported frame presets.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @param {string|null} [resolution]
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function imageRequestSize(size, model, resolution = null) {
    const value = String(size ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if ((GPT_IMAGE_25.test(String(model ?? '')) || GPT_IMAGE_26.test(String(model ?? ''))) && /^\d+\s*x\s*\d+$/.test(value)) return value.replace(/\s+/g, '');
    const caps = imageModelProfile(model);
    if (caps.customSizes && /^\d+\s*x\s*\d+$/.test(value)) {
        if (needsDiv16Padding(model)) {
            return makePad16Size(value);
        }
        return value.replace(/\s+/g, '');
    }
    // A family that serves tiers keeps the tier token: the gateway reads it as `resolution`, and
    // unfolding `2K` into `2048x2048` would move the request out of the field the model is tuned by.
    if (caps.resolutionTiers && tierFromToken(value)) return tierFromToken(value).toUpperCase();
    // A family without tiers must not be sent a tier frame it does not serve.
    if (!caps.resolutionTiers && !tierFromToken(resolution)) return presetImageSize(value);
    return normalizeImageSize(value, resolution);
}

/**
 * Split one requested frame into the fields the model actually takes. Riverflow and the other
 * tier-based gateways read three shapes, and the order is a priority, not a set:
 *   `WIDTHxHEIGHT`  → `size`   (the exact frame, the cheapest and most faithful — used first);
 *   `W:H` ratio      → `aspect_ratio` (a shape with no fixed pixel count);
 *   `512`/`1K`/`2K`/`4K` → `resolution` (a quality tier, alone or with an aspect_ratio).
 * A model that is not tier-based keeps the single `size` field, so a gpt-image or Recraft request
 * is unchanged. `auto` and an empty value return nothing, which leaves every field out.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @returns {{ size?: string, resolution?: string, aspect_ratio?: string }}
 * @exports
 * @ai.hint pure
 */
export function imageSizeFields(size, model, resolution = null) {
    const value = String(size ?? '').trim().toLowerCase();
    const caps = imageModelProfile(model);
    // An explicitly requested tier is the `resolution` field even when no frame was named.
    const explicitTier = caps.resolutionTiers ? tierFromToken(resolution) : null;
    if (!value || value === 'auto') return explicitTier ? { resolution: explicitTier.toUpperCase() } : {};
    if (caps.resolutionTiers) {
        if (/^\d+\s*x\s*\d+$/.test(value)) return { size: value.replace(/\s+/g, '') };
        if (/^\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?$/.test(value)) {
            const ratio = value.replace(/\s+/g, '');
            return {
                aspect_ratio: RIVERFLOW_RATIOS.includes(ratio) ? ratio : 'auto',
                ...(explicitTier ? { resolution: explicitTier.toUpperCase() } : {}),
            };
        }
        // A tier named on its own — `512`, `2K`, or the pixel count `2048` — is the `resolution`
        // field, never `size`: a gateway that has no such frame drops the field and answers square.
        const tier = tierFromToken(value);
        if (tier) return { resolution: tier.toUpperCase() };
    }
    const frame = imageRequestSize(value, model, resolution);
    return frame ? { size: frame } : {};
}

/**
 * Custom dimensions are constrained to 16-pixel multiples, the model's max aspect ratio,
 * a maximum edge, and the supported pixel-count range. Return a nearby same-ratio frame
 * when possible.
 *
 * When the area and edge are already within limits, the function simply rounds each side
 * to the nearest 16-pixel multiple — no gcd-based rescaling. The gcd-path is used only when
 * the area is outside the supported range (too small or too large), in which case the frame
 * is rescaled to the nearest valid same-ratio size.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function sameAspectImageSize(size, model = null) {
    const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size ?? '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height
        || Math.max(width, height) / Math.min(width, height) > MAX_IMAGE_RATIO(model)) return null;
    const area = width * height;
    const maxEdge = Math.max(width, height);
    // Already valid — nothing to do.
    if (width % 16 === 0 && height % 16 === 0 && area >= MIN_IMAGE_PIXELS(model) && area <= MAX_IMAGE_PIXELS(model)
        && maxEdge <= MAX_IMAGE_EDGE(model)) return null;

    // Fast path: area and edge are already in range, only 16-multiple rounding is needed.
    // This avoids the gcd-based rescaling that would wildly inflate a small source image.
    if (area >= MIN_IMAGE_PIXELS(model) && area <= MAX_IMAGE_PIXELS(model) && maxEdge <= MAX_IMAGE_EDGE(model)) {
        const rounded = `${Math.round(width / 16) * 16}x${Math.round(height / 16) * 16}`;
        return rounded === `${width}x${height}` ? null : rounded;
    }

    // Area out of range — rescale via gcd to the nearest valid same-ratio size.
    const gcd = (a, b) => {
        while (b) [a, b] = [b, a % b];
        return a;
    };
    let divisor = width;
    let remainder = height;
    while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
    const ratioWidth = width / divisor;
    const ratioHeight = height / divisor;
    const widthStep = 16 / gcd(ratioWidth, 16);
    const heightStep = 16 / gcd(ratioHeight, 16);
    const multiplierStep = (widthStep * heightStep) / gcd(widthStep, heightStep);
    const ratioArea = ratioWidth * ratioHeight;
    const minimum = Math.ceil(Math.sqrt(MIN_IMAGE_PIXELS(model) / ratioArea) / multiplierStep) * multiplierStep;
    const maximum = Math.floor(Math.min(MAX_IMAGE_EDGE(model) / Math.max(ratioWidth, ratioHeight), Math.sqrt(MAX_IMAGE_PIXELS(model) / ratioArea)) / multiplierStep) * multiplierStep;
    if (minimum > maximum) return null;
    const target = Math.max(minimum, Math.min(maximum, Math.round(divisor / multiplierStep) * multiplierStep));
    const result = `${ratioWidth * target}x${ratioHeight * target}`;
    return result === `${width}x${height}` ? null : result;
}

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
 * Nearest aspect ratio from the riverflow set for a pixel size. Returns a ratio string like
 * '4:5' that `imageSizeFields` can consume, or null when the size is already square.
 * @param {string} sizePixels
 * @returns {string | null}
 * @ai.hint pure
 */
export function nearestRiverflowRatio(sizePixels) {
    const match = /^(\d+)\s*x\s*(\d+)$/i.exec(sizePixels);
    if (!match) return null;
    const w = Number(match[1]), h = Number(match[2]);
    if (w === h) return null;
    const wanted = Math.log(w / h);
    let best = w < h ? '4:5' : '4:3';
    let bestDelta = Infinity;
    for (const candidate of RIVERFLOW_RATIOS) {
        if (candidate === 'auto') continue;
        const [cw, ch] = candidate.split(':').map(Number);
        const delta = Math.abs(Math.log(cw / ch) - wanted);
        if (delta < bestDelta) { bestDelta = delta; best = candidate; }
    }
    return best;
}
/**
 * Ordered image-size attempts: the exact request, a valid same-ratio size, then a nearest fallback.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @param {string|null} [resolution]
 * @returns {(string|null)[]}
 * @exports
 * @ai.hint pure
 */
export function imageSizeAttempts(size, model, resolution = null) {
    const initial = imageRequestSize(size, model, resolution);
    if (!initial) return [];
    const profile = imageModelProfile(model);
    if (!profile.customSizes || !/^\d+x\d+$/.test(initial)) {
        const attempts = [initial];
        if (profile.omitSizeOnReject) attempts.push(null);
        return attempts;
    }
    const attempts = [initial];
    const sameRatio = sameAspectImageSize(initial, model);
    if (sameRatio && !attempts.includes(sameRatio)) attempts.push(sameRatio);
    if (RIVERFLOW.test(String(model ?? ''))) {
        const ratio = nearestRiverflowRatio(initial);
        if (ratio && !attempts.includes(ratio)) attempts.push(ratio);
    } else {
        const preset = presetImageSize(initial);
        if (preset && !attempts.includes(preset)) attempts.push(preset);
    }
    if (profile.omitSizeOnReject) attempts.push(null);
    return attempts;
}
