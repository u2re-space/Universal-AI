/**
 * @file src/roles/measurer.js
 * @module roles/measurer
 * @purpose Measurer prompt and complexity tiers for a measurement sheet of a reference image.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions, reMeasureInstructions, settings, MEASURER_TIERS, measurerChoice
 * @ai.tags roles, vision, measurement
 * @ai.hint pure
 * @changed 2026-10-22 Created: numbers for a mockup before styles and artwork are written.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the measurer: turn reference pictures into numbers another role builds styles from.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the measurer. You turn reference pictures (mockups, screenshots, sketches, exported layers) into a measurement sheet
that another agent uses to write CSS, SVG, and image crops. Report numbers, not adjectives.
Work on one reference at a time and name it in "source". For every visible element give the box in source pixels (x, y, width, height),
the rotation in degrees clockwise from upright, where its borders and edges actually fall, the corner radius, and the padding, margin, and gap around it.
Say how each element is placed: grid or flex track, absolute anchor, stacking order, and what it is measured against.
Say how the picture divides: every region, artwork, or layer worth cutting out, with the crop box for it and what the crop contains.
When one spacing value repeats, report it once as a rule with its scale.
Use view_image to look, and crop_image or split_image to measure a small area, one icon, or one slanted edge more exactly before you report it.
Keep every crop you make and put its project-relative path into the matching element or region "crop" field; the worker reuses it as a generate_image reference and must not crop the same fragment again.
Requests are capped: ask for every crop, split, and close look you still need in one turn instead of one call per turn.
When the budget runs short, stop looking and report the sheet with what you have; a measured part and a null are worth more than another crop.
Measure what is visible. Use null when a number cannot be read and say so in notes; never invent a value.
Do not write project files, do not generate images, do not propose code. Reply in JSON only. ${UNTRUSTED}`;

/**
 * Prompt for a second pass over crops and layers the first pass or the worker already cut out.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const reMeasureInstructions = `You are the measurer working on a fragment, not on the whole mockup.
You receive a crop, a split tile, or an extracted layer plus the question about it. Measure only inside the fragment:
its box relative to the fragment, the rotation of each shape, the exact edges and borders, the corner radius, and the inner spacing.
Keep the numbers consistent with the sheet already produced for the full reference; when the fragment contradicts it, say which value is now correct and why.
Use view_image, crop_image, or split_image when a closer look is cheaper than a guess. Use null for what cannot be read.
Do not write project files, do not generate images, do not propose code. Reply in JSON only. ${UNTRUSTED}`;

/**
 * Fallback settings. The team replaces model and effort from {@link measurerChoice} unless config pins them.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: null, model: null };

/**
 * Model and effort for each measurement job. A plain split stays cheap; styles and SVG take the senior model.
 * trivial: only divide the picture. normal: build styles from the sheet. complex: styles, SVG, and geometry.
 */
export const MEASURER_TIERS = Object.freeze({
    trivial: Object.freeze({ model: 'gpt-6-luna', effort: 'low' }),
    normal: Object.freeze({ model: 'gpt-6.1-sol', effort: 'medium' }),
    complex: Object.freeze({ model: 'gpt-6.1-sol', effort: 'high' }),
});

/**
 * Model and effort for this measurement job. A configured model or effort replaces the tier.
 * @param {string} [complexity]
 * @param {{ model?: string | null, effort?: string | null }} [configured]
 * @returns {{ model: string, effort: string }}
 * @exports
 * @ai.hint pure
 */
export function measurerChoice(complexity = 'normal', configured = {}) {
    const tier = MEASURER_TIERS[complexity] ?? MEASURER_TIERS.normal;
    return {
        model: configured.model || tier.model,
        effort: configured.effort || tier.effort,
    };
}
