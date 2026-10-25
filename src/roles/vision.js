/**
 * @file src/roles/vision.js
 * @module roles/vision
 * @purpose Vision prompts and image-size tiers.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/roles
 * @exports instructions, screenInstructions, settings, VISION_TIERS, imageLongSide, visionChoice
 * @ai.tags roles, vision, screenshot
 * @ai.hint pure
 * @changed 2026-10-20 Model and effort follow the long side of the image.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the vision role: describe an image in plain text for an agent that cannot see it.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the vision specialist. Describe the given image precisely and completely for another AI agent that cannot see it:
layout, text (transcribe exactly), UI elements, charts (axes, values, trends), code or diagrams, errors, colors when relevant.
If a question is given, answer it first, then add the supporting description. Plain text.`;
/**
 * Prompt that returns JSON elements for one screenshot a clicker or typer will use.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const screenInstructions = `You describe one screenshot for another agent that will click or type.
Return JSON only: summary (what is on screen), elements (name, visible text, x, y, width, height in screenshot pixels; use null when unknown), and notes.
Transcribe visible text. Do not invent controls that are not visible. ${UNTRUSTED}`;
/**
 * Fallback settings. Callers replace model and effort from {@link visionChoice} unless config pins them.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: null, model: null };

/** Model and effort for a small crop, a medium image, and a screenshot or large image. */
export const VISION_TIERS = Object.freeze({
    trivial: Object.freeze({ model: 'gpt-6-luna', effort: 'medium' }),
    normal: Object.freeze({ model: 'gpt-6-luna', effort: 'high' }),
    complex: Object.freeze({ model: 'gpt-6.1-sol', effort: 'high' }),
});

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
 * Model and effort for this image. A screen capture uses the complex tier. A configured model or effort replaces the tier.
 * @param {number | null | undefined} longSide
 * @param {{ model?: string | null, effort?: string | null }} [configured]
 * @param {{ screen?: boolean }} [options]
 * @returns {{ model: string, effort: string }}
 * @exports
 * @ai.hint pure
 */
export function visionChoice(longSide, configured = {}, { screen = false } = {}) {
    const tier = screen ? VISION_TIERS.complex : VISION_TIERS[band(longSide)];
    return {
        model: configured.model || tier.model,
        effort: configured.effort || tier.effort,
    };
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
