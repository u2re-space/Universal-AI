

/** Names that choose a common frame instead of a literal WIDTHxHEIGHT. */
export const NAMED_FRAMES = { square: 1, landscape: 16 / 10, portrait: 10 / 16 };

/** Raster and vector inputs a comparison or a matte can read. */
export const READABLE_EXT = /\.(png|jpe?g|webp|gif|tiff?|bmp|avif|svg)$/i;

/** Prompt the vector model gets when the caller did not describe the artwork. */
export const DEFAULT_VECTOR_PROMPT = 'Vectorize the attached image exactly as it is: keep the original shapes, palette, and proportions; flat shapes with smooth paths and a transparent background; do not redesign it or add new colors.';

/** Raster extensions worth offering for vectorization. */
export const VECTOR_SOURCE_EXT = /\.(png|webp)$/i;

/** A name that says "this must be a vector": marks, badges, logos, icons. */
export const VECTOR_HINT = /logo|badge|icon|emblem|seal|wordmark|logotype|stamp|марк|логотип|эмблем|знач|наклейк|герб|печать|щит/i;

/** Reasons that mean the raster is already cut out and can go straight to the vector model. */
export const CUT_OUT = new Set(['native', 'mask', 'contour', 'flat', 'key', 'already']);

/** Prompt for a grayscale alpha matte that preserves the subject and cleanly removes its background. */
export const ALPHA_MASK_PROMPT = 'Return an A-mask (matte) for the attached image that will be composited onto an RGB background to produce the final RGBA image. '
    + 'This is the alpha channel of a two-part composition: RGB + A-mask = RGBA. '
    + 'White (255) marks the subject that must stay visible — the artwork, logo, product, or person. '
    + 'Black (0) marks everything that must become transparent, including any checkerboard, grid, or flat plate that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Edges must be anti-aliased: a one- or two-pixel gray transition exactly on the silhouette, not a wide soft glow, and the interior of the subject pure white. '
    + 'The mask must trace the subject contour tightly: a one- or two-pixel gray transition exactly on the silhouette creates a clean anti-aliased edge in the final composite. '
    + 'Do not widen the transition into a soft glow — that makes the rim milky and eats into the artwork. Do not make alpha edges too blurry! '
    + 'The interior of the subject must be pure white; the transparent area must be pure black. '
    + 'Output the matte/mask only: grayscale, no colors, no text, no border, no shadow.';

/**
 * Prompt for the mask pass. A matte rather than a transparent picture: most vendors cannot emit
 * alpha and paint a checkerboard or a flat plate instead, and a matte converts cleanly into a real
 * alpha channel. The matte must be anti-aliased: a one- or two-pixel gray transition along the
 * silhouette is what keeps the cut free of stair-stepping, while a wide soft gradient would make
 * the rim milky and eat into the artwork.
 */
    + 'Return an A-mask (matte) for the attached image that will be composited onto an RGB background to produce the final RGBA image. '
    + 'This is the alpha channel of a two-part composition: RGB + A-mask = RGBA. '
    + 'White (255) marks the subject that must stay visible — the artwork, logo, product, or person. '
    + 'Black (0) marks everything that must become transparent, including any checkerboard, grid, or flat plate that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Edges must be anti-aliased: a one- or two-pixel gray transition exactly on the silhouette, not a wide soft glow, and the interior of the subject pure white. '
    + 'The mask must trace the subject contour tightly: a one- or two-pixel gray transition exactly on the silhouette creates a clean anti-aliased edge in the final composite. '
    + 'Do not widen the transition into a soft glow — that makes the rim milky and eats into the artwork. Do not make alpha edges too blurry! '
    + 'The interior of the subject must be pure white; the transparent area must be pure black. '
    + 'Output the matte/mask only: grayscale, no colors, no text, no border, no shadow.';


/**
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
/*export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same '
    + 'proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or '
    + 'pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';*/

export const BACKGROUND_PAINT_PROMPT = 'You are creating the RGB channel for a two-part RGBA composition (RGB + A-mask = RGBA). '
    + 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. '
    + 'This flat color will serve as the RGB base that the A-mask composites over: no gradients, no texture, no shadow, no new objects.';

/**
 * Paint prompt with an explicit hex color instead of "dominant color of the subject".
 *
 * Used when the model does not reliably pick a color on its own (e.g. riverflow).
 * @param {string} hex — `#RRGGBB`
 * @returns {string}
 * @ai.hint pure
 */
