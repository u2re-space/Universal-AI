/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose Image generation and edits through POST /images/generations and /images/edits.
 * @depends node:crypto
 * @usedBy openai/client, agent/loop, agent/tools, commands/image, commands/run
 * @exports PROXY_IMAGE_MODEL, PROXY_IMAGE_EDIT_MODEL, PROXY_VECTOR_MODEL, PROXY_RIVERFLOW_MODEL, IMAGE_SIZES, VECTOR_RATIOS,
 *   RIVERFLOW_RATIOS, RIVERFLOW_RESOLUTIONS,
 *   imageTransport, imageModelFor, normalizeImageSize, normalizeImageFormat, resolveImageFormat, normalizeVectorRatio,
 *   isVectorModel, supportsTransparentBackground, backgroundValue, imageFormatField, generationBody, encodeMultipart,
 *   imagePayloads, imageSources, acceptsResponseFormat, pngHasAlphaChannel, sniffImage,
 *   imageModelProfile, needsDiv16Padding, imageSizeFields, imageComplexityValue
 * @ai.tags images, proxyapi
 * @ai.hint pure
 * @changed 2026-10-22 gpt-image-2.6 defaults for raster, gpt-image-2 alpha exception, vector model support.
 * @changed 2026-10-30 response_format only where the model takes it; imageSources reads b64_json or url.
 * @changed 2026-11-04 per-model capability profiles (customSizes, div16Padding, keepProSuffix, omitSizeOnReject);
 *   sourceful/riverflow-v2.6-pro support (presets only, no custom sizes); image.div16 (auto|always|never) override.
 * @changed 2026-11-05 `reasoning` and `quality` removed from images API; replaced by `complexity`
 *   (low | medium | high, default high) for gpt-image-2.6 and riverflow.
 */

import { randomBytes } from 'node:crypto';

/** OpenAI gpt-image-2.5 family (sunburst, flare, …). */
const GPT_IMAGE_25 = /^(?:openai\/)?gpt-image-2\.5(?:-|$)/i;
const GPT_IMAGE_26 = /^(?:openai\/)?gpt-image-2\.6(?:-|$)/i;
/** Sourceful Riverflow family — a Flux-based id such as sourceful/riverflow-v2.6-pro. */
const RIVERFLOW = /(?:^|\/)riverflow-/i;

/** Default ProxyAPI text-to-image model when imageModel is unset. See https://proxyapi.ru/models/browse/image */
export const PROXY_IMAGE_MODEL = 'openai/gpt-image-2.6-sunburst';

/**
 * Default ProxyAPI model for edits and image-conditioned generation. Same gpt-image-2.5 family as
 * the generation default; both ids accept a source image and are interchangeable through --image-model.
 */
export const PROXY_IMAGE_EDIT_MODEL = 'openai/gpt-image-2.6-sunburst';

/** Default ProxyAPI vector (SVG) model. See https://proxyapi.ru/models/recraft/recraft-v4.1-pro-vector */
export const PROXY_VECTOR_MODEL = 'recraft/recraft-v4.1-pro-vector';

/**
 * Riverflow V2.6 Pro (Flux-based, https://proxyapi.ru/models/sourceful/riverflow-v2.6-pro). It is
 * an opt-in id rather than a default: not every gateway serves it, so `--image-model` or
 * `imageModel` in the config is what selects it.
 */
export const PROXY_RIVERFLOW_MODEL = 'sourceful/riverflow-v2.6-pro';

/**
 * What an image model is known to accept. A model absent from `IMAGE_MODEL_PROFILES` gets these
 * values, which is the plain `/images/generations` behaviour the vendor presets describe.
 *   `customSizes`             — an arbitrary WIDTHxHEIGHT goes into `size` instead of an IMAGE_SIZES preset;
 *   `div16Padding`            — /images/edits inputs must be padded to a 16-pixel multiple first;
 *   `keepProSuffix`           — the `-pro` suffix survives a small frame (the Recraft tier swap is not for it);
 *   `omitSizeOnReject`        — when the host rejects the frame, retry once with `size` left out entirely;
 *   `complexity`              — complexity tier the model understands (e.g. 'high' for riverflow);
 *   `routeEditsThroughGeneration` — /images/edits drops the size and tuning fields for this
 *                     family; send the source as `input_references` on /images/generations instead.
 */
const IMAGE_CAPABILITIES = Object.freeze({
    customSizes: false, div16Padding: false, keepProSuffix: false, omitSizeOnReject: false,
    complexity: null, routeEditsThroughGeneration: false, resolutionTiers: false,
    /** The gateway answers `background: transparent` with a painted plate instead of an alpha channel. */
    paintsFakeTransparency: false,
});

