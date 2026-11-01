/**
 * @file src/agent/browser.js
 * @module agent/browser
 * @purpose Browser tools. Ego Lite (the ego-browser CLI) is the primary engine; Chrome/Edge headless is the read-only fallback.
 * @depends node:path, node:fs/promises, node:os, node:url, agent/shell, agent/paths, util/text
 * @usedBy agent/tools, agent/tool-specs
 * @exports BROWSER_TOOL_NAMES, BROWSER_ACTIONS, BROWSER_DRIVE_ACTIONS, findEgo, findChromium, resolveEngine, buildEgoScript, runEgoScript, chromeArgs, resetEngineCache, createBrowserHandlers
 * @ai.tags browser, ego, chrome, tools
 * @ai.hint io
 * @changed 2026-11-01 First version: Ego Lite engine with a headless Chrome/Edge fallback.
 */

import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runProgram } from './shell.js';
import { resolveInside, isInside } from './paths.js';
import { clipMiddle, errorMessage, timestampSlug } from '../util/text.js';

/** Browser tools enabled together by tools.browser. */
export const BROWSER_TOOL_NAMES = Object.freeze(['browser', 'browser_drive']);

/** Observation actions of the `browser` tool (category network). */
export const BROWSER_ACTIONS = Object.freeze(['status', 'open', 'screenshot', 'snapshot', 'text', 'close']);

/** Interaction actions of the `browser_drive` tool (category exec). */
export const BROWSER_DRIVE_ACTIONS = Object.freeze(['click', 'fill', 'eval']);

/** Marker line the Ego script prints before its JSON result; runEgoScript reads the last one. */
const RESULT_START = '@@AI_RESULT@@';

const EGO_NOT_FOUND = 'ego-browser не найден в PATH. Установите Ego Lite (https://lite.ego.app/) или укажите browser.executable.';

const CHROME_WIN = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
const CHROME_MAC = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
const CHROME_LINUX = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map((name) => `/usr/bin/${name}`);

/**
 * True when stat reports an existing file. A missing path returns false.
 * @param {string} filePath
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

/**
 * Absolute paths of `ego-browser` (and Windows shims), PATH first, then the Ego Lite install dirs.
 * @param {string | null} configured browser.executable when set
 * @param {object} env
 * @returns {string[]}
 * @ai.hint pure
 */
export function egoCandidates(configured, env) {
    const names = configured ? [path.basename(configured)] : ['ego-browser', 'ego-browser.exe', 'ego-browser.cmd', 'ego-browser.bat'];
    const result = configured ? [configured] : [];
    const push = (dir) => {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (!result.includes(candidate)) result.push(candidate);
        }
    };
    for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
        if (dir.trim()) push(dir.trim());
    }
    const home = env.HOME || env.USERPROFILE || os.homedir();
    if (home) {
        push(path.join(home, '.local', 'bin'));
        push(path.join(home, '.local', 'share', 'ego'));
    }
    return result;
}

/**
 * Absolute paths of a Chromium browser: the configured one first, then the standard install locations.
 * @param {string | null} configured browser.executable when set
 * @param {object} env
 * @param {string} platform
 * @returns {string[]}
 * @ai.hint pure
 */
export function chromiumCandidates(configured, env, platform = process.platform) {
    const candidates = [];
    if (configured) candidates.push(configured);
    if (platform === 'win32') {
        const roots = [env?.ProgramFiles, env?.['ProgramFiles(x86)'], env?.LOCALAPPDATA].filter(Boolean);
        for (const suffix of CHROME_WIN) {
            for (const root of roots) candidates.push(path.join(root, suffix));
        }
    } else if (platform === 'darwin') {
        candidates.push(...CHROME_MAC);
    } else {
        candidates.push(...CHROME_LINUX);
    }
    return [...new Set(candidates)];
}

/**
 * Locate the ego-browser CLI. An explicit executable is checked before PATH and the install dirs.
 * @param {{ executable?: string|null, env?: object, exists?: Function }} [options]
 * @returns {Promise<string|null>}
 * @exports
 * @ai.hint io
 */
export async function findEgo({ executable = null, env = process.env, exists = isFile } = {}) {
    for (const candidate of egoCandidates(executable, env)) {
        if (await exists(candidate)) return candidate;
    }
    return null;
}

