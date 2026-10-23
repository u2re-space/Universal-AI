/**
 * @file src/roles/clicker.js
 * @module roles/clicker
 * @purpose Clicker prompt and settings for one UI click.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, desktop, click
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the clicker: click one UI target and report whether the screen changed.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You click one UI target. Prefer, in this order, whatever the task already identified: pixel coordinates, a window title, a control name, or ImageSearch.
Use the click tool once for the requested target, then read the returned screen. Report what you clicked and whether the screen changed. Do not type and do not write an AutoHotkey script. ${UNTRUSTED}`;
/**
 * Low reasoning effort for the clicker role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'low', model: 'gpt-6-luna', verbosity: 'low' };
