/**
 * Shared model-independent image API constants and payload utilities.
 * @module openai/shared/images
 * @exports IMAGE_SIZES, VECTOR_RATIOS, isVectorModel, normalizeVectorRatio, normalizeImageFormat,
 *   encodeMultipart, imagePayloads, imageSources, pngHasAlphaChannel, readImageSize, sniffImage,
 *   aspectImageSize, aspectRatioToken, supportedAspectRatios
 */
import { randomBytes } from 'node:crypto';
import {
    PORTRAIT_SIZES, SQUARE_SIZES, LANDSCAPE_SIZES,
    IMAGE_SIZES, VECTOR_RATIOS, IMAGE_SIZES_BY_RESOLUTION, IMAGE_TIER_LIMITS, imageModelProfile,
    RIVERFLOW, RIVERFLOW_RATIOS, RIVERFLOW_RESOLUTIONS, MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, MAX_IMAGE_RATIO,
    GPT_IMAGE_25, GPT_IMAGE_26, PROXY_IMAGE_MODEL, PROXY_IMAGE_EDIT_MODEL, PROXY_VECTOR_MODEL, PROXY_RIVERFLOW_MODEL
} from './constants.js';
import {
    RATIO_MAX_TERM, RATIO_CEIL_EPSILON, RATIO_WORDS, STANDARD_RATIOS,
    aspectOf, aspectFrame, ceilAspect, nearestAspect, parseAspectToken, rationalAspect,
} from './aspect-ratio.js';

export { IMAGE_SIZES, VECTOR_RATIOS, RIVERFLOW_RATIOS, RIVERFLOW_RESOLUTIONS, imageModelProfile,
    MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, MAX_IMAGE_RATIO,
    PROXY_IMAGE_MODEL, PROXY_IMAGE_EDIT_MODEL, PROXY_VECTOR_MODEL, PROXY_RIVERFLOW_MODEL };

export { RATIO_MAX_TERM, RATIO_CEIL_EPSILON, RATIO_WORDS, STANDARD_RATIOS,
    aspectOf, aspectFrame, ceilAspect, nearestAspect, parseAspectToken, rationalAspect };

