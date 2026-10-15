import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ahkString, scriptFor, wrapScript } from '../src/interact/filesystem.js';

const base = { type: 'click', mode: 'coord', x: 10, y: 20, button: 'Left', clicks: 1, text: null, title: null, control: null, image: null, script: null };

test('ahkString escapes quotes and newlines', () => {
    assert.equal(ahkString('a"b'), '"a`"b"');
    assert.match(ahkString('a\nb'), /`n/);
    const encoded = ahkString('a ;b');
    const semi = encoded.indexOf(';');
    assert.ok(semi > 0);
    assert.equal(encoded[semi - 1], '`');
});

test('coord click and wrap include v2 and a screenshot call', () => {
    const body = scriptFor(base);
    const wrapped = wrapScript(body);
    assert.match(wrapped, /#Requires AutoHotkey v2\.0/);
    assert.match(wrapped, /#Warn All, Off/);
    assert.match(wrapped, /#DllLoad "gdiplus"/);
    assert.match(body, /GetSystemMetrics", "Int", 76/);
    assert.match(body, /GetSystemMetrics", "Int", 77/);
    assert.match(wrapped, /Click\(originX \+ 10, originY \+ 20, "Left", 1\)/);
    assert.match(wrapped, /SaveScreenshot\(shotPath\)/);
    assert.match(wrapped, /557CF406/);
    assert.match(wrapped, /screenshot failed: " \. status/);
});

test('control click is a statement', () => {
    const control = scriptFor({ ...base, mode: 'control', title: 'Notepad', control: 'Edit1' });
    assert.doesNotMatch(control, /if !ControlClick/);
    assert.match(control, /^ControlClick\(/);
});

test('type, title, and image bodies', () => {
    assert.match(scriptFor({ ...base, type: 'type', mode: 'text', text: 'hi' }), /SendText\("hi"\)/);
    assert.match(scriptFor({ ...base, type: 'type', mode: 'keys', text: '^s' }), /Send\("\^s"\)/);
    assert.match(scriptFor({ ...base, mode: 'title', title: 'Note"pad', x: null, y: null }), /WinActivate\("Note`"pad"\)/);
    const image = scriptFor({ ...base, mode: 'image', image: 'C:\\btn.png' });
    assert.match(image, /ImageSearch\(&foundX, &foundY, originX, originY, originX \+ virtualW, originY \+ virtualH,/);
    assert.match(image, /Click\(foundX, foundY, "Left", 1\)/);
    assert.match(image, /GetSystemMetrics", "Int", 76/);
    assert.match(image, /GetSystemMetrics", "Int", 78/);
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAhk, performAction } from '../src/interact/filesystem.js';

const fakeAhk = fileURLToPath(new URL('./helpers/fake-ahk.js', import.meta.url));

test('findAhk uses an explicit path and rejects a missing file', async () => {
    await assert.rejects(findAhk({ ahkPath: path.join(os.tmpdir(), 'missing-ahk.exe'), env: {}, exists: async () => false }), /AutoHotkey v2/);
});

test('performAction runs the fake executable and records a screenshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-desktop-'));
    try {
        const outcome = await performAction({
            root, executable: process.execPath, prefixArgs: [fakeAhk], shotAfterAction: true, timeoutMs: 10000,
            action: { type: 'click', mode: 'coord', x: 1, y: 2, button: 'Left', clicks: 1, text: null, title: null, control: null, image: null, script: null },
        });
        assert.equal(outcome.message, 'ok');
        assert.match(outcome.screenshotRel, /^\.ai\/desktop\/\d{8}-\d{6}-\d+\.png$/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

import { parseBatch, executeBatch } from '../src/interact/batch.js';

test('parseBatch accepts TOON and rejects an unknown action', () => {
    const text = [
        'summary: click Save',
        'actions[1]{type,mode,x,y,button,clicks,text,title,control,image,script}:',
        '  click,coord,3,4,left,1,null,null,null,null,null',
    ].join('\n');
    const batch = parseBatch(text);
    assert.equal(batch.actions[0].x, 3);
    assert.equal(batch.actions[0].button, 'Left');
    assert.throws(() => parseBatch('{"summary":"x","actions":[{"type":"dance"}]}'), /type/);
});

test('executeBatch asks before each action and stops on denial', async () => {
    const seen = [];
    await assert.rejects(executeBatch({
        batch: { summary: 'two', actions: [
            { type: 'screenshot', mode: null, x: null, y: null, button: null, clicks: null, text: null, title: null, control: null, image: null, script: null },
            { type: 'click', mode: 'coord', x: 1, y: 1, button: 'left', clicks: 1, text: null, title: null, control: null, image: null, script: null },
        ] },
        approveAction: async (action) => action.type === 'screenshot',
        perform: async (action) => { seen.push(action.type); return { message: 'ok' }; },
    }), /отклонено/);
    assert.deepEqual(seen, ['screenshot']);
});

import { enabledToolNames, createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';

test('desktop tools follow the exec approval gate', async () => {
    assert.equal(enabledToolNames({ ...defaults.tools, desktop: false }).includes('click'), false);
    const names = enabledToolNames({ ...defaults.tools, desktop: true });
    for (const name of ['screenshot', 'click', 'type', 'run_ahk', 'run_batch', 'delegate_role']) assert.equal(names.includes(name), true);
    const toolset = createToolset({
        root: os.tmpdir(), config: defaults, names: ['click'], approvalLevel: 'read', approve: async () => 'yes',
    });
    const denied = await toolset.execute({ name: 'click', arguments: JSON.stringify({ mode: 'coord', x: 1, y: 2, button: 'left', clicks: 1, title: '', control: '', image: '' }) });
    assert.match(denied.output, /отклонена/);
    let performed = 0;
    const allowed = createToolset({
        root: os.tmpdir(), config: defaults, names: ['screenshot'], approvalLevel: 'all', approve: async () => 'no',
        performDesktop: async () => { performed += 1; return { message: 'ok', screenshotAbs: null, screenshotRel: null }; },
    });
    const shot = await allowed.execute({ name: 'screenshot', arguments: '{}' });
    assert.equal(performed, 1);
    assert.match(shot.output, /ok/);
});

import { toolNamesForRole } from '../src/agent/team.js';
import { DESKTOP_TOOL_NAMES } from '../src/agent/desktop.js';
import { READ_ONLY_TOOLS } from '../src/agent/tools.js';

test('reviewer receives desktop tools and the collector does not', () => {
    const all = [...READ_ONLY_TOOLS, 'run_command', 'write_file', ...DESKTOP_TOOL_NAMES];
    const reviewer = toolNamesForRole(all, 'reviewer');
    assert.equal(reviewer.includes('click'), true);
    assert.equal(reviewer.includes('write_file'), false);
    const collector = toolNamesForRole(all, 'collector');
    assert.equal(collector.includes('click'), false);
    assert.equal(collector.includes('read_file'), true);
});

test('performAction does not pass OPENAI_API_KEY to AutoHotkey', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-desktop-'));
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-desktop-test';
    const recorded = [];
    try {
        const outcome = await performAction({
            root,
            executable: 'AutoHotkey64.exe',
            timeoutMs: 5000,
            action: { type: 'click', mode: 'coord', x: 1, y: 2, button: 'Left', clicks: 1, text: null, title: null, control: null, image: null, script: null },
            spawnFn(executable, args, options) {
                recorded.push({ executable, args: [...args], env: options.env });
                const resultPath = args.at(-1);
                const handlers = {};
                const child = {
                    once(event, listener) {
                        (handlers[event] ??= []).push(listener);
                        return child;
                    },
                    kill() {},
                };
                setImmediate(() => {
                    writeFile(resultPath, 'ok', 'utf8').then(() => {
                        for (const listener of handlers.exit ?? []) listener(0);
                    }, (error) => {
                        for (const listener of handlers.error ?? []) listener(error);
                    });
                });
                return child;
            },
        });
        assert.equal(outcome.message, 'ok');
        assert.equal(recorded.length, 1);
        assert.ok(Array.isArray(recorded[0].args));
        assert.equal(recorded[0].args[0], '/ErrorStdOut=UTF-8');
        assert.equal(Object.hasOwn(recorded[0].env, 'OPENAI_API_KEY'), false);
        assert.equal(Object.values(recorded[0].env).includes('sk-desktop-test'), false);
    } finally {
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test('run_batch approves each action when the level is ask', async () => {
    const performed = [];
    const toolset = createToolset({
        root: os.tmpdir(),
        config: defaults,
        names: ['run_batch'],
        approvalLevel: 'ask',
        approve: async ({ name, preview }) => {
            if (name === 'click' || String(preview ?? '').startsWith('click')) return 'no';
            if (name === 'screenshot' || String(preview ?? '').includes('screenshot')) return 'yes';
            return 'no';
        },
        performDesktop: async (action) => {
            performed.push(action.type);
            return { message: 'ok', screenshotAbs: null, screenshotRel: null };
        },
    });
    const batch = {
        summary: 'two',
        actions: [
            { type: 'screenshot' },
            { type: 'click', mode: 'coord', x: 1, y: 1, button: 'left', clicks: 1 },
        ],
    };
    const result = await toolset.execute({
        name: 'run_batch',
        arguments: JSON.stringify({ batch_json: JSON.stringify(batch), batch_toon: '', path: '' }),
    });
    assert.deepEqual(performed, ['screenshot']);
    assert.match(result.output, /действие 2 отклонено/);
});