/**
 * Rules in match order; the first match wins, so a narrow family comes before a broad one.
 * Riverflow keeps its `-pro` suffix at any frame — the suffix is the model, not a size tier — and
 * takes no 16-pixel padding. Its frame support differs between gateways, so a refused frame costs
 * one retry without the field rather than the whole request.
 * Riverflow also supports complexity (`complexity: 'high'`); it accepts
 * aspect ratios via `aspect_ratio` and resolution tiers via `resolution` instead of pixel presets.
 * `routeEditsThroughGeneration` — the multipart /images/edits route silently drops the size,
 * resolution, aspect_ratio, quality and reasoning fields for this family and answers with the
 * gateway default square. The source picture travels as `input_references` on /images/generations
 * instead, where every field is honored.
 */
const IMAGE_MODEL_PROFILES = Object.freeze([
    Object.freeze({ match: GPT_IMAGE_26, customSizes: true, div16Padding: true, complexity: 'high' }),
    Object.freeze({ match: GPT_IMAGE_25, customSizes: true, div16Padding: true }),
    Object.freeze({ match: RIVERFLOW, customSizes: true, keepProSuffix: true, omitSizeOnReject: true, complexity: 'high', routeEditsThroughGeneration: true, resolutionTiers: true, paintsFakeTransparency: true }),
]);

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

/** Sizes accepted by POST /images/generations and /images/edits. */
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024']);

/** Aspect ratios accepted by recraft vector models. */
export const VECTOR_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', 'auto']);

/** Aspect ratios accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', 'auto']);

/** Resolution tiers accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RESOLUTIONS = Object.freeze(['512', '1K', '2K', '4K']);

/** */
const IMAGE_SIZES_BY_RESOLUTION = {
    '512': [
        '512x512',
    ],
    '1k': [
        // Ваши поддерживаемые размеры 1k
        '1024x768',
        '768x1024',
        '1024x1024',
    ],
    '2k': [
        // Нативные размеры модели
        '1024x1536',
        '1536x1024',

        // Остальные размеры, если модель их поддерживает
        '2048x1536',
        '1536x2048',
        '2048x2048',
    ],
    '4k': [
        '4096x3072',
        '3072x4096',
        '4096x4096',
    ],
};

function parseImageSize(value) {
    const match = /^(\d+)\s*x\s*(\d+)$/.exec(value);
    if (!match) return null;

    const width = Number(match[1]);
    const height = Number(match[2]);

    if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) {
        return null;
    }

    return { width, height };
}

function getOrientation({ width, height }) {
    if (width === height) return 'square';
    return height > width ? 'portrait' : 'landscape';
}

function getAspectDifference(a, b) {
    return Math.abs(Math.log((a.width / a.height) / (b.width / b.height)));
}

