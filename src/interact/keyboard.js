/**
 * @file src/interact/keyboard.js
 * @module interact/keyboard
 * @purpose Build the AutoHotkey v2 statement for one normalized type action.
 * @depends interact/filesystem
 * @usedBy interact/ahk-script
 * @exports typeBody
 * @ai.tags desktop, keyboard, autohotkey
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { ahkString } from './filesystem.js';

/** AutoHotkey v2 statement for one normalized type action. */
export function typeBody(action) {
    const text = ahkString(action.text);
    if (action.mode === 'text') return `SendText(${text})`;
    if (action.mode === 'keys') return `Send(${text})`;
    throw new Error(`unknown type mode: ${action.mode}`);
}
