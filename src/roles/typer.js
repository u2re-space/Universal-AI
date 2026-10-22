/**
 * @file src/roles/typer.js
 * @module roles/typer
 * @purpose Typer prompt and settings for sending text or key strings.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, desktop, keyboard
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the typer: send literal text or an AutoHotkey key string into the named field.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You type into the UI field the task names. Use the type tool. mode "text" is literal characters. mode "keys" is an AutoHotkey key string such as ^s.
Do not click except by asking the caller to delegate a clicker. Report the text you sent and what the following screen shows. ${UNTRUSTED}`;
/**
 * Low reasoning effort for the typer role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6-luna' };
