/**
 * @file src/interact/mouse.js
 * @module interact/mouse
 * @purpose Build AutoHotkey v2 statements for one normalized click.
 * @depends interact/filesystem
 * @usedBy interact/ahk-script
 * @exports clickBody
 * @ai.tags desktop, mouse, autohotkey
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { ahkString } from './filesystem.js';

/**
 * AutoHotkey lines that set CoordMode and click the action point.
 * @param {object} action Normalized click with x, y, button, and clicks.
 * @param {string} coordMode AutoHotkey mouse coordinate space, such as Window.
 * @returns {string[]}
 * @ai.hint pure
 */
function clickAt(action, coordMode) {
    return [
        `CoordMode("Mouse", ${ahkString(coordMode)})`,
        `Click(${action.x}, ${action.y}, ${ahkString(action.button)}, ${action.clicks})`,
    ];
}

/**
 * AutoHotkey lines that read the virtual-screen origin with GetSystemMetrics.
 * @returns {string[]}
 * @ai.hint pure
 */
function virtualOrigin() {
    return [
        'originX := DllCall("user32\\GetSystemMetrics", "Int", 76, "Int")',
        'originY := DllCall("user32\\GetSystemMetrics", "Int", 77, "Int")',
    ];
}

/** AutoHotkey v2 statements for one normalized click. */
export function clickBody(action) {
    if (action.mode === 'coord') {
        return [
            ...virtualOrigin(),
            'CoordMode("Mouse", "Screen")',
            `Click(originX + ${action.x}, originY + ${action.y}, ${ahkString(action.button)}, ${action.clicks})`,
        ].join('\n');
    }

    if (action.mode === 'title') {
        const title = ahkString(action.title);
        const lines = [
            `if !WinExist(${title})`,
            '    throw Error("window not found")',
            `WinActivate(${title})`,
            `if !WinWaitActive(${title}, , 2)`,
            '    throw Error("window not active")',
        ];
        if (Number.isInteger(action.x) && Number.isInteger(action.y)) lines.push(...clickAt(action, 'Window'));
        return lines.join('\n');
    }

    if (action.mode === 'control') {
        return `ControlClick(${ahkString(action.control)}, ${ahkString(action.title)}, , ${ahkString(action.button)}, ${action.clicks})`;
    }

    if (action.mode === 'image') {
        return [
            ...virtualOrigin(),
            'virtualW := DllCall("user32\\GetSystemMetrics", "Int", 78, "Int")',
            'virtualH := DllCall("user32\\GetSystemMetrics", "Int", 79, "Int")',
            'CoordMode("Pixel", "Screen")',
            'CoordMode("Mouse", "Screen")',
            `if !ImageSearch(&foundX, &foundY, originX, originY, originX + virtualW, originY + virtualH, ${ahkString(`*50 ${action.image}`)})`,
            '    throw Error("image not found")',
            `Click(foundX, foundY, ${ahkString(action.button)}, ${action.clicks})`,
        ].join('\n');
    }

    throw new Error(`unknown click mode: ${action.mode}`);
}