/**
 * Locate a Chrome- or Edge-family executable.
 * @param {{ executable?: string|null, env?: object, exists?: Function, platform?: string }} [options]
 * @returns {Promise<string|null>}
 * @exports
 * @ai.hint io
 */
export async function findChromium({ executable = null, env = process.env, exists = isFile, platform = process.platform } = {}) {
    for (const candidate of chromiumCandidates(executable, env, platform)) {
        if (await exists(candidate)) return candidate;
    }
    return null;
}

/**
 * Decide which engine the browser tools use: Ego Lite when its CLI is present, otherwise a headless
 * Chromium (read-only actions). An explicit browser.executable is tried for the named engine only.
 * @param {object} config
 * @param {{ findEgo?: Function, findChromium?: Function }} [options]
 * @returns {Promise<{ engine: 'ego'|'chrome', executable: string, interactions: boolean, ego: string|null, chrome: string|null, version?: string }|null>}
 * @exports
 * @ai.hint io
 */
export async function resolveEngine(config, { findEgo: findEgoFn = findEgo, findChromium: findChromiumFn = findChromium } = {}) {
    const browser = config?.browser ?? {};
    const preference = browser.engine ?? 'auto';
    const executable = typeof browser.executable === 'string' && browser.executable.trim() ? browser.executable.trim() : null;
    const selectedEngine = preference === 'auto' && executable
        ? (/^ego-browser(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(executable)) ? 'ego' : 'chrome')
        : preference;
    const ego = selectedEngine === 'chrome' ? null : await findEgoFn({ executable: selectedEngine === 'ego' ? executable : null, env: process.env });
    const chrome = selectedEngine === 'ego' ? null : await findChromiumFn({ executable: selectedEngine === 'chrome' ? executable : null, env: process.env });
    if (ego) return { engine: 'ego', executable: ego, interactions: true, ego, chrome, version: 'ego lite' };
    if (chrome) return { engine: 'chrome', executable: chrome, interactions: false, ego, chrome };
    if (selectedEngine === 'chrome') throw new Error(`Chromium-браузер не найден. Укажите browser.executable (${CHROME_WIN.join(' | ')}).`);
    if (selectedEngine === 'ego') throw new Error(EGO_NOT_FOUND);
    throw new Error(`${EGO_NOT_FOUND} Либо установите Chrome/Edge и укажите browser.engine chrome.`);
}

/**
 * Ego script template. Tokens are replaced with literals, so no shell quoting rules apply: the
 * entry point is one ASCII line `await import("file:///…")` and every value lives in the .mjs file.
 * `__EGO_HELPERS__` is kept as a marker for tests that read the template back.
 */
const EGO_HELPERS = `const MARKER = "@@AI_RESULT@@";
let __SPACE_ID = __SPACE_LITERAL__;
const clip = (value, max) => { const text = String(value ?? ""); return text.length <= max ? text : text.slice(0, max) + "\\n… усечено " + text.length + " симв."; };
const emit = (obj) => { console.log(MARKER + JSON.stringify(obj)); process.exitCode = 0; };
const fail = (error, stage) => emit({ ok: false, error: String((error && (error.message || error)) || error), stage });
async function getSpace(createName) {
  if (__SPACE_ID != null) return taskSpace(__SPACE_ID);
  const task = await taskSpace(createName);
  __SPACE_ID = task.spaceId;
  return task;
}
async function getPage(task, label) {
  const pages = await task.pages();
  if (!pages.length) return task.newPage();
  if (label) return task.page(label);
  const preferred = pages.find((item) => item.label === "p1") || pages.find((item) => item.label !== "p1");
  return task.page(preferred.label);
}
function targetRef(target) {
  const text = String(target ?? "").trim();
  if (!text) throw new Error("Укажите selector (ref @12, text=…, loc=css:, loc=role:, xpath=… или CSS).");
  return text;
}
__ACTION_CODE__;
try {
  await __ACTION_CALL__;
} catch (error) {
  fail(error, __ACTION_LITERAL__);
}`;

