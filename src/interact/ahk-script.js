/**
 * @file src/interact/ahk-script.js
 * @module interact/ahk-script
 * @purpose Build one AutoHotkey v2 program for a normalized desktop action.
 * @depends interact/mouse, interact/keyboard, interact/screenshot
 * @usedBy interact/filesystem
 * @exports ahkString, scriptFor, wrapScript
 * @ai.tags desktop, autohotkey
 * @ai.hint pure
 * @changed 2026-10-15 Split from interact/filesystem.js.
 */
import { clickBody } from './mouse.js';
import { typeBody } from './keyboard.js';
import { CAPTURE_LIBRARY } from './screenshot.js';

/** Quote a value for an AutoHotkey v2 expression string. */
export function ahkString(value) {
    const escaped = String(value).replace(/[`\r\n"]/g, (ch) => {
        if (ch === '`') return '``';
        if (ch === '\r') return '`r';
        if (ch === '\n') return '`n';
        return '`' + '"';
    }).replace(/;/g, '`;');
    return `"${escaped}"`;
}

/** Body statements for an already-normalized desktop action. */
export function scriptFor(action) {
    if (action.type === 'click') return clickBody(action);
    if (action.type === 'type') return typeBody(action);
    if (action.type === 'screenshot') return '';
    if (action.type === 'ahk') return action.script;
    throw new Error(`unknown action type: ${action.type}`);
}

/** Wrap body statements in one AutoHotkey v2 program that records a result and optional PNG. */
export function wrapScript(body) {
    const lines = [
        '#Requires AutoHotkey v2.0',
        '#Warn All, Off',
        '#DllLoad "gdiplus"',
        '#SingleInstance Force',
        'resultPath := A_Args[1]',
        'shotPath := A_Args.Length >= 2 ? A_Args[2] : ""',
        'try {',
    ];
    const source = body == null ? '' : String(body);
    if (source) {
        for (const line of source.split(/\r?\n/)) lines.push(line ? `    ${line}` : '');
    }
    lines.push(
        '    if (shotPath != "") {',
        '        try {',
        '            SaveScreenshot(shotPath)',
        '        } catch as shotErr {',
        '            WriteResult(resultPath, "ok " . shotErr.Message)',
        '            ExitApp(0)',
        '        }',
        '    }',
        '    WriteResult(resultPath, "ok")',
        '    ExitApp(0)',
        '} catch as err {',
        '    WriteResult(resultPath, err.Message)',
        '    ExitApp(1)',
        '}',
        '',
        'WriteResult(path, text) {',
        '    if FileExist(path)',
        '        FileDelete(path)',
        '    FileAppend(text, path, "UTF-8")',
        '}',
        '',
        CAPTURE_LIBRARY,
    );
    return `${lines.join('\n')}\n`;
}
