import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
    BROWSER_ACTIONS, BROWSER_DRIVE_ACTIONS, BROWSER_TOOL_NAMES, buildEgoScript, chromeArgs,
    createBrowserHandlers, egoCandidates, findChromium, findEgo, resolveEngine, runEgoScript,
} from '../src/agent/browser.js';
import { createToolset, enabledToolNames } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';

const EGO_PATH = 'E:\\ego\\ego-browser.exe';
const CHROME_PATH = 'E:\\chrome\\chrome.exe';

/** Engine record for a run where both engines are installed. */
function egoEngine() {
    return { engine: 'ego', executable: EGO_PATH, interactions: true, ego: EGO_PATH, chrome: CHROME_PATH, version: 'ego lite' };
}

/** Engine record for a machine without Ego Lite. */
function chromeEngine() {
    return { engine: 'chrome', executable: CHROME_PATH, interactions: false, ego: null, chrome: CHROME_PATH };
}

/**
 * Fake ego runner: reads the action out of the generated script and answers from a table.
 * @param {object} answers Action name to the JSON object the Ego script would emit.
 */
function fakeEgo(answers) {
    const calls = [];
    const run = async ({ executable, script, timeoutMs }) => {
        const action = script.match(/fail\(error, "(\w+)"\)/)?.[1] ?? 'unknown';
        calls.push({ action, executable, script, timeoutMs });
        const answer = answers[action] ?? answers.default;
        if (!answer) throw new Error(`нет ответа для действия ${action}`);
        return answer;
    };
    return { run, calls };
}

/** Fake Chromium runner that writes a stub PNG and records argv. */
function fakeChromium(payload = '<html><body><h1>Hello</h1><p>Page text</p></body></html>') {
    const calls = [];
    const run = async ({ executable, args }) => {
        calls.push({ executable, args });
        const shot = args.find((arg) => arg.startsWith('--screenshot='));
        if (shot) await writeFile(shot.slice('--screenshot='.length), 'PNGDATA');
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false, error: null, stdout: payload, stderr: '' };
    };
    return { run, calls };
}

function config() {
    return { ...defaults, tools: { ...defaults.tools, browser: true }, browser: { ...defaults.browser, spaceName: 'ai-test' } };
}

test('browser tool names and actions are declared once', () => {
    assert.deepEqual([...BROWSER_TOOL_NAMES], ['browser', 'browser_drive']);
    assert.deepEqual([...BROWSER_ACTIONS], ['status', 'open', 'screenshot', 'snapshot', 'text', 'close']);
    assert.deepEqual([...BROWSER_DRIVE_ACTIONS], ['click', 'fill', 'eval']);
    const on = enabledToolNames({ ...defaults.tools, browser: true });
    assert.equal(on.includes('browser'), true);
    assert.equal(on.includes('browser_drive'), true);
    const off = enabledToolNames({ ...defaults.tools, browser: false });
    assert.equal(off.includes('browser'), false);
    assert.equal(off.includes('browser_drive'), false);
});

test('buildEgoScript renders the marker, the space id, and JSON argument literals', () => {
    const url = 'https://example.com/?q="a b" &';
    const script = buildEgoScript({ action: 'open', spaceId: 7, name: 'ai-browser', args: { url, page: 'p2' } });
    assert.ok(script.includes('const MARKER = "@@AI_RESULT@@"'));
    assert.ok(script.includes('@@AI_RESULT@@'));
    assert.match(script, /let __SPACE_ID = 7;/);
    assert.ok(script.includes(`getSpace("ai-browser")`));
    assert.ok(script.includes(`page.goto(${JSON.stringify(url)})`));
    assert.ok(script.includes(`getPage(task, "p2")`));
    assert.match(script, /fail\(error, "open"\)/);
    assert.doesNotMatch(script, /__SPACE_LITERAL__|__ACTION_LITERAL__|__ACTION_CODE__|__ACTION_CALL__/);
    assert.match(buildEgoScript({ action: 'open', args: { url } }), /let __SPACE_ID = null;/);
    const evalScript = buildEgoScript({ action: 'eval', args: { script: '() => 1 + 1' } });
    assert.ok(evalScript.includes('(0, eval)("(" + source + ")")'));
    assert.ok(evalScript.includes(JSON.stringify('() => 1 + 1')));
    assert.ok(buildEgoScript({ action: 'close' }).includes('task.finish({ keep: [] })'));
    assert.throws(() => buildEgoScript({ action: 'teleport' }), /Неизвестное действие браузера/);
});