/**
 * Render one Ego round: helpers, the stored task-space id, and the action body.
 * @param {{ action: string, spaceId?: number|null, name?: string, args?: object }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function buildEgoScript({ action, spaceId = null, name = 'ai-browser', args = {} }) {
    const spaceLiteral = Number.isSafeInteger(spaceId) ? String(spaceId) : 'null';
    let code = '';
    switch (action) {
        case 'open':
            code = `
const task = await getSpace(${JSON.stringify(name)});
let page = await getPage(task, ${JSON.stringify(args.page || '')});
try {
  await page.goto(${JSON.stringify(args.url)});
} catch (error) {
  // A reused page can sit on a failed navigation; one fresh page is the documented recovery.
  const fresh = await task.newPage();
  await fresh.goto(${JSON.stringify(args.url)}).catch(() => { throw error; });
  await page.close().catch(() => {});
  page = fresh;
}
await page.waitForLoadState();
const label = page.label;
const info = await page.info().catch(() => null);
emit({ ok: true, spaceId: task.spaceId, page: label, url: await page.url(), title: await page.title(), info: info ? clip(JSON.stringify(info), 1200) : null });`;
            break;
        case 'screenshot':
            code = `
const task = await getSpace(${JSON.stringify(name)});
const page = await getPage(task, ${JSON.stringify(args.page || '')});
const path = await page.screenshot({ path: ${JSON.stringify(args.pathAbs)} });
emit({ ok: true, spaceId: task.spaceId, page: page.label, screenshot: path, fullPage: ${JSON.stringify(args.fullPage === true)} });`;
            break;
        case 'snapshot':
            code = `
const task = await getSpace(${JSON.stringify(name)});
const page = await getPage(task, ${JSON.stringify(args.page || '')});
const snap = await page.snapshot(${args.fullPage === true ? '{ scope: "full_page" }' : '{}'});
emit({ ok: true, spaceId: task.spaceId, page: page.label, url: await page.url(), title: await page.title(), snapshot: clip(snap, ${Math.max(2000, Number(args.clipLimit) || 60000)}) });`;
            break;
        case 'text':
            code = `
const task = await getSpace(${JSON.stringify(name)});
const page = await getPage(task, ${JSON.stringify(args.page || '')});
const text = await page.evaluate(() => {
  const root = document.body || document.documentElement;
  const clone = root.cloneNode(true);
  for (const node of clone.querySelectorAll('script,style,noscript,template,svg')) node.remove();
  return { title: document.title, url: location.href, text: (clone.innerText || clone.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim() };
});
emit({ ok: true, spaceId: task.spaceId, page: page.label, url: text.url, title: text.title, text: clip(text.text, ${Math.max(2000, Number(args.clipLimit) || 60000)}) });`;
            break;
        case 'click':
            code = `
const task = await getSpace(${JSON.stringify(name)});
const page = await getPage(task, ${JSON.stringify(args.page || '')});
const ref = targetRef(${JSON.stringify(args.selector)});
const receipt = await page.click(ref, { label: ${JSON.stringify(args.label || 'agent click')} });
const snap = await page.snapshot().catch(() => '');
emit({ ok: true, spaceId: task.spaceId, page: page.label, url: await page.url(), title: await page.title(), receipt: clip(JSON.stringify(receipt ?? null), 800), snapshot: clip(snap, 4000) });`;
            break;
        case 'fill':
            code = `
const task = await getSpace(${JSON.stringify(name)});
const page = await getPage(task, ${JSON.stringify(args.page || '')});
const ref = targetRef(${JSON.stringify(args.selector)});
const receipt = await page.fill(ref, String(${JSON.stringify(args.value ?? '')}));
const snap = await page.snapshot().catch(() => '');
emit({ ok: true, spaceId: task.spaceId, page: page.label, url: await page.url(), title: await page.title(), receipt: clip(JSON.stringify(receipt ?? null), 800), snapshot: clip(snap, 4000) });`;
            break;
        case 'eval':
            code = `
const task = await getSpace(${JSON.stringify(name)});
const page = await getPage(task, ${JSON.stringify(args.page || '')});
const value = await page.evaluate(async (source) => {
  const fn = (0, eval)("(" + source + ")");
  return await fn();
}, ${JSON.stringify(args.script ?? '')});
emit({ ok: true, spaceId: task.spaceId, page: page.label, url: await page.url(), result: clip(JSON.stringify(value ?? null), 16000) });`;
            break;
        case 'close':
            code = `
if (__SPACE_ID == null) { emit({ ok: true, closed: false, note: 'Страниц браузера этой сессии не было.' }); }
else {
  const task = await taskSpace(__SPACE_ID);
  await task.finish({ keep: [] });
  emit({ ok: true, closed: true });
}`;
            break;
        default:
            throw new Error(`Неизвестное действие браузера: ${action}`);
    }
    return EGO_HELPERS
        .replaceAll('__SPACE_LITERAL__', spaceLiteral)
        .replaceAll('__ACTION_LITERAL__', JSON.stringify(action))
        .replace('__ACTION_CODE__', 'const run = async () => {' + code + '\n};')
        .replace('__ACTION_CALL__', 'run()');
}

/**
 * Spawn one browser process through agent/shell. Injectable for tests.
 * @param {{ file: string, args?: string[], timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal }} options
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function defaultEgoRun({ file, args, timeoutMs, maxOutputBytes, signal }) {
    return runProgram({ file, args, timeoutMs, maxOutputBytes, signal });
}

/**
 * Run one Ego round: write a UTF-8 .mjs file, evaluate an ASCII-only import line, parse the marker JSON.
 * The embedded Node of ego lite prints console output on stderr, so the marker is searched in both streams.
 * @param {{ executable: string, script: string, timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal, run?: Function, dirPrefix?: string }} options
 * @returns {Promise<object>} the JSON object the script emitted
 * @exports
 * @ai.hint io
 */
