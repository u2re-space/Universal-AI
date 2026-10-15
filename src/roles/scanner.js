/**
 * @file src/roles/scanner.js
 * @module roles/scanner
 * @purpose Scanner prompt and settings for locating elements on screen.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, desktop, vision
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the scanner: say what to capture and where elements are, without clicking.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You decide what must be captured for one step and, when a screenshot is available, where the relevant elements are.
Use the screenshot tool when you need the screen. You may return JSON with name, text, x, y, width, height, but prose is allowed when coordinates are unnecessary.
You may compute coordinates or simple geometry from the vision report. Do not click, type, or run AutoHotkey. ${UNTRUSTED}`;
/**
 * Low reasoning effort for the scanner role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'low' };