export function paintPromptWithColor(hex) {
    return 'You are creating the RGB channel for a two-part RGBA composition (RGB + A-mask = RGBA). '
        + 'Fill the whole background with the solid color ' + hex + '. '
        + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
        + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. '
        + 'This flat color will serve as the RGB base that the A-mask composites over: no gradients, no texture, no shadow, no new objects.';
}

/**
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
/*export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';*/

/**
 * Minimum frame size in pixels below which softShare is meaningless.
 * For a 1×1 image softShare=1 (the only pixel sits in the mid-alpha band) does not mean a
 * soft edge — it just means the frame is too small for the metric.
 */
export const MIN_SOFT_PIXELS = 100;

/**
 * Share of the frame that must be fully cleared before a picture counts as a real cut-out.
 * A model that cannot emit alpha paints a plate instead, and the only transparent pixels such a
 * reply carries form a thin fringe along the silhouette — well under this share. A genuine
 * background removal clears a large part of the frame, so the threshold separates the two.
 */
export const MIN_CLEARED_SHARE = 0.03;

/**
 * Largest share of the frame allowed to sit in the soft alpha band before a cut-out counts as
 * sloppy. A real one leaves a one- or two-pixel anti-aliased ring (well under 1%); a matte the
 * model drew with a wide glow scores around 20%, and that band is the halo a transparent PNG shows.
 */
export const MAX_SOFT_SHARE = 0.05;

/** Longest side of a comparison sheet when the caller does not ask for a frame. */
export const DEFAULT_MAX_SIDE = 768;

/** Extensions that can carry a clean RGB source (no alpha, no fake plate). */
export const RGB_SOURCE_EXT = /\.(png|webp)$/i;

/** Alpha modes that run model passes (paint + matte). */
export const MODEL_MATES = new Set(['auto', 'mask']);


export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const PERSISTENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 410, 411, 413, 415, 422, 451]);
/** Headers the client sets itself; a custom header must not replace them. */
export const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-client-request-id', 'openai-organization', 'openai-project']);
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Copy the extra body fields of one backend. Values keep their JSON type — a gateway flag such as
 * `useWalletBalance` has to arrive as `true`, not as the string `"true"`. What the request already
 * sets is decided by `withBackendBody`, which never overwrites a field the call itself produced.
 * @param {object|null|undefined} body
 * @returns {Record<string, unknown>}
 * @ai.hint pure
 */
export const RESERVED_BODY = new Set(['model', 'input', 'messages', 'instructions', 'stream', 'tools', 'tool_choice',
    'parallel_tool_calls', 'previous_response_id', 'store', 'background', 'include']);

    
/** OpenAI gpt-image-2.5 family (sunburst, flare, …). */
export const GPT_IMAGE_25 = /^(?:openai\/)?gpt-image-2\.5(?:-|$)/i;
export const GPT_IMAGE_26 = /^(?:openai\/)?gpt-image-2\.6(?:-|$)/i;
/** Sourceful Riverflow family — a Flux-based id such as sourceful/riverflow-v2.6-pro. */
export const RIVERFLOW = /(?:^|\/)riverflow-/i;

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
 *   `minPixels`/`maxPixels`   — the accepted frame area in pixels; a frame outside the range is
 *                     rescaled to the nearest same-ratio size that fits;
 *   `maxEdge`                 — longest side the model accepts;
 *   `maxRatio`                — widest aspect ratio (longest side over shortest).
 * The defaults are the OpenAI gpt-image numbers, which is what a model nobody described gets.
 */