export async function runEgoScript({
    executable, script, timeoutMs = 60_000, maxOutputBytes = 256 * 1024, signal = null,
    run = defaultEgoRun, dirPrefix = 'ai-ego-',
} = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), dirPrefix));
    try {
        const scriptPath = path.join(dir, 'round.mjs');
        await writeFile(scriptPath, script, 'utf8');
        // Double quotes survive the ego launcher's argument handling; single quotes are stripped.
        const importLine = `await import("${pathToFileURL(scriptPath).href}")`;
        const result = await run({
            file: executable,
            args: ['nodejs', '-e', importLine],
            timeoutMs,
            maxOutputBytes,
            signal,
        });
        if (result.timedOut) throw new Error(`ego-browser не завершился за ${Math.round(timeoutMs / 1000)} с.`);
        if (result.cancelled) throw new Error('Вызов браузера отменён.');
        if (result.error) throw new Error(`Запуск ego-browser не удался: ${result.error}`);
        const streams = [result.stderr, result.stdout];
        let payload = null;
        for (const text of streams) {
            const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.startsWith(RESULT_START));
            if (lines.length) payload = lines[lines.length - 1].slice(RESULT_START.length);
        }
        if (payload == null) {
            const detail = [result.stdout, result.stderr].filter((part) => part && part.trim()).join('\n').trim();
            throw new Error(`ego-browser не вернул результат (exit ${result.exitCode}). ${clipMiddle(detail, 2000)}`);
        }
        return JSON.parse(payload);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}

/**
 * Argv for one headless Chromium read call. `mode` is screenshot or dump-dom.
 * @param {{ mode: 'screenshot'|'dump-dom', url: string, output?: string|null, width?: number, height?: number, budgetMs?: number, userDataDir: string }} options
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function chromeArgs({ mode, url, output = null, width = 1280, height = 800, budgetMs = 5000, userDataDir }) {
    const args = [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update',
        '--hide-scrollbars', `--user-data-dir=${userDataDir}`,
        `--virtual-time-budget=${Math.max(100, Math.min(60000, Math.round(budgetMs)))}`,
    ];
    if (mode === 'screenshot') {
        args.push(`--window-size=${Math.round(width)},${Math.round(height)}`);
        args.push(`--screenshot=${output}`);
    } else {
        args.push('--dump-dom');
    }
    args.push(url);
    return args;
}

/**
 * Run one headless Chromium call and resolve with the process result.
 * @param {{ executable: string, args: string[], timeoutMs: number, maxOutputBytes?: number, signal?: AbortSignal, run?: Function }} options
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function runChromium({ executable, args, timeoutMs, maxOutputBytes = 256 * 1024, signal = null, run = defaultEgoRun }) {
    return run({ file: executable, args, timeoutMs, maxOutputBytes, signal });
}

/**
 * Drop scripts, styles, and tags so fetched HTML becomes readable text (same reduction as fetch_url).
 * @param {string} html
 * @returns {string}
 * @ai.hint pure
 */
function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Engine cache for one process; reset between runs with resetEngineCache. */
let enginePromise = null;

