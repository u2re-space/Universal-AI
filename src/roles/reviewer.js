/**
 * @file src/roles/reviewer.js
 * @module roles/reviewer
 * @purpose Reviewer prompts (review, single-claim check, image and screen description) and the
 *   image size band that picks a role tier.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/roles, agent/pace, core/config
 * @exports instructions, checkInstructions, visionInstructions, visionScreenInstructions,
 *   imageLongSide, imageTier, FORBIDDEN_MODELS, FALLBACK_MODEL, safeReviewerModel
 * @ai.tags roles, review, vision, screenshot
 * @ai.hint pure
 * @changed 2026-10-31 Merged the former tester and vision roles into the reviewer.
 */

import { DESKTOP_NOTE, UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the reviewer: accept the result or list concrete revisions from evidence.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the independent reviewer. Verify that the task is actually accomplished and nothing is broken.
You get the task, plan, acceptance criteria, worker reports and the full diff of changes; you may inspect files with read-only tools
and run commands (tests, build) if available. Judge by evidence: a green test alone does not prove the task is done; unverifiable
claims are issues. "accept" only when the task is met with no high-severity issues; otherwise "revise" with concrete, actionable issues
(path + requested change). When the shared context contains the architect's brief, check that the result follows its file/module
structure, interfaces, and conventions; report a real deviation as an issue, not a stylistic preference.
Reply in JSON only. ${DESKTOP_NOTE} ${UNTRUSTED}`;

/**
 * Prompt for the former tester: pass or fail one claim from evidence.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const checkInstructions = `You check whether the step's result is actually true. Use the screenshot tool when the result is on screen.
Pass only with evidence from the screen or from text you were given. Report pass or fail, what you observed, and what is still unverified. Do not click or type. ${UNTRUSTED}`;

/**
 * Prompt for the former vision role: describe an image in plain text for an agent that cannot see it.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const visionInstructions = `You are the vision specialist. Describe the given image precisely and completely for another AI agent that cannot see it:
layout, text (transcribe exactly), UI elements, charts (axes, values, trends), code or diagrams, errors, colors when relevant.
If a question is given, answer it first, then add the supporting description. Plain text.`;

/**
 * Prompt that returns JSON elements for one screenshot a clicker or typer will use.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const visionScreenInstructions = `You describe one screenshot for another agent that will click or type.
Return JSON only: summary (what is on screen), elements (name, visible text, x, y, width, height in screenshot pixels; use null when unknown), and notes.
Transcribe visible text. Do not invent controls that are not visible. ${UNTRUSTED}`;

/** Models the reviewer must never run on. Validated in config.js and clamped in pace/config. */
export const FORBIDDEN_MODELS = Object.freeze(['gpt-6-astra']);
/** Replacement when a forbidden model is inherited from the default role or the pace ladder. */
export const FALLBACK_MODEL = 'gpt-6.1-terra';

/**
 * Replace a forbidden reviewer model with the safe fallback.
 * @param {string|null|undefined} model
 * @param {string} [fallback]
 * @returns {string|null|undefined}
 * @exports
 * @ai.hint pure
 */
export function safeReviewerModel(model, fallback = FALLBACK_MODEL) {
    return FORBIDDEN_MODELS.includes(model) ? fallback : model;
}

/**
 * Longer side in pixels, or null when the header does not say.
 * @param {Buffer | Uint8Array | null | undefined} buffer
 * @returns {number | null}
 * @exports
 * @ai.hint pure
 */
export function imageLongSide(buffer) {
    if (!buffer || buffer.length < 10) return null;
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        if (bytes.length < 24) return null;
        return positive(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)));
    }
    if (bytes.length >= 10 && bytes.subarray(0, 3).toString('latin1') === 'GIF') {
        return positive(Math.max(bytes.readUInt16LE(6), bytes.readUInt16LE(8)));
    }
    if (bytes.length >= 16 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
        return webpLongSide(bytes);
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegLongSide(bytes);
    return null;
}

/**
 * Complexity tier of this image: a small crop is trivial, a medium image is normal, a large
 * image or a screenshot is complex. The model and effort come from roles.reviewer.tiers.
 * @param {number | null | undefined} longSide
 * @param {{ screen?: boolean }} [options]
 * @returns {'trivial' | 'normal' | 'complex'}
 * @exports
 * @ai.hint pure
 */
export function imageTier(longSide, { screen = false } = {}) {
    return screen ? 'complex' : band(longSide);
}

/**
 * @param {number | null | undefined} longSide
 * @returns {'trivial' | 'normal' | 'complex'}
 * @ai.hint pure
 */
function band(longSide) {
    if (!Number.isFinite(longSide) || longSide <= 0) return 'normal';
    if (longSide <= 512) return 'trivial';
    if (longSide <= 1280) return 'normal';
    return 'complex';
}

/**
 * @param {number} value
 * @returns {number | null}
 * @ai.hint pure
 */
function positive(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * @param {Buffer} bytes
 * @returns {number | null}
 * @ai.hint pure
 */
function jpegLongSide(bytes) {
    let offset = 2;
    const end = Math.min(bytes.length, 65536);
    while (offset + 8 < end) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
            return positive(Math.max(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 7)));
        }
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
            offset += 2;
            continue;
        }
        const size = bytes.readUInt16BE(offset + 2);
        if (size < 2) return null;
        offset += 2 + size;
    }
    return null;
}

/**
 * @param {Buffer} bytes
 * @returns {number | null}
 * @ai.hint pure
 */
function webpLongSide(bytes) {
    const kind = bytes.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X' && bytes.length >= 30) {
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return positive(Math.max(width, height));
    }
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
        const bits = bytes.readUInt32LE(21);
        return positive(Math.max((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
    }
    if (kind === 'VP8 ' && bytes.length >= 30) {
        const start = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 12);
        if (start >= 0 && start + 7 < bytes.length) {
            return positive(Math.max(bytes.readUInt16LE(start + 3) & 0x3fff, bytes.readUInt16LE(start + 5) & 0x3fff));
        }
    }
    return null;
}