test('egoCandidates and findEgo prefer PATH, then the Ego Lite install dirs', async () => {
    const candidates = egoCandidates(null, { PATH: 'C:\\tools', USERPROFILE: 'C:\\Home' });
    assert.equal(candidates[0], path.join('C:\\tools', 'ego-browser'));
    assert.ok(candidates.includes(path.join('C:\\Home', '.local', 'share', 'ego', 'ego-browser.exe')));
    const custom = 'D:\\ego\\bin\\ego-browser.exe';
    assert.equal(egoCandidates(custom, { PATH: 'C:\\tools' })[0], custom);
    assert.equal(await findEgo({ env: { PATH: 'C:\\tools' }, exists: async (p) => path.basename(p) === 'ego-browser.exe' }), path.join('C:\\tools', 'ego-browser.exe'));
    assert.equal(await findEgo({ executable: custom, env: { PATH: 'C:\\tools' }, exists: async () => true }), custom);
    assert.equal(await findEgo({ env: { PATH: '' }, exists: async () => false }), null);
});

test('findChromium and resolveEngine pick Ego Lite first and keep Chromium for fallback', async () => {
    const chrome = await findChromium({ env: { ProgramFiles: 'C:\\PF' }, exists: async (p) => p.includes('chrome.exe'), platform: 'win32' });
    assert.equal(chrome, path.join('C:\\PF', 'Google\\Chrome\\Application\\chrome.exe'));
    assert.equal(await findChromium({ env: {}, exists: async () => false, platform: 'linux' }), null);

    const egoOnly = await resolveEngine({}, { findEgo: async () => EGO_PATH, findChromium: async () => CHROME_PATH });
    assert.equal(egoOnly.engine, 'ego');
    assert.equal(egoOnly.executable, EGO_PATH);
    assert.equal(egoOnly.interactions, true);
    assert.equal(egoOnly.chrome, CHROME_PATH);

    const askedChrome = await resolveEngine({ browser: { engine: 'chrome' } }, { findEgo: async () => EGO_PATH, findChromium: async () => CHROME_PATH });
    assert.equal(askedChrome.engine, 'chrome');
    assert.equal(askedChrome.ego, null);

    const explicitEgo = await resolveEngine({ browser: { engine: 'auto', executable: 'ego-browser.exe' } }, {
        findEgo: async ({ executable }) => executable,
        findChromium: async ({ executable }) => executable,
    });
    assert.equal(explicitEgo.engine, 'ego');
    assert.equal(explicitEgo.executable, 'ego-browser.exe');
    const explicitChrome = await resolveEngine({ browser: { engine: 'auto', executable: 'msedge.exe' } }, {
        findEgo: async ({ executable }) => executable,
        findChromium: async ({ executable }) => executable,
    });
    assert.equal(explicitChrome.engine, 'chrome');
    assert.equal(explicitChrome.executable, 'msedge.exe');

    const noEgo = await resolveEngine({}, { findEgo: async () => null, findChromium: async () => CHROME_PATH });
    assert.equal(noEgo.engine, 'chrome');
    assert.equal(noEgo.interactions, false);

    await assert.rejects(resolveEngine({ browser: { engine: 'ego' } }, { findEgo: async () => null, findChromium: async () => CHROME_PATH }), /ego-browser не найден/);
    await assert.rejects(resolveEngine({ browser: { engine: 'chrome' } }, { findEgo: async () => null, findChromium: async () => null }), /Chromium-браузер не найден/);
    await assert.rejects(resolveEngine({}, { findEgo: async () => null, findChromium: async () => null }), /Либо установите Chrome/);
});

test('chromeArgs builds a headless read call with the url last', () => {
    const out = 'C:\\work\\.ai\\browser\\a.png';
    const shot = chromeArgs({ mode: 'screenshot', url: 'https://example.com', output: out, width: 800, height: 600, budgetMs: 4000, userDataDir: 'C:\\tmp\\profile' });
    assert.equal(shot[0], '--headless=new');
    assert.ok(shot.includes(`--screenshot=${out}`));
    assert.ok(shot.includes('--window-size=800,600'));
    assert.ok(shot.some((arg) => arg.startsWith('--user-data-dir=')));
    assert.ok(shot.some((arg) => arg === '--virtual-time-budget=4000'));
    assert.equal(shot.at(-1), 'https://example.com');
    const dom = chromeArgs({ mode: 'dump-dom', url: 'file:///C:/work/index.html', userDataDir: 'C:\\tmp\\p2' });
    assert.ok(dom.includes('--dump-dom'));
    assert.equal(dom.filter((arg) => arg.startsWith('--screenshot')).length, 0);
    assert.equal(dom.at(-1), 'file:///C:/work/index.html');
    assert.ok(chromeArgs({ mode: 'dump-dom', url: 'https://x.test', userDataDir: 'p' }).includes('--virtual-time-budget=60000') === false);
});