/** Forget the resolved engine (tests, config reloads). */
export function resetEngineCache() { enginePromise = null; }

/**
 * Resolved engine metadata, or null when no engine is installed.
 * @param {object} config
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function engineInfo(config, { force = false } = {}) {
    if (force) enginePromise = null;
    enginePromise ??= resolveEngine(config).catch(() => null);
    return enginePromise;
}

/**
 * Handlers for BROWSER_TOOL_NAMES.
 * ctx: { root, config, signal, engine?: object|null, runEgo?: Function, runChromium?: Function }
 * `engine`, `runEgo`, and `runChromium` are injected by tests; production resolves the engine once per run.
 */
export function createBrowserHandlers(ctx = {}) {
    const { root, config, signal = null } = ctx;
    const injectedEngine = Object.prototype.hasOwnProperty.call(ctx, 'engine') ? ctx.engine : undefined;
    const egoRun = ctx.runEgo ?? null;
    const chromiumRun = ctx.runChromium ?? null;
    const state = { spaceId: null, page: null, spaceRound: 0, url: null };

    /**
     * Task-space name for this run. A finished space cannot be resumed, so every space the
     * handler closes pushes the name one generation forward.
     * @returns {string}
     * @ai.hint io
     */
    function spaceName() {
        const base = String(config?.browser?.spaceName ?? 'ai-browser').trim() || 'ai-browser';
        return state.spaceRound === 0 ? base : `${base}-${state.spaceRound}`;
    }

    /** Engine of this run: injected, resolved, or null. */
    async function engine() {
        if (injectedEngine !== undefined) return injectedEngine;
        return engineInfo(config);
    }

    function timeoutMs(seconds) {
        const base = config?.browser?.timeoutMs ?? 60_000;
        const requested = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : base;
        return Math.max(5_000, Math.min(300_000, requested));
    }

    /** Validate and normalize a target URL: http(s), or a local file/dir inside the working directory. */
    async function normalizeUrl(raw) {
        const value = String(raw ?? '').trim();
        if (!value) throw new Error('Укажите url (http/https или путь к файлу/каталогу внутри рабочего каталога).');
        if (value.startsWith('-')) throw new Error('URL не может начинаться с дефиса.');
        if (/^file:\/\//i.test(value)) throw new Error('file:// задайте локальным путём внутри рабочего каталога.');
        if (/^https?:\/\//i.test(value)) {
            try { new URL(value); } catch { throw new Error('Некорректный URL.'); }
            return value;
        }
        const { abs } = await resolveInside(root, value, { allowRoot: true });
        const info = await stat(abs).catch(() => null);
        if (!info) throw new Error(`Файл не найден: ${value}`);
        const target = info.isDirectory() ? path.join(abs, 'index.html') : abs;
        const final = await stat(target).catch(() => null);
        if (!final?.isFile()) throw new Error(`В каталоге нет index.html: ${value}`);
        return pathToFileURL(target).href;
    }

    /** Output path inside the working directory, default under .ai/browser/. */
    async function resolveOutput(requested, prefix, extension) {
        const value = String(requested ?? '').trim() || `.ai/browser/${prefix}-${timestampSlug()}-${Number(process.hrtime.bigint() % 100000n)}.${extension}`;
        const { abs, rel } = await resolveInside(root, value, { forWrite: true, allowRoot: false });
        await mkdir(path.dirname(abs), { recursive: true });
        return { abs, rel };
    }

    /** Ego round with the session space id and a stage name for errors. */
    async function egoCall(action, args, timeoutMsValue) {
        const engineValue = await engine();
        if (!engineValue || engineValue.engine !== 'ego') {
            throw new Error(`Действие ${action} требует Ego Lite (${EGO_NOT_FOUND}). Текущий движок: ${engineValue ? 'headless Chrome/Edge' : 'не найден'} — доступны screenshot и text.`);
        }
        const script = buildEgoScript({ action, spaceId: state.spaceId, name: spaceName(), args });
        const runner = egoRun ?? ((options) => runEgoScript({ ...options, signal }));
        let result;
        try {
            result = await runner({
                executable: engineValue.executable,
                script,
                timeoutMs: timeoutMsValue,
                ...(egoRun ? { signal } : {}),
            });
        } catch (error) {
            error.egoFailed = true;
            throw error;
        }
        if (result?.ok !== true) {
            const error = new Error(`ego ${result?.stage ?? action}: ${result?.error ?? 'неизвестная ошибка'}`);
            error.egoFailed = true;
            error.egoMessage = String(result?.error ?? '');
            throw error;
        }
        if (Number.isSafeInteger(result.spaceId)) state.spaceId = result.spaceId;
        else if (result.closed) state.spaceId = null;
        if (result.page) state.page = result.page;
        if (typeof result.url === 'string' && result.url) state.url = result.url;
        return result;
    }

    /**
     * Pages headless Chromium may be pointed at after Ego Lite fails. Remote pages this run opened
     * are fair game; file: URLs only while they stay inside the working directory.
     * @param {string|null} url Current page URL.
     * @returns {boolean} Whether a fallback call with this URL is allowed.
     */
    function fallbackUrlAllowed(url) {
        if (!url) return false;
        if (/^https?:/i.test(url)) return true;
        if (!/^file:/i.test(url)) return false;
        try {
            return isInside(root, fileURLToPath(new URL(url)));
        } catch {
            return false;
        }
    }

    /**
     * Ego Lite needs its app window alive; a capture can still time out. When that happens and a
     * Chromium binary exists, the screenshot is taken headless from the page this run opened last.
     * @param {Error} error Failure of the Ego call.
     * @param {{ output: {abs: string, rel: string}, width?: number, height?: number, timeoutMsValue: number }} options
     * @returns {Promise<{ output: {abs: string, rel: string}, url: string, bytes: number, note: string }|{ reason: string }>}
     * @ai.hint io
     */
    async function chromeScreenshotFallback(error, { output, width, height, timeoutMsValue }) {
        if (!error?.egoFailed) return { reason: 'сбой не со стороны Ego Lite' };
        const engineValue = await engine();
        if (!engineValue?.chrome) return { reason: 'Chrome/Edge не найден' };
        const url = fallbackUrlAllowed(state.url) ? state.url : null;
        if (!url) return { reason: state.url ? `страница вне рабочего каталога (${state.url})` : 'страница ещё не открыта' };
        const fallbackEngine = { engine: 'chrome', executable: engineValue.chrome, interactions: false, ego: engineValue.ego, chrome: engineValue.chrome };
        try {
            const result = await chromeCallWith(fallbackEngine, 'screenshot', url, { output: output.abs, width, height, timeoutMsValue });
            const bytes = (await stat(output.abs).catch(() => null))?.size ?? 0;
            if (result.exitCode !== 0 || bytes === 0) {
                return { reason: `headless Chromium exit ${result.exitCode}, bytes ${bytes}: ${clipMiddle([result.stdout, result.stderr].filter(Boolean).join(' '), 300)}` };
            }
            return { output, url, bytes, note: `Ego Lite не снял кадр (${error.message}); снимок сделан headless Chromium.` };
        } catch (fallbackError) {
            return { reason: errorMessage(fallbackError) };
        }
    }

    /** One headless Chromium read call with the engine this run resolved. */
    async function chromeCall(mode, url, options) {
        const engineValue = await engine();
        if (!engineValue || engineValue.engine !== 'chrome') {
            throw new Error('Headless-движок Chromium недоступен.');
        }
        return chromeCallWith(engineValue, mode, url, options);
    }

    /** One headless Chromium call with an explicit engine record (used by the screenshot fallback). */
    async function chromeCallWith(engineValue, mode, url, { output = null, width, height, timeoutMsValue }) {
        const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-chrome-profile-'));
        try {
            const budgetMs = Math.max(1000, Math.min(timeoutMsValue - 3000, 20000));
            const args = chromeArgs({ mode, url, output, width, height, budgetMs, userDataDir });
            const runner = chromiumRun ?? ((options) => runChromium({ ...options, signal }));
            const result = await runner({
                executable: engineValue.executable,
                args,
                timeoutMs: timeoutMsValue,
                ...(chromiumRun ? { signal } : {}),
            });
            if (result.timedOut) throw new Error(`headless Chromium не завершился за ${Math.round(timeoutMsValue / 1000)} с.`);
            if (result.error) throw new Error(`Запуск Chromium не удался: ${result.error}`);
            return result;
        } finally {
            await rm(userDataDir, { recursive: true, force: true }).catch(() => { });
        }
    }

    /** Engine header lines shared by every output. */
    function engineLines(engineValue) {
        if (!engineValue) return ['engine: не найден (Ego Lite или Chrome/Edge)'];
        const mode = engineValue.engine === 'ego' ? 'ego lite (взаимодействие доступно)' : 'headless chromium (только чтение)';
        return [`engine: ${engineValue.engine} — ${mode}`, `executable: ${engineValue.executable}`];
    }

    function statusLine(engineValue) {
        if (!engineValue) return 'Движок не найден: установите Ego Lite (https://lite.ego.app/) или Chrome/Edge.';
        return engineValue.engine === 'ego' ? 'Готов к работе: Ego Lite (открытие, снимки, snapshot, клики, ввод, evaluate).' : 'Готов к работе с ограничениями: headless Chromium (открытие, снимок, текст страницы).';
    }

    /** The `browser` tool: status, open, screenshot, snapshot, text, close. */
    async function browser(args = {}) {
        const action = String(args.action ?? 'status');
        const timeout = timeoutMs(args.timeout_seconds);
        const engineValue = await engine();
        if (action === 'status') {
            const lines = [...engineLines(engineValue), statusLine(engineValue)];
            lines.push(`session: ${state.spaceId != null ? `страница ${state.page ?? 'p1'} задачи ${state.spaceId}` : 'страница не открыта'}`);
            return { output: lines.join('\n'), summary: engineValue ? `${engineValue.engine}${state.spaceId != null ? `, страница ${state.page ?? 'p1'}` : ''}` : 'движок не найден' };
        }
        if (!engineValue) throw new Error(EGO_NOT_FOUND);
        if (action === 'open') {
            const url = await normalizeUrl(args.url);
            if (engineValue.engine === 'ego') {
                const result = await egoCall('open', { url, page: args.page || null }, timeout);
                return { output: ['status: ok', `url: ${result.url}`, `title: ${result.title}`, `page: ${result.page}`, `task_space: ${result.spaceId}`, result.info ? `info: ${result.info}` : ''].filter(Boolean).join('\n'), summary: `открыт ${result.url}` };
            }
            await chromeCall('dump-dom', url, { timeoutMsValue: timeout });
            state.url = url;
            return { output: `status: ok\nurl: ${url}\nengine: chrome (страница прогрета; снимок или текст — следующим вызовом)`, summary: `открыт ${url}` };
        }
        if (action === 'screenshot') {
            const output = await resolveOutput(args.output, 'shot', 'png');
            if (engineValue.engine === 'ego') {
                try {
                    const result = await egoCall('screenshot', { pathAbs: output.abs, page: args.page || null }, timeout);
                    const bytes = (await stat(output.abs).catch(() => null))?.size ?? 0;
                    return { output: ['status: ok', `screenshot: ${output.rel}`, `bytes: ${bytes}`, `page: ${result.page}`, `url: ${result.url ?? ''}`].join('\n'), summary: `${output.rel} (${bytes} Б)` };
                } catch (error) {
                    const fallback = await chromeScreenshotFallback(error, { output, width: args.width ?? 1280, height: args.height ?? 800, timeoutMsValue: timeout });
                    if (!fallback.output) {
                        error.message = `${error.message} (Chromium-резерв не помог: ${fallback.reason})`;
                        throw error;
                    }
                    return {
                        output: ['status: ok', `screenshot: ${fallback.output.rel}`, `bytes: ${fallback.bytes}`, `url: ${fallback.url}`, `note: ${fallback.note}`].join('\n'),
                        summary: `${fallback.output.rel} (${fallback.bytes} Б, chromium fallback)`,
                    };
                }
            }
            const url = args.url ? await normalizeUrl(args.url) : (state.url ?? null);
            if (!url) throw new Error('Для снимка без Ego Lite укажите url.');
            const result = await chromeCall('screenshot', url, { output: output.abs, width: args.width ?? 1280, height: args.height ?? 800, timeoutMsValue: timeout });
            const bytes = (await stat(output.abs).catch(() => null))?.size ?? 0;
            if (result.exitCode !== 0 || bytes === 0) {
                throw new Error(`headless Chromium не сохранил снимок (exit ${result.exitCode}). ${clipMiddle([result.stdout, result.stderr].filter(Boolean).join('\n'), 1500)}`);
            }
            return { output: ['status: ok', `screenshot: ${output.rel}`, `bytes: ${bytes}`, `url: ${url}`].join('\n'), summary: `${output.rel} (${bytes} Б)` };
        }
        if (action === 'snapshot' || action === 'text') {
            const clipLimit = config?.limits?.maxFetchBytes ?? 512 * 1024;
            if (engineValue.engine === 'ego') {
                try {
                    const result = await egoCall(action, { page: args.page || null, clipLimit }, timeout);
                    const body = action === 'snapshot' ? result.snapshot : result.text;
                    return { output: ['status: ok', `url: ${result.url ?? ''}`, `title: ${result.title ?? ''}`, '', String(body ?? '')].join('\n'), summary: `${action}: ${String(body ?? '').length} симв.` };
                } catch (error) {
                    // A page Ego cannot read is still readable headless, when a Chromium exists.
                    if (action !== 'text' || !error?.egoFailed || !engineValue.chrome || !fallbackUrlAllowed(state.url)) throw error;
                    const fallbackEngine = { engine: 'chrome', executable: engineValue.chrome, interactions: false, ego: engineValue.ego, chrome: engineValue.chrome };
                    const result = await chromeCallWith(fallbackEngine, 'dump-dom', state.url, { timeoutMsValue: timeout });
                    if (result.exitCode !== 0) throw error;
                    const text = htmlToText(result.stdout ?? '');
                    return {
                        output: ['status: ok', `url: ${state.url}`, `note: Ego Lite не ответил (${error.message}); текст прочитан headless Chromium.`, '', clipMiddle(text, clipLimit)].join('\n'),
                        summary: `text: ${text.length} симв. (chromium fallback)`,
                    };
                }
            }
            if (action === 'snapshot') {
                throw new Error('snapshot (семантические ref-ы) доступен только с Ego Lite; для headless Chromium используйте text или screenshot.');
            }
            const url = args.url ? await normalizeUrl(args.url) : (state.url ?? null);
            if (!url) throw new Error('Для чтения текста без Ego Lite укажите url.');
            const result = await chromeCall('dump-dom', url, { timeoutMsValue: timeout });
            if (result.exitCode !== 0) throw new Error(`headless Chromium не вернул DOM (exit ${result.exitCode}). ${clipMiddle([result.stdout, result.stderr].filter(Boolean).join('\n'), 1500)}`);
            const text = htmlToText(result.stdout ?? '');
            return { output: ['status: ok', `url: ${url}`, '', clipMiddle(text, clipLimit)].join('\n'), summary: `text: ${text.length} симв.` };
        }
        if (action === 'close') {
            if (engineValue.engine !== 'ego') {
                return { output: 'status: ok\nengine: chrome — отдельные вызовы headless не держат страницу; закрывать нечего.', summary: 'нет сессии' };
            }
            const previous = state.spaceId;
            const result = await egoCall('close', {}, timeout);
            if (result.closed) state.spaceRound += 1;
            state.page = null;
            return {
                output: `status: ok\n${result.closed ? `Задача ${previous} закрыта, страницы агента освобождены.` : result.note}`,
                summary: result.closed ? 'браузер закрыт' : 'нет сессии',
            };
        }
        throw new Error(`browser: неизвестное действие ${action} (${BROWSER_ACTIONS.join(' | ')}).`);
    }

    /** The `browser_drive` tool: click, fill, eval (Ego Lite only). */
    async function browser_drive(args = {}) {
        const action = String(args.action ?? '');
        if (!BROWSER_DRIVE_ACTIONS.includes(action)) throw new Error(`browser_drive: неизвестное действие ${action} (${BROWSER_DRIVE_ACTIONS.join(' | ')}).`);
        const timeout = timeoutMs(args.timeout_seconds);
        const result = await egoCall(action, {
            selector: args.selector ?? null,
            value: args.value ?? '',
            script: args.script ?? '',
            page: args.page || null,
        }, timeout);
        const lines = ['status: ok', `url: ${result.url ?? ''}`, `title: ${result.title ?? ''}`];
        if (result.receipt) lines.push(`receipt: ${result.receipt}`);
        if (result.result != null) lines.push(`result: ${result.result}`);
        if (result.snapshot) lines.push(`snapshot:\n${result.snapshot}`);
        return { output: lines.join('\n'), summary: `${action} ${String(args.selector ?? args.script ?? '').slice(0, 40)}` };
    }

    return { browser, browser_drive };
}
