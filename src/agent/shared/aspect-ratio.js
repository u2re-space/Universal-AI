/**
 * @file src/openai/shared/aspect-ratio.js
 * @module openai/shared/aspect-ratio
 * @purpose Aspect ratios as fractions: read any shape token, reduce it to small whole terms, and
 *   turn it into the frame or the supported ratio a model can actually take.
 * @exports RATIO_MAX_TERM, RATIO_CEIL_EPSILON, RATIO_WORDS, STANDARD_RATIOS, ceilAspect, aspectOf,
 *   parseAspectToken, rationalAspect, nearestAspect, aspectFrame
 * @ai.hint pure
 */

/**
 * Largest numerator or denominator a smart ratio may keep. 32 still spells the wide cinema frame
 * 2.39:1 as 31:13 (0.2% off) and keeps every ordinary preset (16:9, 5:4, 21:9) exact, while
 * refusing the useless 1919:1079 ladder a raw gcd would produce.
 */
export const RATIO_MAX_TERM = 32;

/**
 * How close to a whole number a frame multiplier may sit and still snap down to it. A frame is
 * rounded up so the picture never comes back smaller than the budget asked for, but a multiplier
 * that only overshoots a whole step by a hair of a pixel (15.998) is the whole step, not the next
 * one — without this the 0.002 rounding noise of a float ratio would inflate the frame a full step.
 */
export const RATIO_CEIL_EPSILON = 0.005;

/**
 * Shapes a ratio-only gateway has to choose between when the request names none of its own list,
 * and the catalogue a free-frame model rounds to when the caller asks for a shape by name.
 */
export const STANDARD_RATIOS = Object.freeze([
    '1:1', '5:4', '4:5', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16', '16:9', '9:16',
    '5:3', '3:5', '2:1', '1:2', '21:9', '9:21', '5:2', '2:5',
]);

/** Words that name a shape, so a caller can ask for `wide` or `cinemascope` instead of numbers. */
export const RATIO_WORDS = Object.freeze({
    square: '1:1', portrait: '3:4', landscape: '4:3',
    photo: '3:2', print: '3:2', classic: '4:3', monitor: '16:10', desktop: '16:10',
    widescreen: '16:9', wide: '16:9', banner: '16:9', presentation: '16:9',
    ultrawide: '21:9', superwide: '32:9', cinema: '1.9:1', cinemascope: '2.39:1',
    scope: '2.39:1', anamorphic: '2.39:1', golden: '1.618:1',
    tall: '9:16', vertical: '9:16', story: '9:16', reel: '9:16', short: '9:16',
    a4: '210:297', letter: '8.5:11', passport: '35:45', thumbnail: '1:1', avatar: '1:1',
});

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;

/**
 * Round a frame multiplier up, except when it already touches a whole number within `epsilon`:
 * such a value is that whole number. Rounding up keeps the frame from coming back smaller than the
 * pixel budget asked for; the epsilon keeps float noise (15.998 of a 16-pixel step) from costing a
 * whole extra step.
 * @param {number} value
 * @param {number} [epsilon] how close to a whole number still counts as whole
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function ceilAspect(value, epsilon = RATIO_CEIL_EPSILON) {
    if (!Number.isFinite(value)) return value;
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= epsilon ? nearest : Math.ceil(value);
}

/**
 * Read a shape out of any token: `16:9`, `2.39:1`, `2.39`, `1920x1080`, `1920/1080`, or a word from
 * `RATIO_WORDS`. A bare integer names a resolution tier (`512`, `2048`) rather than a shape, so it
 * is left to `tierFromToken`; a bare decimal (`1.85`) is the shape 1.85:1.
 * @param {string|number|null|undefined} value
 * @returns {{ width: number, height: number, ratio: number } | null}
 * @exports
 * @ai.hint pure
 */
export function parseAspectToken(value) {
    let token = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!token || token === 'auto') return null;
    if (RATIO_WORDS[token]) token = RATIO_WORDS[token];
    const match = /^(\d+(?:\.\d+)?)(?:[:x/](\d+(?:\.\d+)?))?$/.exec(token);
    if (!match) return null;
    const width = Number(match[1]);
    const height = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (match[2] === undefined && Number.isInteger(width) && width > RATIO_MAX_TERM) return null;
    return { width, height, ratio: width / height };
}

/**
 * The shape one token, number, or frame names as a real number (width over height), or null when
 * it names no shape at all.
 * @param {string|number|{width: number, height: number}|null|undefined} value
 * @returns {number|null}
 * @exports
 * @ai.hint pure
 */
export function aspectOf(value) {
    if (value && typeof value === 'object') {
        const width = Number(value.width);
        const height = Number(value.height);
        return width > 0 && height > 0 ? width / height : null;
    }
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    return parseAspectToken(value)?.ratio ?? null;
}

/**
 * The requested shape as a fraction with small whole terms: the closest `a:b` with both terms
 * within `maxTerm`. This is what turns 2.39:1 into 31:13, 1000x600 into 5:3, and 1919x1079 into
 * 16:9, so a free-frame model builds a real frame and a ratio-only model picks a real preset
 * instead of giving up on the shape.
 * @param {string|number|{width: number, height: number}} value
 * @param {number} [maxTerm] largest numerator and denominator the fraction may use
 * @returns {{ width: number, height: number, ratio: number, exact: boolean } | null}
 * @exports
 * @ai.hint pure
 */