/** True when the model id names a vector (SVG) variant. */
export function isVectorModel(model) {
    return /(?:^|[-/])vector\b/i.test(String(model ?? '').trim());
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

/**
 * The shapes one model is asked for by name: the ratio field of a tier-based gateway, the vector
 * ratio list, or the standard catalogue for a model that takes a literal frame.
 * @param {string|null|undefined} model
 * @param {'vector'|'image'|'auto'} [field] which field the ratio is headed for
 * @returns {readonly string[]}
 * @exports
 * @ai.hint pure
 */
export function supportedAspectRatios(model, field = 'auto') {
    if (field === 'vector') return VECTOR_RATIOS;
    if (field === 'image' || imageModelProfile(model).resolutionTiers) return RIVERFLOW_RATIOS;
    return STANDARD_RATIOS;
}

/**
 * The shape a request names, rounded to a shape the model is asked about: `2.39:1` becomes `21:9`
 * for a riverflow ratio field and stays 31:13 for a model that draws the frame itself.
 * @param {string|number|{width: number, height: number}} value
 * @param {string|null|undefined} model
 * @param {'vector'|'image'|'auto'} [field]
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function aspectRatioToken(value, model = null, field = 'auto') {
    return nearestAspect(value, supportedAspectRatios(model, field));
}

/**
 * The pixel frame one shape names for one model at one tier: the shape as a fraction with terms
 * within `RATIO_MAX_TERM`, scaled by a whole number of 16-pixel increments up to the tier's pixel
 * budget and rounded up (with the `RATIO_CEIL_EPSILON` stickiness), then clamped to what the model
 * accepts. This is how `2.39:1`, `cinemascope`, or a `1919x1079` source reaches a free-frame model
 * as a real frame instead of a token the gateway would drop.
 * @param {string|number|null|undefined} value
 * @param {string|null|undefined} model
 * @param {string|null} [resolution] tier whose pixel budget the frame is built on
 * @returns {string|null} `WIDTHxHEIGHT`, or null when the token names no shape
 * @exports
 * @ai.hint pure
 */
export function aspectImageSize(value, model = null, resolution = null) {
    const shape = parseAspectToken(value);
    if (!shape) return null;
    const caps = imageModelProfile(model);
    const tier = IMAGE_TIER_LIMITS[tierFromToken(resolution, model) || '1k'] || IMAGE_TIER_LIMITS['1k'];
    const frame = aspectFrame(shape.ratio, {
        step: 16,
        minPixels: caps.minPixels, maxPixels: caps.maxPixels,
        maxEdge: caps.maxEdge, maxRatio: caps.maxRatio,
        pixels: tier.pixels,
    });
    return frame ? `${frame.width}x${frame.height}` : null;
}

// TODO: add accounting MAX pixels for don't allow overflow (in 2k or 4k)
export function inferResolution({ width, height }, model = null) {
    const maxSide = Math.max(width, height);
    const profile = imageModelProfile(model);//model ? imageModelProfile(model) : null;

    if (maxSide <= 512 && (profile?.minPixels <= (512*512) || !profile?.minPixels)) return '512';
    if (maxSide <= 1024) return '1k';
    if (maxSide <= 2048) return '2k';
    if (maxSide > 2048 && maxSide < 8192) return '4k';

    // 4k — максимальный уровень; запросы больше него попадут в 4k.
    return maxSide > 2048 ? '4k' : '1k';
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
export function tierFromToken(value, model = null) {
    const token = String(value ?? '').trim().toLowerCase();
    if (!token) return null; if (token === '512') return '512';
    if (/^\d+k$/.test(token)) return IMAGE_SIZES_BY_RESOLUTION[token] ? token : null;
    if (/^\d+$/.test(token)) return inferResolution({ width: Number(token), height: Number(token) }, model);
    return null;
}

/**
 * The frame a preset-only model gets when its family serves no resolution tiers: the frame of the
 * requested orientation, at the tier the request names. A preset model has three shapes — square,
 * portrait, landscape — so any shape asked for (`2.39:1`, `a4`, `wide`) resolves to the one of them
 * it can actually draw, and never to the token itself: leaking `2.39:1` into `size` makes a strict
 * gateway answer 400 and a lenient one fall back to its default square.
 * @param {string} value lowercased, non-empty size token
 * @returns {string|null}
 * @ai.hint pure
 */
export function presetImageSize(value, resolution = null, model = null) {
    if (IMAGE_SIZES.includes(value)) return value;
    const shape = parseAspectToken(value);
    if (!shape) return value;
    const parsed = parseImageSize(value);
    const resolutionKey = tierFromToken(resolution, model)
        || (parsed ? inferResolution(parsed, model) : null) || '1k';
    const tier = IMAGE_SIZES_BY_RESOLUTION[resolutionKey] ? resolutionKey : '1k';
    // A shape within half a percent of 1:1 is the square preset, not a leaning landscape one.
    if (Math.abs(Math.log(shape.ratio)) < RATIO_CEIL_EPSILON) return SQUARE_SIZES[tier] || SQUARE_SIZES['1k'];
    return shape.ratio < 1 ? (PORTRAIT_SIZES[tier] || PORTRAIT_SIZES['1k'])
        : (LANDSCAPE_SIZES[tier] || LANDSCAPE_SIZES['1k']);
}

/**
 * Map a requested size to the nearest supported one.
 *
 * The resolution tier decides the pixel budget; the requested size only decides orientation and
 * aspect. The tier comes from the explicit `resolution` argument, from a tier token inside `size`
 * (`512`, `2K`), or — when the size names pixels — from its longest side, so `1280x720` is a 2K
 * request and stays a 2K frame rather than collapsing to the 1024 preset.
 * A shape named without pixels (`21:9`, `2.39:1`, `cinemascope`) takes the frame of its tier whose
 * own shape is closest, so a tier-based model answers a wide request with a wide frame instead of
 * the square the vendor happened to list. A bare orientation word or a bare tier asks for the
 * largest frame the tier offers in that shape.
 * A family that serves no tiers never reaches this function: `imageRequestSize` sends it to
 * `presetImageSize` instead, so it keeps getting the frames it actually has.
 * `auto` and an empty value omit the field.
 * @param {string | null | undefined} size
 * @param {string | null} [resolution] one of `512`/`1K`/`2K`/`4K`
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function normalizeImageSize(size, resolution = null, model = null) {
    const value = String(size ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;

    let requested;
    let isOrientationWord = true;
    let isShapeOnly = false;
    if (value === 'portrait') requested = { width: 1, height: 2 };
    else if (value === 'landscape') requested = { width: 2, height: 1 };
    else if (value === 'square') requested = { width: 1, height: 1 };
    else {
        isOrientationWord = false;
        const parsed = parseImageSize(value);
        requested = parsed
            || (tierFromToken(value, model) ? { width: 1, height: 1 } : null)
            || parseAspectToken(value);
        // Неизвестное значение оставляем без изменений.
        if (!requested) return value;
        isShapeOnly = !parsed && !tierFromToken(value, model);
    }

    const resolutionKey = tierFromToken(resolution, model) || tierFromToken(value, model)
        || (isOrientationWord || isShapeOnly ? '1k' : inferResolution(requested, model));
    const supportedSizes = IMAGE_SIZES_BY_RESOLUTION[resolutionKey];
    if (!supportedSizes) return presetImageSize(value, resolution, model);

    const candidates = supportedSizes.map((size) => ({
        size,
        ...parseImageSize(size),
    }));

    const orientation = getOrientation(requested);
    const matchingOrientation = candidates.filter(
        (candidate) => getOrientation(candidate) === orientation,
    );

    const pool = matchingOrientation.length ? matchingOrientation : candidates;

    // A shape named without pixels asks for the frame of the tier whose own shape is closest;
    // a bare orientation word or a bare tier asks for the largest frame in that shape.
    if (isShapeOnly) {
        return pool
            .slice()
            .sort((a, b) => getAspectDifference(a, requested) - getAspectDifference(b, requested)
                || b.width * b.height - a.width * a.height)[0]
            .size;
    }
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
 * Keep custom dimensions for the models that take them (GPT Image 2.6); turn a shape that names no
 * pixels (`21:9`, `2.39:1`, `cinemascope`) into the frame that shape gives the model at the asked
 * tier; a family that serves resolution tiers gets the frame of the tier its request names; every
 * other model gets its supported frame presets.
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
    // A shape without pixels. A family tuned by a ratio field keeps it as a ratio of its own list:
    // the tier stays in `resolution`, and inventing a pixel frame would move the shape out of the
    // field the gateway is actually tuned by. A free-frame model has no ratio field, so the shape
    // is turned into the real frame it stands for at the asked tier.
    if ((caps.customSizes || caps.resolutionTiers) && !tierFromToken(value, model) && parseAspectToken(value)) {
        if (caps.resolutionTiers) return aspectRatioToken(value, model, 'image');
        const frame = aspectImageSize(value, model, resolution);
        if (frame) return frame;
    }
    // A family that serves tiers keeps the tier token: the gateway reads it as `resolution`, and
    // unfolding `2K` into `2048x2048` would move the request out of the field the model is tuned by.
    if (caps.resolutionTiers && tierFromToken(value, model)) return tierFromToken(value, model).toUpperCase();
    // A family without tiers must not be sent a tier frame it does not serve.
    if (!caps.resolutionTiers && !tierFromToken(resolution, model)) return presetImageSize(value, resolution, model);
    return normalizeImageSize(value, resolution, model);
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
    const explicitTier = caps.resolutionTiers ? tierFromToken(resolution, model) : null;
    if (!value || value === 'auto') return explicitTier ? { resolution: explicitTier.toUpperCase() } : {};
    if (caps.resolutionTiers) {
        if (/^\d+\s*x\s*\d+$/.test(value)) return { size: value.replace(/\s+/g, '') };
        // A tier named on its own — `512`, `2K`, or the pixel count `2048` — is the `resolution`
        // field, never `size`: a gateway that has no such frame drops the field and answers square.
        const tier = tierFromToken(value, model);
        if (tier) return { resolution: tier.toUpperCase() };
        // Any shape the caller names — `16:9`, `2.39`, `cinemascope`, `1920x1080` written as a
        // ratio — is rounded to the closest shape of the model's own list rather than dropped to
        // `auto`: a wide request must not come back square because 2.39:1 is not on the menu.
        const shape = parseAspectToken(value);
        if (shape) {
            return {
                aspect_ratio: nearestAspect(shape.ratio, RIVERFLOW_RATIOS) || 'auto',
                ...(explicitTier ? { resolution: explicitTier.toUpperCase() } : {}),
            };
        }
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
    if (error?.code === 'IMAGE_SIZE_ERROR') return true;
    if (![400, 413, 422].includes(error?.status)) return false;
    if (/^(?:size|image_size|dimensions?)$/i.test(String(error?.param ?? ''))) return true;
    return /\b(size|dimensions?|resolution|aspect ratio|pixel count)\b/i.test(String(error?.message ?? ''));
}

/**
 * Nearest aspect ratio from the riverflow set for a pixel size or any shape token. Returns a ratio
 * string like '4:5' that `imageSizeFields` can consume, or null when the shape is already square
 * (the gateway answers a square request with its default square frame, so there is nothing to fix).
 * @param {string} sizePixels
 * @returns {string | null}
 * @ai.hint pure
 */
export function nearestRiverflowRatio(sizePixels) {
    const shape = parseAspectToken(sizePixels);
    if (!shape) return null;
    const terms = rationalAspect(shape.ratio);
    if (terms && terms.width === terms.height) return null;
    return nearestAspect(shape.ratio, RIVERFLOW_RATIOS);
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
        const preset = presetImageSize(initial, resolution, model);
        if (preset && !attempts.includes(preset)) attempts.push(preset);
    }
    if (profile.omitSizeOnReject) attempts.push(null);
    return attempts;
}

/** Resolve the image model family used by agent-level dispatchers. */
export function imageModelFamily(model) {
    const name = String(model ?? '').trim();
    if (/^(?:openai\/)?gpt-image-/i.test(name)) return 'gpt-image';
    if (/(?:^|\/)riverflow-/i.test(name)) return 'riverflow';
    return 'other';
}

/**
 * Map a requested vector aspect ratio to the nearest supported ratio. The request may name the
 * shape any way a caller does it: `4:3`, `1024x768`, `1.33`, `landscape`, `a4`. The vector gateway
 * only answers to its own list, so the shape is rounded to the closest ratio there.
 */
export function normalizeVectorRatio(ratio) {
    const value = String(ratio ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (VECTOR_RATIOS.includes(value)) return value;
    return nearestAspect(value, VECTOR_RATIOS);
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

/**
 * Value for the `background` field, or null to omit it. Transparent output needs a model that
 * accepts the field and a format that can store alpha: the API rejects transparent JPEG, so that
 * combination falls back to a local background removal (reported by the caller).
 * @param {{ model: string, format?: string | null, background?: string | null }} request
 * @returns {'transparent' | 'opaque' | null}
 * @exports
 * @ai.hint pure
 */


/** Select whether image requests use the Images API or Responses image_generation tool. */
export function imageTransport(config) {
    const chosen = config?.image?.transport;
    if (chosen === 'images' || chosen === 'responses') return chosen;
    if (Array.isArray(config?.imagesBackends) && config.imagesBackends.length) return 'images';
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

/** Resolve an explicit or default model id for an Images API request. */
export function imageModelFor(config, { hasImage = false } = {}) {
    if (config?.imageModel) return config.imageModel;
    if (imageTransport(config) !== 'images') return null;
    return hasImage ? PROXY_IMAGE_EDIT_MODEL : PROXY_IMAGE_MODEL;
}

/** Field name used by a model for its requested image format. */
export function imageFormatField(model) {
    const name = String(model ?? '').trim();
    if (/^(?:openai\/)?gpt-image-/i.test(name) || RIVERFLOW.test(name)) return 'output_format';
    return 'image_format';
}

/** Resolve the requested format, defaulting OpenAI image models to PNG. */
export function resolveImageFormat({ model, format = null }) {
    const normalized = normalizeImageFormat(format);
    if (normalized) return normalized;
    return imageFormatField(model) === 'output_format' ? 'png' : null;
}

/** True when a model can return native transparent output. */
export function supportsTransparentBackground(model) {
    const version = /^(?:openai\/)?gpt-image-(\d+(?:\.\d+)?)/i.exec(String(model ?? '').trim())?.[1];
    return (Boolean(version) && version !== '2') || /riverflow-v2\.6-pro$/i.test(String(model ?? '').trim());
}

/** Return the supported background setting, or null when it cannot be sent. */
export function backgroundValue({ model, format = null, background = null }) {
    if (background !== 'transparent' && background !== 'opaque') return null;
    if (!supportsTransparentBackground(model)) return null;
    if (background === 'transparent' && normalizeImageFormat(format) === 'jpeg') return null;
    return background;
}

/** Whether a model accepts the optional response_format parameter. */
export function acceptsResponseFormat(model) {
    const name = String(model ?? '').trim();
    if (!/^(?:openai\/)?gpt-image-/i.test(name)) return false;
    const version = /^(?:openai\/)?gpt-image-(\d+(?:\.\d+)?)/i.exec(name)?.[1];
    return Boolean(version) && version !== '1';
}

function isSizeFinicky(caps) {
    return caps.resolutionTiers || caps.routeEditsThroughGeneration || caps.omitSizeOnReject;
}

/** Add a size instruction only for image families whose gateway is known to discard size fields. */
export function withSizeHint(prompt, fields = {}, model = null, mode = 'auto') {
    const text = String(prompt ?? '');
    const parts = [];
    if (fields.size) parts.push(`size ${fields.size}`);
    if (fields.resolution) parts.push(`resolution ${fields.resolution}`);
    if (fields.aspect_ratio && fields.aspect_ratio !== 'auto') parts.push(`aspect ratio ${fields.aspect_ratio}`);
    if (!parts.length || mode === 'never' || /Requested output:/i.test(text)) return text;
    if (mode === 'auto' && !isSizeFinicky(imageModelProfile(model))) return text;
    return `${text}\n\nRequested output: ${parts.join(', ')}. Keep this exact frame and aspect ratio.`;
}

/** Build the JSON body accepted by /images/generations for the selected model family. */
export function generationBody({ model, prompt, size = null, complexity = null, n = null, format = null,
    background = null, references = null, resolution = null, sizeHint = 'auto' }) {
    const body = { model, prompt };
    if (Array.isArray(references) && references.length) {
        body.input_references = references.map((url) => ({ type: 'image_url', image_url: { url } }));
    }
    if (isVectorModel(model)) {
        const aspect = normalizeVectorRatio(size);
        if (aspect) body.aspect_ratio = aspect;
        if (Number.isInteger(n) && n > 1) body.n = n;
        body[imageFormatField(model)] = 'svg';
        body.prompt = withSizeHint(prompt, body, model, sizeHint);
        return body;
    }
    const fields = imageSizeFields(size, model, resolution);
    if (fields.size) body.size = fields.size;
    else if (!fields.resolution && !fields.aspect_ratio) {
        const frame = imageRequestSize(size, model, resolution);
        if (frame) body.size = frame;
    }
    if (fields.resolution) body.resolution = fields.resolution;
    if (fields.aspect_ratio) body.aspect_ratio = fields.aspect_ratio;
    body.prompt = withSizeHint(prompt, body, model, sizeHint);
    const profile = imageModelProfile(model);
    if (!profile.keepProSuffix) {
        const sizePair = body.size?.split('x').map((part) => parseInt(part || '0', 10));
        if (sizePair?.[0] <= 1024 && sizePair?.[1] <= 1024) body.model = body.model?.replace(/\-pro$/, '') || body.model;
    }
    const cx = imageComplexityValue({ model, complexity });
    if (cx) body.complexity = cx;
    if (Number.isInteger(n) && n > 1) body.n = n;
    const fmt = resolveImageFormat({ model, format });
    if (fmt) body[imageFormatField(model)] = fmt;
    const backgroundField = backgroundValue({ model, format: fmt, background });
    if (backgroundField) body.background = backgroundField;
    return body;
}
