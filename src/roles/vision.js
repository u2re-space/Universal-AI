/**
 * @file src/roles/vision.js
 * @module roles/vision
 * @purpose Vision prompts for a full image description and a screenshot JSON report.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, screenInstructions, settings
 * @ai.tags roles, vision, screenshot
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
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
 * Low reasoning effort for the vision role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'low' };
