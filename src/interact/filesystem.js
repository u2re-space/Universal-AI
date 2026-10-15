import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { clickBody } from './mouse.js';
import { typeBody } from './keyboard.js';
import { CAPTURE_LIBRARY } from './screenshot.js';
import { timestampSlug } from '../util/text.js';

/** Quote a value for an AutoHotkey v2 expression string. */
export function ahkString(value) {
  const escaped = String(value).replace(/[`\r\n"]/g, (ch) => {
    if (ch === '`') return '``';
    if (ch === '\r') return '`r';
    if (ch === '\n') return '`n';
    return '`' + '"';
  });
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
    '        SaveScreenshot(shotPath)',
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

const AHK_NOT_FOUND = 'AutoHotkey v2 не найден (AutoHotkey64.exe). Укажите desktop.ahkPath.';

function ahkCandidates(ahkPath, env) {
  const candidates = [];
  if (ahkPath) candidates.push(ahkPath);
  const installed = '\\AutoHotkey\\v2\\AutoHotkey64.exe';
  if (env?.ProgramFiles) candidates.push(env.ProgramFiles + installed);
  if (env?.['ProgramFiles(x86)']) candidates.push(env['ProgramFiles(x86)'] + installed);
  if (env?.LOCALAPPDATA) candidates.push(env.LOCALAPPDATA + '\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe');
  return candidates;
}

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

async function readResultText(resultPath) {
  try {
    return stripUtf8Bom(await readFile(resultPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function runChild({ spawnFn, executable, args, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
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
    const options = { windowsHide: true, stdio: 'ignore', shell: false };
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
    const args = [...prefixArgs, scriptPath, resultPath];
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
    const fileName = `${timestampSlug(now)}.png`;
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