export function rationalAspect(value, maxTerm = RATIO_MAX_TERM) {
    const wanted = aspectOf(value);
    if (!wanted) return null;
    const limit = Math.max(1, Math.floor(maxTerm));
    let best = null;
    for (let height = 1; height <= limit; height++) {
        const width = Math.round(wanted * height);
        if (!width || width > limit) continue;
        const delta = Math.abs(Math.log(width / height) - Math.log(wanted));
        const terms = width + height;
        if (!best || delta < best.delta - 1e-12
            || (Math.abs(delta - best.delta) <= 1e-12 && terms < best.terms)) {
            best = { width, height, delta, terms };
        }
    }
    // Nothing fits under the limit (an extreme shape such as 40:1): take the widest one it allows.
    if (!best) best = wanted >= 1 ? { width: limit, height: 1 } : { width: 1, height: limit };
    const divisor = gcd(best.width, best.height);
    const width = best.width / divisor;
    const height = best.height / divisor;
    return { width, height, ratio: width / height, exact: (best.delta ?? 0) <= 1e-9 };
}

/**
 * The closest shape a model actually accepts, returned as the ratio string the gateway expects
 * (`4:5`). Distances are logarithmic, so 21:9 wins over 16:9 for 2.39:1 and 4:5 wins over 3:4 for
 * a 1000x1250 source. `auto` is skipped: it is the absence of a shape, not the widest one.
 * @param {string|number|{width: number, height: number}} value
 * @param {readonly string[]} [ratios] shapes the model accepts
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function nearestAspect(value, ratios = STANDARD_RATIOS) {
    const wanted = aspectOf(value);
    if (!wanted) return null;
    let best = null;
    for (const candidate of ratios ?? []) {
        const parsed = parseAspectToken(candidate);
        if (!parsed) continue;
        const delta = Math.abs(Math.log(parsed.ratio) - Math.log(wanted));
        if (best === null || delta < best.delta - 1e-12) best = { ratio: candidate, delta };
    }
    return best?.ratio ?? null;
}

/**
 * A real frame for one shape: whole pixels, each side a multiple of `step`, inside the pixel and
 * edge limits, as close as the shape allows to the requested pixel budget. The fraction of the
 * shape (terms within `RATIO_MAX_TERM`) is scaled by a whole number of `step`-sized increments,
 * rounded up with the `RATIO_CEIL_EPSILON` stickiness — the frame never lands under the budget,
 * and 16:9 at one megapixel is 1536x864 rather than the 1280x720.44 the raw ratio would give.
 * @param {string|number|{width: number, height: number}} value
 * @param {{ step?: number, minPixels?: number, maxPixels?: number, maxEdge?: number,
 *   maxRatio?: number, pixels?: number|null }} [limits]
 * @returns {{ width: number, height: number, ratio: number }|null} null when no frame satisfies
 *   the shape inside the limits (a ratio wider than `maxRatio` after clamping, a tier too small
 *   for the model's minimum area)
 * @exports
 * @ai.hint pure
 */
export function aspectFrame(value, {
    step = 1, minPixels = 1, maxPixels = Number.POSITIVE_INFINITY,
    maxEdge = Number.POSITIVE_INFINITY, maxRatio = Number.POSITIVE_INFINITY, pixels = null,
} = {}) {
    const wanted = aspectOf(value);
    if (!wanted) return null;
    const ceiling = Number.isFinite(maxRatio) && maxRatio >= 1 ? maxRatio : Number.POSITIVE_INFINITY;
    const clamped = Math.min(Math.max(wanted, 1 / ceiling), ceiling);
    const terms = rationalAspect(clamped, RATIO_MAX_TERM);
    if (!terms) return null;
    const { width: ratioWidth, height: ratioHeight } = terms;
    const stepSize = Math.max(1, Math.round(step));
    // The smallest multiplier that still lands both sides on a whole multiple of `step`.
    const multiplierStep = lcm(stepSize / gcd(ratioWidth, stepSize), stepSize / gcd(ratioHeight, stepSize));
    const ratioArea = ratioWidth * ratioHeight;
    // Limits counted in whole `multiplierStep` increments, so every candidate is a legal frame.
    const lowest = Math.ceil(Math.sqrt(Math.max(1, minPixels) / ratioArea) / multiplierStep);
    const highestEdge = Number.isFinite(maxEdge) ? maxEdge / Math.max(ratioWidth, ratioHeight) : Number.POSITIVE_INFINITY;
    const highestArea = Number.isFinite(maxPixels) ? Math.sqrt(maxPixels / ratioArea) : Number.POSITIVE_INFINITY;
    const highest = Math.floor(Math.min(highestEdge, highestArea) / multiplierStep);
    if (!Number.isFinite(highest)) {
        // Neither an area nor an edge limit: the pixel budget alone decides, rounded up.
        const steps = Math.max(lowest, 1, ceilAspect(Math.sqrt(Math.max(1, pixels ?? minPixels) / ratioArea) / multiplierStep));
        return { width: ratioWidth * steps * multiplierStep, height: ratioHeight * steps * multiplierStep, ratio: ratioWidth / ratioHeight };
    }
    if (highest < lowest || highest < 1) return null;
    // A shape with no pixel budget of its own is asked at the model's smallest legal frame.
    const budget = Number.isFinite(pixels) && pixels > 0
        ? Math.min(Math.max(pixels, Math.max(1, minPixels)), Number.isFinite(maxPixels) ? maxPixels : pixels)
        : Math.max(1, minPixels);
    const steps = Math.min(highest, Math.max(lowest, ceilAspect(Math.sqrt(budget / ratioArea) / multiplierStep)));
    if (!Number.isFinite(steps) || steps < 1) return null;
    const multiplier = steps * multiplierStep;
    return { width: ratioWidth * multiplier, height: ratioHeight * multiplier, ratio: ratioWidth / ratioHeight };
}