test('runEgoScript imports a UTF-8 file, parses the marker from stderr, and reports failures', async () => {
    const payload = { ok: true, spaceId: 3, page: 'p1' };
    const calls = [];
    const result = await runEgoScript({
        executable: EGO_PATH, script: 'const x = "привет";', dirPrefix: 'ai-ego-test-',
        run: async (options) => {
            calls.push(options);
            return { exitCode: 0, stdout: 'noise on stdout', stderr: `warn\n@@AI_RESULT@@${JSON.stringify(payload)}` };
        },
    });
    assert.deepEqual(result, payload);
    assert.equal(calls[0].file, EGO_PATH);
    assert.deepEqual(calls[0].args.slice(0, 2), ['nodejs', '-e']);
    assert.match(calls[0].args[2], /^await import\("file:\/\/\/.+round\.mjs"\)$/);
    assert.doesNotMatch(calls[0].args[2], /'/);

    const noMarker = { exitCode: 1, stdout: 'boom', stderr: '', timedOut: false, cancelled: false, error: null };
    await assert.rejects(runEgoScript({ executable: 'e', script: 's', run: async () => noMarker }), /не вернул результат \(exit 1\)/);
    await assert.rejects(runEgoScript({ executable: 'e', script: 's', run: async () => ({ ...noMarker, timedOut: true }) }), /не завершился за/);
    await assert.rejects(runEgoScript({ executable: 'e', script: 's', run: async () => ({ ...noMarker, cancelled: true }) }), /отменён/);
    await assert.rejects(runEgoScript({ executable: 'e', script: 's', run: async () => ({ ...noMarker, error: 'ENOENT' }) }), /Запуск ego-browser не удался/);
});

test('browser status and the engine gate report a missing engine', async () => {
    const h = createBrowserHandlers({ root: 'C:\\work', config: config(), engine: null });
    const status = await h.browser({ action: 'status' });
    assert.match(status.output, /engine: не найден/);
    assert.equal(status.summary, 'движок не найден');
    await assert.rejects(h.browser({ action: 'open', url: 'https://example.com' }), /ego-browser не найден/);
    await assert.rejects(h.browser_drive({ action: 'click', selector: '@1' }), /требует Ego Lite/);
});

test('ego session keeps the task space id and moves the name one generation after close', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ai-browser-test-'));
    const ego = fakeEgo({
        open: { ok: true, spaceId: 12, page: 'p1', url: 'https://example.com/', title: 'Example Page', info: '{"w":1920}' },
        snapshot: { ok: true, spaceId: 12, page: 'p1', url: 'https://example.com/', title: 'Example Page', snapshot: '[p1] root\n  heading' },
        screenshot: { ok: true, spaceId: 12, page: 'p1', url: 'https://example.com/' },
        close: { ok: true, closed: true },
    });
    const h = createBrowserHandlers({ root, config: config(), engine: egoEngine(), runEgo: ego.run });
    try {
        const status = await h.browser({ action: 'status' });
        assert.match(status.output, /engine: ego — ego lite/);
        assert.match(status.output, /страница не открыта/);

        const opened = await h.browser({ action: 'open', url: 'https://example.com' });
        assert.match(opened.output, /title: Example Page/);
        assert.match(opened.output, /task_space: 12/);
        assert.match(ego.calls[0].script, /let __SPACE_ID = null;/);
        assert.ok(ego.calls[0].script.includes('getSpace("ai-test")'));
        assert.equal(ego.calls[0].executable, EGO_PATH);

        assert.match((await h.browser({ action: 'status' })).output, /страница p1 задачи 12/);

        const snap = await h.browser({ action: 'snapshot' });
        assert.match(snap.output, /\[p1\] root/);
        assert.match(ego.calls[1].script, /let __SPACE_ID = 12;/);

        const shot = await h.browser({ action: 'screenshot', output: 'shot.png' });
        assert.match(shot.output, /screenshot: shot\.png/);
        assert.match(shot.summary, /Б\)$/);

        const closed = await h.browser({ action: 'close' });
        assert.match(closed.output, /Задача 12 закрыта/);
        assert.match((await h.browser({ action: 'status' })).output, /страница не открыта/);

        await h.browser({ action: 'open', url: 'https://example.com' });
        const last = ego.calls.at(-1).script;
        assert.ok(last.includes('getSpace("ai-test-1")'), 'a finished space name cannot be reused');
        assert.match(last, /let __SPACE_ID = null;/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('browser urls stay on http(s) or inside the working directory', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ai-browser-test-'));
    try {
        await writeFile(path.join(root, 'page.html'), '<h1>hi</h1>');
        const ego = fakeEgo({ open: { ok: true, spaceId: 5, page: 'p1', url: 'https://example.com/', title: 'x' }, default: { ok: true } });
        const h = createBrowserHandlers({ root, config: config(), engine: egoEngine(), runEgo: ego.run });

        await assert.rejects(h.browser({ action: 'open', url: 'file:///C:/Windows/x.html' }), /file:\/\//);
        await assert.rejects(h.browser({ action: 'open', url: '--dump-dom' }), /дефиса/);
        await assert.rejects(h.browser({ action: 'open', url: '../outside.html' }), /вне рабочего каталога/);
        await assert.rejects(h.browser({ action: 'open', url: 'missing.html' }), /Файл не найден/);

        await h.browser({ action: 'open', url: 'page.html' });
        assert.match(ego.calls.at(-1).script, /page\.goto\("file:\/\/\/.+page\.html"\)/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a failed Ego screenshot falls back to headless Chromium for the page this run opened', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ai-browser-test-'));
    try {
        const ego = fakeEgo({
            open: { ok: true, spaceId: 9, page: 'p1', url: 'https://example.com/', title: 'Example' },
            screenshot: { ok: false, stage: 'screenshot', error: 'CDP request timed out: Page.captureScreenshot' },
        });
        const chrome = fakeChromium();
        const h = createBrowserHandlers({ root, config: config(), engine: egoEngine(), runEgo: ego.run, runChromium: chrome.run });
        await h.browser({ action: 'open', url: 'https://example.com' });
        const shot = await h.browser({ action: 'screenshot', output: 'fb.png' });
        assert.match(shot.output, /screenshot: fb\.png/);
        assert.match(shot.output, /bytes: 7/);
        assert.match(shot.output, /снимок сделан headless Chromium/);
        assert.match(shot.summary, /chromium fallback/);
        assert.equal(chrome.calls.length, 1);
        assert.equal(chrome.calls[0].executable, CHROME_PATH);
        assert.ok(chrome.calls[0].args.some((arg) => arg.startsWith('--screenshot=')));
        assert.equal(chrome.calls[0].args.at(-1), 'https://example.com/');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the Chromium screenshot fallback refuses a page outside the working directory', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ai-browser-test-'));
    const outside = process.platform === 'win32' ? 'file:///C:/Windows/other.html' : 'file:///etc/other.html';
    const ego = fakeEgo({
        open: { ok: true, spaceId: 9, page: 'p1', url: outside, title: 'Other' },
        screenshot: { ok: false, stage: 'screenshot', error: 'CDP request timed out: Page.captureScreenshot' },
    });
    const chrome = fakeChromium();
    const h = createBrowserHandlers({ root, config: config(), engine: egoEngine(), runEgo: ego.run, runChromium: chrome.run });
    try {
        await h.browser({ action: 'open', url: 'https://example.com' });
        await assert.rejects(h.browser({ action: 'screenshot', output: 'no.png' }), /Chromium-резерв не помог: страница вне рабочего каталога/);
        assert.equal(chrome.calls.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('browser_drive sends the selector and script to Ego and echoes the receipt', async () => {
    const ego = fakeEgo({
        open: { ok: true, spaceId: 4, page: 'p1', url: 'https://example.com/', title: 'x' },
        click: { ok: true, page: 'p1', url: 'https://example.com/', title: 'x', receipt: '{"clicked":true}', snapshot: '[p1] after click' },
        fill: { ok: true, page: 'p1', url: 'https://example.com/', title: 'x', receipt: '{}', snapshot: '' },
        eval: { ok: true, page: 'p1', url: 'https://example.com/', result: '{"a":1}' },
    });
    const h = createBrowserHandlers({ root: 'C:\\work', config: config(), engine: egoEngine(), runEgo: ego.run });
    await h.browser({ action: 'open', url: 'https://example.com' });
    const clicked = await h.browser_drive({ action: 'click', selector: '@3' });
    assert.match(clicked.output, /receipt: \{"clicked":true\}/);
    assert.match(clicked.output, /snapshot:\n\[p1\] after click/);
    assert.ok(ego.calls.at(-1).script.includes('targetRef("@3")'));
    await h.browser_drive({ action: 'fill', selector: 'text=Name', value: 'a b' });
    assert.ok(ego.calls.at(-1).script.includes('page.fill(ref, String("a b"))'));
    const evaluated = await h.browser_drive({ action: 'eval', script: '() => ({ a: 1 })' });
    assert.match(evaluated.output, /result: \{"a":1\}/);
    await assert.rejects(h.browser_drive({ action: 'drag', selector: '@1' }), /неизвестное действие drag/);
});

test('without Ego Lite the browser tool reads pages headless and declines interaction', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ai-browser-test-'));
    const chrome = fakeChromium();
    const h = createBrowserHandlers({ root, config: config(), engine: chromeEngine(), runChromium: chrome.run });
    try {
        assert.match((await h.browser({ action: 'status' })).output, /engine: chrome — headless chromium/);
        const opened = await h.browser({ action: 'open', url: 'https://example.com' });
        assert.match(opened.output, /страница прогрета/);
        assert.equal(chrome.calls[0].args.includes('--dump-dom'), true);
        const text = await h.browser({ action: 'text' });
        assert.match(text.output, /Page text/);
        assert.match(text.summary, /^text: \d+ симв\.$/);
        const shot = await h.browser({ action: 'screenshot', output: 'plain.png' });
        assert.match(shot.output, /screenshot: plain\.png/);
        assert.match(shot.output, /url: https:\/\/example\.com/);
        assert.doesNotMatch(shot.output, /headless Chromium\.$/m);
        await assert.rejects(h.browser({ action: 'snapshot' }), /только с Ego Lite/);
        await assert.rejects(h.browser_drive({ action: 'click', selector: '@1' }), /требует Ego Lite/);
        assert.match((await h.browser({ action: 'close' })).output, /закрывать нечего/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a page Ego cannot read is still readable through the text fallback', async () => {
    const ego = fakeEgo({
        open: { ok: true, spaceId: 8, page: 'p1', url: 'https://example.com/', title: 'x' },
        text: { ok: false, stage: 'text', error: 'page.evaluate: target closed' },
    });
    const chrome = fakeChromium();
    const h = createBrowserHandlers({ root: 'C:\\work', config: config(), engine: egoEngine(), runEgo: ego.run, runChromium: chrome.run });
    await h.browser({ action: 'open', url: 'https://example.com' });
    const text = await h.browser({ action: 'text' });
    assert.match(text.output, /текст прочитан headless Chromium/);
    assert.match(text.output, /Hello/);
    assert.equal(chrome.calls[0].args.at(-1), 'https://example.com/');
});

test('unknown browser actions are rejected', async () => {
    const h = createBrowserHandlers({ root: 'C:\\work', config: config(), engine: egoEngine(), runEgo: async () => ({ ok: true }) });
    await assert.rejects(h.browser({ action: 'teleport' }), /неизвестное действие teleport/);
    await assert.rejects(h.browser({ action: 'open' }), /Укажите url/);
});

test('createToolset exposes and executes the browser tools when tools.browser is on', async () => {
    const ego = fakeEgo({ status: { ok: true, spaceId: null, page: null }, default: { ok: true } });
    const cfg = config();
    const toolset = createToolset({
        root: 'C:\work', config: cfg, names: enabledToolNames(cfg.tools), approvalLevel: 'all',
        browserOverrides: { engine: egoEngine(), runEgo: ego.run },
    });
    const names = toolset.names();
    assert.equal(names.includes('browser'), true);
    assert.equal(names.includes('browser_drive'), true);
    const result = await toolset.execute({ name: 'browser', arguments: JSON.stringify({ action: 'status', reason: 'проверка' }) });
    assert.match(result.output, /engine: ego/);
    assert.equal(result.category, 'network');
    const driven = await toolset.execute({ name: 'browser_drive', arguments: JSON.stringify({ action: 'teleport' }) });
    assert.match(driven.output, /Ошибка:/);
});
