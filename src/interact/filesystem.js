/**
 * @file src/interact/filesystem.js
 * @module interact/filesystem
 * @purpose Find AutoHotkey v2, run one script file, and perform one normalized desktop action.
 * @depends node:path, node:child_process, node:fs/promises, node:os, agent/shell, util/text, interact/ahk-script
 * @usedBy agent/desktop, interact/keyboard, interact/mouse
 * @exports ahkString, scriptFor, wrapScript, findAhk, runScript, performAction
 * @ai.tags desktop, autohotkey, process
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { childEnvironment } from '../agent/shell.js';
import { timestampSlug } from '../util/text.js';
import { scriptFor, wrapScript, ahkString } from './ahk-script.js';
export { ahkString, scriptFor, wrapScript };

const AHK_NOT_FOUND = 'AutoHotkey v2 не найден (AutoHotkey64.exe). Укажите desktop.ahkPath.';

/**
 * List AutoHotkey64.exe paths, the explicit path first, then Program Files and LocalAppData.
 * @param {string | undefined} ahkPath Configured executable, when set.
 * @param {object | undefined} env Environment used for the standard install locations.
 * @returns {string[]}
 * @ai.hint pure
 */
function ahkCandidates(ahkPath, env) {
    const candidates = [];
    if (ahkPath) candidates.push(ahkPath);
    const installed = '\\AutoHotkey\\v2\\AutoHotkey64.exe';
    if (env?.ProgramFiles) candidates.push(env.ProgramFiles + installed);
    if (env?.['ProgramFiles(x86)']) candidates.push(env['ProgramFiles(x86)'] + installed);
    if (env?.LOCALAPPDATA) candidates.push(env.LOCALAPPDATA + '\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe');
    return candidates;
}

/**
 * True when stat reports an existing file. A missing path returns false.
 * @param {string} filePath Candidate path.
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function isFile(filePath) {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

/** Drop a leading UTF-8 BOM so FileAppend "UTF-8" text compares as written. */
function stripUtf8Bom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read the AutoHotkey result file as UTF-8 and drop a leading BOM. A missing file is empty.
 * @param {string} resultPath Path the script writes.
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function readResultText(resultPath) {
    try {
        return stripUtf8Bom(await readFile(resultPath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
    }
}

/**
 * Spawn the executable without a shell and resolve with its exit code. A timeout kills the child.
 * @param {Function} spawnFn Process starter, usually node:child_process.spawn.
 * @param {string} executable AutoHotkey executable.
 * @param {string[]} args Arguments, including the script path and result path.
 * @param {string} [cwd] Working directory for the child.
 * @param {number} timeoutMs Milliseconds before the child is killed.
 * @returns {Promise<number>}
 * @ai.hint io
 */
function runChild({ spawnFn, executable, args, cwd, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let child;
        let settled = false;
        /**
         * Resolve or reject the child promise a single time.
         * @param {Function} fn resolve or reject.
         * @param {unknown} value Exit code or error.
         * @returns {void}
         * @ai.hint pure
         */
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child?.kill(); } catch { /* already gone */ }
            reject(new Error(`таймаут AutoHotkey (${timeoutMs} мс)`));
        }, timeoutMs);
        const options = { windowsHide: true, stdio: 'ignore', shell: false, env: childEnvironment() };
        if (cwd) options.cwd = cwd;
        try {
            child = spawnFn(executable, args, options);
            child.once('error', (error) => finish(reject, error));
            child.once('exit', (code) => finish(resolve, code ?? 1));
        } catch (error) {
            finish(reject, error);
        }
    });
}

/** Locate AutoHotkey64.exe. An explicit path is checked before the standard install locations. */
export async function findAhk({ ahkPath, env = process.env, exists = isFile } = {}) {
    for (const candidate of ahkCandidates(ahkPath, env)) {
        if (await exists(candidate)) return candidate;
    }
    throw new Error(AHK_NOT_FOUND);
}

/**
 * Write `script` to a temporary .ahk and spawn `executable` with the script, result, and optional screenshot paths.
 * Does not use a shell. A non-zero exit throws the result text. A timeout kills the process.
 */
export async function runScript({
    executable, prefixArgs = [], script, shotPath = null, timeoutMs = 180_000, cwd, spawnFn = spawn,
} = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-ahk-'));
    const scriptPath = path.join(dir, 'script.ahk');
    const resultPath = path.join(dir, 'result.txt');
    try {
        await writeFile(scriptPath, script ?? '', 'utf8');
        const args = prefixArgs.length === 0 ? ['/ErrorStdOut=UTF-8'] : [...prefixArgs];
        args.push(scriptPath, resultPath);
        if (shotPath != null) args.push(shotPath);
        const exitCode = await runChild({ spawnFn, executable, args, cwd, timeoutMs });
        const resultText = await readResultText(resultPath);
        if (exitCode !== 0) {
            const detail = resultText.trim();
            throw new Error(detail || `AutoHotkey завершился с кодом ${exitCode}`);
        }
        return { exitCode, resultText, screenshotWritten: shotPath != null && await isFile(shotPath) };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Run one normalized action. Capture when the action is a screenshot or `shotAfterAction` is true. */
export async function performAction({
    root, executable, prefixArgs = [], action, shotAfterAction, timeoutMs, spawnFn, now,
} = {}) {
    const capture = action.type === 'screenshot' || shotAfterAction === true;
    let screenshotAbs = null;
    let screenshotRel = null;
    if (capture) {
        const fileName = `${timestampSlug(now)}-${process.hrtime.bigint()}.png`;
        screenshotAbs = path.join(root, '.ai', 'desktop', fileName);
        screenshotRel = `.ai/desktop/${fileName}`;
        await mkdir(path.dirname(screenshotAbs), { recursive: true });
    }
    const { resultText } = await runScript({
        executable,
        prefixArgs,
        script: wrapScript(scriptFor(action)),
        shotPath: capture ? screenshotAbs : null,
        timeoutMs,
        cwd: root,
        spawnFn,
    });
    return { message: stripUtf8Bom(resultText).trim(), screenshotAbs, screenshotRel };
}
