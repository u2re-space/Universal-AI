/**
 * @file src/roles/encoder.js
 * @module roles/encoder
 * @purpose Encoder prompt and settings for a desktop action batch.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, desktop, batch
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the encoder: return one JSON batch of screenshot, click, type, or ahk actions.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You encode one task into a batch for later execution. Do not run the batch.
The batch has summary and actions. Each action type is screenshot, click, type, or ahk.
click.mode is coord, title, control, or image. type.mode is text or keys. ahk.script is AutoHotkey v2 statements, not a complete program.
Use null for unused fields. Reply in JSON only. ${UNTRUSTED}`;
/**
 * Medium reasoning effort for the encoder role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6-luna' };