export const IMAGE_CAPABILITIES = Object.freeze({
    customSizes: false, div16Padding: false, keepProSuffix: false, omitSizeOnReject: false,
    complexity: null, routeEditsThroughGeneration: false, resolutionTiers: false,
    /** The gateway answers `background: transparent` with a painted plate instead of an alpha channel. */
    paintsFakeTransparency: false,
    minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3,
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
 * Riverflow takes a far smaller frame than gpt-image (128x128 is already legal) and a much wider
 * ratio, so its limits are spelled out here rather than guessed from the model id.
 */
export const IMAGE_MODEL_PROFILES = Object.freeze([
    Object.freeze({ match: GPT_IMAGE_26, customSizes: true, div16Padding: true, complexity: 'high', minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3 }),
    Object.freeze({ match: GPT_IMAGE_25, customSizes: true, div16Padding: true }),
    Object.freeze({ match: RIVERFLOW, customSizes: true, keepProSuffix: true, omitSizeOnReject: true, complexity: 'high', routeEditsThroughGeneration: true, resolutionTiers: true, paintsFakeTransparency: true, minPixels: 16_384, maxPixels: 16_777_216, maxEdge: 4096, maxRatio: 16 }),
]);

/**
 * Capabilities of one image model id, merged over the defaults.
 * @param {string | null | undefined} model
 * @returns {{ customSizes: boolean, div16Padding: boolean, keepProSuffix: boolean, omitSizeOnReject: boolean, complexity: string|null, routeEditsThroughGeneration: boolean, resolutionTiers: boolean, paintsFakeTransparency: boolean, minPixels: number, maxPixels: number, maxEdge: number, maxRatio: number }}
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
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
/*export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same '
    + 'proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or '
    + 'pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';*/

/** Raster matte formats ImageMagick can read. */
export const MASK_EXT = /\.(png|webp|jpe?g)$/i;


/**
 * A short guard for requests that carry a source picture: cut-out and restyle models tend to
 * decorate the answer with captions, frames or an invented scene when the prompt stays silent.
 * Nothing else belongs in the prompt: the frame travels in the `size`/`resolution`/`aspect_ratio`
 * fields, transparency is requested through `background`, and the two-part RGBA composition
 * (painted RGB base + A-mask) is assembled locally by image-alpha.js from its own technical
 * prompts sent to the clean source. Inlining those texts here asked the model to repaint the
 * background with the subject color and to draw a matte in the same reply as the artwork —
 * it obeyed both and stopped isolating the subject.
 */
export const SOURCE_GUARD = 'Do not add text, numbers, watermarks, or frames. Do not invent a new background or extra objects: keep the subject exactly as in the source unless the request changes it.';

/**
 * One extra line for the families whose gateway answers `background: transparent` with a drawn
 * plate: a single flat color is what the local matte can remove cleanly, while a checkerboard
 * or a gradient survives as a halo. This is not the two-pass RGBA recipe — the model returns one
 * picture, so only the RGB base is asked for here, and the matte stays a local step.
 */
export const FLAT_PLATE_NOTE = 'Background: one flat solid color, uniform across the whole area, with no checkerboard, grid, gradient, texture, or shadow.';

// TODO: make smart aspect ratio support (more than regular 1:1, 3:2, 2:3, 4:3 or 3:4)
/** Sizes accepted by POST /images/generations and /images/edits. */
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024']);

// TODO: make smart aspect ratio support (more than regular 1:1, 3:2, 2:3, 4:3 or 3:4)
/** Aspect ratios accepted by recraft vector models. */
export const VECTOR_RATIOS = Object.freeze(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', 'auto']);

// TODO: make smart aspect ratio support (more than regular 1:1, 3:2, 2:3, 4:3 or 3:4)
export const PORTRAIT_SIZES = {
    "512": "384x512",
    "1k":  "768x1024",
    "2k": "1536x2048",
    "4k": "3072x4096"
}

// TODO: make smart aspect ratio support (more than regular 1:1, 3:2, 2:3, 4:3 or 3:4)
export const LANDSCAPE_SIZES = {
    "512": "512x384",
    "1k": "1024x768",
    "2k": "2048x1536",
    "4k": "4096x3072"
}

// TODO: make smart aspect ratio support (more than regular 1:1, 3:2, 2:3, 4:3 or 3:4)
export const SQUARE_SIZES = {
    "512": "512x512",
    "1k": "1024x1024",
    "2k": "2048x2048",
    "4k": "4096x4096"
}

/**
 * Frame limits of one model, read from its profile. Kept as functions because the call sites ask
 * for a limit by model id; the numbers themselves live in `IMAGE_MODEL_PROFILES`.
 * @param {string|null|undefined} model
 * @returns {number}
 * @ai.hint pure
 */
export const MIN_IMAGE_PIXELS = (model = null) => imageModelProfile(model).minPixels;
export const MAX_IMAGE_PIXELS = (model = null) => imageModelProfile(model).maxPixels;
export const MAX_IMAGE_EDGE   = (model = null) => imageModelProfile(model).maxEdge;
export const MAX_IMAGE_RATIO  = (model = null) => imageModelProfile(model).maxRatio;

/** Aspect ratios accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', 'auto']);

/** Resolution tiers accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RESOLUTIONS = Object.freeze(['512', '1K', '2K', '4K']);

// TODO: make smart aspect ratio support (more than regular 1:1, 3:2, 2:3, 4:3 or 3:4)
/** */
export const IMAGE_SIZES_BY_RESOLUTION = {
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