function inferResolution({ width, height }) {
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
function tierFromToken(value) {
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
function presetImageSize(value) {
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

const MIN_IMAGE_PIXELS = (model = null)=>model?.trim?.()?.endsWith?.("riverflow-v2.6-pro")?16_384:655_360;
const MAX_IMAGE_PIXELS = (model = null)=>model?.trim?.()?.endsWith?.("riverflow-v2.6-pro")?16_777_216:8_294_400;
const MAX_IMAGE_EDGE   = (model = null)=>model?.trim?.()?.endsWith?.("riverflow-v2.6-pro")?4096:3840;
const MAX_IMAGE_RATIO  = (model = null)=>model?.trim?.()?.endsWith?.("riverflow-v2.6-pro")?16:3;

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

//
const makePad16Size = (value)=>{
    const size = parseImageSize(value = value.trim().replace(/\s+/g, ''));
    if (!size || size == 'auto') return size;
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
function nearestRiverflowRatio(sizePixels) {
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
 * Ordered image-size attempts: the exact request, a valid same-ratio size, then the nearest
 * fallback. For tier-based models (riverflow) the fallback is `aspect_ratio` + `resolution`;
 * for preset-based models it is the nearest IMAGE_SIZES entry. For models that may reject the
 * `size` field entirely (`omitSizeOnReject`), a null entry is appended so the caller retries
 * with the field omitted.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @returns {(string | null)[]}
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

    // Tier-based models: fallback to aspect_ratio (nearest from the model's native set)
    // instead of a hard-coded OpenAI preset that breaks the aspect ratio.
    if (RIVERFLOW.test(String(model ?? ''))) {
        const ratio = nearestRiverflowRatio(initial);
        if (ratio && !attempts.includes(ratio)) attempts.push(ratio);
    } else {
        // The last resort is the most compatible frame the family documents, not a tier frame.
        const preset = presetImageSize(initial);
        if (preset && !attempts.includes(preset)) attempts.push(preset);
    }

    if (profile.omitSizeOnReject) attempts.push(null);
    return attempts;
}

/**
 * `images` uses /images/generations and /images/edits. `responses` uses the Responses image_generation tool.
 * A proxyapi.ru host selects `images` unless image.transport is set. Any other gateway only gets the
 * images route when its own backend entry declares it or when `imagesBackends` is configured.
 * The Responses image tool is a server-side feature most OpenAI-compatible hosts do not implement,
 * while /images/generations is.
 * @param {{ baseURL?: string, apiKey?: string, backends?: object[], imagesBackends?: object[], image?: { transport?: string | null } }} config
 * @returns {'images' | 'responses'}
 * @exports
 * @ai.hint pure
 */
export function imageTransport(config) {
    const chosen = config?.image?.transport;
    if (chosen === 'images' || chosen === 'responses') return chosen;
    // A named images pool selects the images transport: the entries only have to serve /images routes.
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

/**
 * Model id for an images API call. ProxyAPI needs an explicit id such as openai/gpt-image-2.6-sunburst.
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
 * OpenAI image models and OpenAI-compatible proxies accept `output_format`; Recraft and most
 * other vendors accept only `image_format`.
 * @param {string | null | undefined} model
 * @returns {'output_format' | 'image_format'}
 * @exports
 * @ai.hint pure
 */
export function imageFormatField(model) {
    const name = String(model ?? '').trim();
    if (/^(?:openai\/)?gpt-image-/i.test(name)) return 'output_format';
    // Riverflow and Flux-based models on OpenAI-compatible proxies use output_format.
    if (RIVERFLOW.test(name)) return 'output_format';
    return 'image_format';
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
    return (Boolean(version) && version !== '2') || model?.trim?.()?.endsWith?.("riverflow-v2.6-pro");
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
 * `references` are `data:` URLs of source pictures for an image-conditioned generation
 * (`input_references`), used by the families whose edit route ignores the tuning fields.
 * `resolution` is an optional tier (512/1K/2K/4K) that selects a frame from the tier table.
 * @param {{ model: string, prompt: string, size?: string | null, complexity?: string | null, n?: number | null, format?: string | null, background?: string | null, references?: string[] | null, resolution?: string | null }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function generationBody({ model, prompt, size = null, complexity = null, n = null, format = null, background = null, references = null, resolution = null, sizeHint = 'auto' }) {
    const body = { model, prompt };
    if (Array.isArray(references) && references.length) {
        body.input_references = references.map((url) => ({ type: 'image_url', image_url: { url } }));
    }
    if (isVectorModel(model)) {
        const aspect = normalizeVectorRatio(size);
        if (aspect) body.aspect_ratio = aspect;
        if (Number.isInteger(n) && n > 1) body.n = n;
        body[imageFormatField(model)] = 'svg';
        //if (acceptsResponseFormat(model)) body.response_format = 'b64_json';
        body.prompt = withSizeHint(prompt, body, model, sizeHint);
        return body;
    }
    const fields = imageSizeFields(size, model, resolution);
    // A tier or ratio request carries its own field; `normalizeImageSize` leaves an unknown token
    // like `2K` untouched, so it must not leak into `size` beside `resolution`.
    if (fields.size) body.size = fields.size;
    else if (!fields.resolution && !fields.aspect_ratio) {
        const frame = imageRequestSize(size, model, resolution);
        if (frame) body.size = frame;
    }
    if (fields.resolution) body.resolution = fields.resolution;
    if (fields.aspect_ratio) body.aspect_ratio = fields.aspect_ratio;
    // The frame asked for in fields is repeated in the prompt for the families whose gateway is
    // known to drop those fields: the text survives where the field does not.
    body.prompt = withSizeHint(prompt, body, model, sizeHint);
    // Recraft swaps `-pro` for non-pro at small sizes; Riverflow keeps its suffix at any size.
    const caps = imageModelProfile(model);
    if (!caps.keepProSuffix) {
        const sizePair = body.size?.split?.('x')?.map((n) => parseInt(n || '0'));
        if (sizePair?.[0] <= 1024 && sizePair?.[1] <= 1024) {
            body.model = body.model?.replace?.(/\-pro$/, '') || body.model;
        }
    }
    const cx = imageComplexityValue({ model, complexity });
    if (cx) body.complexity = cx;
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
 * A gateway that ignores `response_format` answers with `url` instead; those rows are skipped here,
 * so use `imageSources` when both shapes have to work.
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
 * Every image a response carries, in the order returned, as either inline base64 or a URL to
 * fetch. Gateways differ here: OpenAI and ProxyAPI honor `response_format: b64_json`, while many
 * OpenAI-compatible hosts always return `data[].url`. Reading only one of the two fields made the
 * same call succeed on one backend and fail with "нет b64_json" on another.
 * @param {object} body
 * @returns {Array<{ kind: 'b64' | 'url', value: string }>}
 * @exports
 * @ai.hint pure
 */
export function imageSources(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    const out = [];
    for (const row of rows) {
        if (typeof row?.b64_json === 'string' && row.b64_json.trim()) out.push({ kind: 'b64', value: row.b64_json.trim() });
        else if (typeof row?.url === 'string' && row.url.trim()) out.push({ kind: 'url', value: row.url.trim() });
    }
    return out;
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
 * Pixel frame read straight from encoded bytes — PNG IHDR, JPEG SOF, WebP (VP8/VP8L/VP8X) and GIF.
 * No raster engine is involved, so the frame of a source picture survives a bundled build where
 * sharp or ImageMagick may be missing. Null means the buffer is not a readable raster, and the
 * caller leaves the frame to the gateway default.
 * @param {Buffer | Uint8Array | null | undefined} buffer
 * @returns {{ width: number, height: number } | null}
 * @exports
 * @ai.hint pure
 */
export function readImageSize(buffer) {
    if (!buffer || buffer.length < 10) return null;
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const tag = (at) => b.length >= at + 4 && String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
    const u16be = (at) => (b[at] << 8) | b[at + 1];
    const u32be = (at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
    const u32le = (at) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + (b[at + 3] << 24);
    const frame = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

    // PNG: the IHDR chunk sits at a fixed offset behind the eight-byte signature.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        if (b.length < 24 || tag(12) !== 'IHDR') return null;
        return frame(u32be(16), u32be(20));
    }
    // GIF: two little-endian 16-bit fields at a fixed offset.
    if (tag(0) === 'GIF8') return frame(b[6] | (b[7] << 8), b[8] | (b[9] << 8));
    // WebP: the frame lives in the first of three possible chunk kinds.
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
    // JPEG: walk the marker chain to the first SOF that carries the frame.
    if (b[0] === 0xff && b[1] === 0xd8) {
        for (let i = 2; i + 9 < b.length;) {
            if (b[i] !== 0xff) { i += 1; continue; }
            let marker = b[i + 1];
            while (marker === 0xff && i + 2 < b.length) { i += 1; marker = b[i + 1]; }
            // Start of scan or end of image: no frame header in what is left.
            if (marker === 0xda || marker === 0xd9) return null;
            // Standalone markers carry no length field.
            if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            // SOF0..SOF15 except DHT (C4), JPEG lossless (C8) and arithmetic (CC).
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return frame(u16be(i + 7), u16be(i + 5));
            }
            const length = u16be(i + 2);
            if (length < 2) return null;
            i += 2 + length;
        }
        return null;
    }
    return null;
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

/**
 * Gate: return true when the model family is known to be sensitive to size resolution.
 * These families have a tuning field (`resolution`/`aspect_ratio`) rather than a raw frame:
 * the gateway may ignore an unrecognised pixel string and answer with its default square.
 * @param {object} caps Image capabilities from imageModelProfile.
 * @returns {boolean}
 * @ai.hint pure
 */
function isSizeFinicky(caps) {
    return caps.resolutionTiers || caps.routeEditsThroughGeneration || caps.omitSizeOnReject;
}

/**
 * Repeat the requested output frame in the prompt text. Gateway proxies sometimes drop the
 * `size`/`resolution`/`aspect_ratio` fields and answer with their default square; the text
 * hint survives in those cases. Applied only for families known to be size-sensitive
 * (resolution-tuned gateways); preset-only models like gpt-image get a clean prompt.
 * @param {string} prompt Original prompt.
 * @param {{ size?: string, resolution?: string, aspect_ratio?: string }} fields Computed size fields.
 * @param {string|null} [model] Model id (null → no profile match).
 * @param {'auto'|'always'|'never'} [mode] 'auto' = gate on profile; 'always' = always; 'never' = never.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function withSizeHint(prompt, fields = {}, model = null, mode = 'auto') {
    const text = String(prompt ?? '');
    const parts = [];
    if (fields.size) parts.push(`size ${fields.size}`);
    if (fields.resolution) parts.push(`resolution ${fields.resolution}`);
    if (fields.aspect_ratio && fields.aspect_ratio !== 'auto') parts.push(`aspect ratio ${fields.aspect_ratio}`);
    if (!parts.length) return text;
    if (mode === 'never') return text;
    // Our own marker: the hint is added once per rebuilt body, never twice.
    if (/Requested output:/i.test(text)) return text;
    const caps = imageModelProfile(model);
    if (mode === 'auto' && !isSizeFinicky(caps)) return text;
    return `${text}\n\nRequested output: ${parts.join(', ')}. Keep this exact frame and aspect ratio.`;
}
