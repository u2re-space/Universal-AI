import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './helpers/mock-server.js';
import { defaults } from '../src/core/config.js';
import { createClient } from '../src/openai/client.js';
import { MAX_LINE_BYTES, buildCompletionContext, readCompletionWindow } from '../src/complete/context.js';
import { completeCode, stripCompletion } from '../src/complete/complete.js';
import { startCompletionServer } from '../src/complete/server.js';
import { readClientFrames } from '../src/complete/ws.js';
import { CompletionError } from '../src/complete/errors.js';

const bin = fileURLToPath(new URL('../bin/ai.js', import.meta.url));
let server;
let script = () => ({ text: 'ok' });
let endpoint;
let work;

const config = () => ({
    ...defaults,
    apiKey: 'sk-test',
    baseURL: server.baseURL,
    completion: { ...defaults.completion },
});

function client() {
    return createClient({ apiKey: 'sk-test', baseURL: server.baseURL });
}

before(async () => {
    server = await startMockServer({ script: (body, index) => script(body, index) });
    work = await mkdtemp(path.join(os.tmpdir(), 'ai-complete-'));
    endpoint = await startCompletionServer({
        port: 0,
        token: 'test-token',
        handle: async (request) => {
            const http = client();
            try { return await completeCode({ client: http, config: config(), request, cwd: work }); }
            finally { http.close(); }
        },
    });
});
beforeEach(() => server.reset());
after(async () => {
    await endpoint?.close();
    await server?.close();
    await rm(work, { recursive: true, force: true });
});

test('cursor coordinates insert | and leave a real pipe in the source', () => {
    const built = buildCompletionContext({
        path: 'src/app.js', language: 'javascript',
        content: 'a | b',
        cursor: { line: 0, character: 0 },
    });
    assert.equal(built.focus, '|a | b');
    assert.equal(built.cursorLineOmitted, false);
    assert.match(built.prompt, /File: src\/app\.js/);
    assert.match(built.prompt, /Language: javascript/);
});

test('a selection is the text to replace and the cursor sits at its start', () => {
    const built = buildCompletionContext({
        content: 'const name = "old";\n',
        selection: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
    });
    assert.match(built.focus, /const name = "\|";/);
    assert.match(built.prompt, /Replace this selection: old/);
});

test('without coordinates the first | is the cursor', () => {
    const built = buildCompletionContext({ content: 'const a = |;\n' });
    assert.match(built.focus, /const a = \|;/);
    assert.equal(built.focus.includes('||'), false);
});

test('prefix and suffix meet at the cursor', () => {
    const built = buildCompletionContext({ prefix: 'const a = ', suffix: ';\n', path: 'a.js' });
    assert.match(built.focus, /const a = \|;/);
});

test('the default window includes code a dozen lines from the cursor', () => {
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(`const near${String(i).padStart(2, '0')} = ${i};`);
    lines[20] = 'const cursor = |;';
    const built = buildCompletionContext({ content: lines.join('\n') });
    assert.match(built.focus, /const cursor = \|/);
    assert.match(built.focus, /near08/);
    assert.match(built.focus, /near32/);
    assert.equal(built.prompt.includes('near00'), false);
    assert.equal(built.prompt.includes('near39'), false);
});

test('a long opaque line near the cursor is not sent whole', () => {
    const blob = `M${'A'.repeat(400)}`;
    const built = buildCompletionContext({
        content: `const icon = "${blob}";\nconst cursor = ;\n`,
        cursor: { line: 1, character: 15 },
        neighborLines: 2,
    });
    assert.equal(built.prompt.includes(blob), false);
    assert.match(built.focus, /long line/);
    assert.match(built.focus, /const cursor = \|/);
    assert.match(built.prompt, /Editor buffer/);
});

test('a longer file does not add lines outside the cursor window', () => {
    const around = 'const left = 1;\nconst cursor = |;\nconst right = 2;\n';
    const short = buildCompletionContext({ content: around, neighborLines: 1 });
    const pad = Array.from({ length: 200 }, (_, i) => `const pad${i} = ${i};`).join('\n');
    const tail = Array.from({ length: 200 }, (_, i) => `const tail${i} = ${i};`).join('\n');
    const long = buildCompletionContext({ content: `${pad}\n${around}${tail}`, neighborLines: 1 });
    assert.match(long.focus, /const cursor = \|/);
    assert.equal(long.prompt.includes('pad0'), false);
    assert.equal(long.prompt.includes('tail0'), false);
    assert.equal(long.prompt.includes('Other context'), false);
    assert.ok(Buffer.byteLength(long.prompt) <= Buffer.byteLength(short.prompt) + 80);
});

test('a line over 0.5 MiB is omitted and the nearest lines stay', () => {
    const fat = `PAYLOAD${'B'.repeat(MAX_LINE_BYTES)}`;
    const built = buildCompletionContext({
        content: `before\n${fat}\nafter`,
        cursor: { line: 1, character: 3 },
    });
    assert.equal(MAX_LINE_BYTES, 512 * 1024);
    assert.equal(built.cursorLineOmitted, true);
    assert.equal(built.focus, 'before\n|\nafter');
    assert.equal(built.prompt.split('\n').some((line) => line.length > 1000), false);
    assert.equal(built.omittedLines.includes(1), true);
});

test('file context keeps the cursor line and drops text far from it', () => {
    const lines = ['START_MARKER'];
    for (let i = 0; i < 80; i++) lines.push(`const value${String(i).padStart(2, '0')} = ${i};`);
    lines.push('END_MARKER');
    const built = buildCompletionContext({
        content: lines.join('\n'),
        cursor: { line: 40, character: 6 },
        maxContextBytes: 180,
        neighborLines: 0,
    });
    assert.equal(built.truncated, true);
    assert.match(built.focus, /\|/);
    assert.equal(built.prompt.includes('START_MARKER'), false);
    assert.equal(built.prompt.includes('END_MARKER'), false);
    assert.match(built.focus, /value39/);
});

test('a large file is windowed and an oversized line is not kept', async () => {
    const fat = `PAYLOAD${'C'.repeat(80)}`;
    const file = path.join(work, 'sample.js');
    await writeFile(file, `above\n${fat}\nbelow\n`);
    const window = await readCompletionWindow(file, { cursorLine: 1, maxLineBytes: 32, maxContextBytes: 200 });
    assert.equal(window.text.includes('PAYLOAD'), false);
    assert.equal(window.omittedLines.length > 0, true);
    const built = buildCompletionContext({
        content: window.text,
        cursor: { line: window.cursorLine, character: 0 },
        omitLines: window.omittedLines,
        startLine: window.startLine,
        maxLineBytes: 32,
        maxContextBytes: 200,
    });
    assert.equal(built.cursorLineOmitted, true);
    assert.match(built.focus, /above/);
    assert.match(built.focus, /below/);
    assert.equal(built.prompt.includes('PAYLOAD'), false);
});

test('stripCompletion removes one wrapping fence', () => {
    assert.equal(stripCompletion('```js\nfoo()\n```'), 'foo()');
    assert.equal(stripCompletion('  foo()'), '  foo()');
});

test('masked client frames decode and unmasked frames are rejected', () => {
    const payload = Buffer.from('hi');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
    const parsed = readClientFrames(frame, 1000);
    assert.equal(parsed.frames[0].payload.toString(), 'hi');
    assert.throws(() => readClientFrames(Buffer.from([0x81, 0x01, 0x41]), 1000), /UNMASKED/);
});

test('completeCode calls the fast model at low effort and returns the insertion', async () => {
    script = (body) => {
        //assert.equal(body.model, 'gpt-6-luna');
        assert.equal(body.model, 'deepseek/deepseek-v4.1-flash');
        assert.equal(body.reasoning.effort, 'none');
        assert.equal(body.stream, false);
        assert.equal(body.store, false);
        assert.equal(body.tools, undefined);
        assert.equal(body.text?.verbosity ?? 'low', 'low');
        assert.equal(body.max_output_tokens, 160);
        assert.match(body.input, /const a = \|/);
        assert.equal(body.input.includes('SECRET_BASE64'), false);
        return { text: '```js\n1;\n```' };
    };
    const http = client();
    try {
        const result = await completeCode({
            client: http,
            config: config(),
            request: { content: `const a = |\n${'SECRET_BASE64'}${'D'.repeat(40)}`, maxLineBytes: 16, neighborLines: 0 },
        });
        assert.equal(result.text, '1;');
        //assert.equal(result.model, 'gpt-6-luna');
        assert.equal(result.model, 'deepseek/deepseek-v4.1-flash');
        assert.equal(result.cursorLineOmitted, false);
    } finally { http.close(); }
});

test('reading a secret path is rejected', async () => {
    await writeFile(path.join(work, '.env'), 'TOKEN=1\n');
    const http = client();
    try {
        await assert.rejects(
            () => completeCode({ client: http, config: config(), request: { path: '.env', cursor: { line: 0, character: 0 } }, cwd: work }),
            (error) => error instanceof CompletionError && error.code === 'BAD_PATH',
        );
    } finally { http.close(); }
});

test('HTTP completion requires the token and returns the insertion', async () => {
    script = () => ({ text: 'next' });
    const denied = await fetch(endpoint.httpURL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'const a = |' }),
    });
    assert.equal(denied.status, 401);
    const health = await fetch(endpoint.httpURL.replace(/\/v1\/complete$/, '/health'));
    assert.equal((await health.json()).ok, true);
    const accepted = await fetch(endpoint.httpURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ id: 'req-1', content: 'const a = |' }),
    });
    const body = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(body.id, 'req-1');
    assert.equal(body.text, 'next');
    //assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.model, 'deepseek/deepseek-v4.1-flash');
});

test('a second completion within one second does not call the model', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    let calls = 0;
    script = () => {
        calls += 1;
        return { text: 'once' };
    };
    const post = (id) => fetch(endpoint.httpURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ id, content: 'const a = |' }),
    });
    const first = await (await post('gap-1')).json();
    const second = await (await post('gap-2')).json();
    assert.equal(calls, 1);
    assert.equal(first.text, 'once');
    assert.equal(second.text, '');
    assert.equal(second.id, 'gap-2');
});

test('WebSocket completion and ping use the same request', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    script = (body) => {
        assert.match(body.input, /return \|/);
        return { text: ' items.length' };
    };
    const ws = new WebSocket(`${endpoint.wsURL}?token=${encodeURIComponent('test-token')}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const messages = [];
    ws.onmessage = (event) => messages.push(JSON.parse(event.data));
    ws.send(JSON.stringify({ type: 'ping', id: 'p1' }));
    ws.send(JSON.stringify({ type: 'complete', id: 'c1', content: 'return |' }));
    const deadline = Date.now() + 5000;
    while (messages.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    ws.close();
    assert.equal(messages[0].type, 'pong');
    assert.equal(messages[0].id, 'p1');
    const completion = messages.find((message) => message.type === 'completion');
    assert.equal(completion.id, 'c1');
    assert.equal(completion.text, ' items.length');
});

function runCli(args, { input = null, env = {} } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [bin, ...args], {
            cwd: work,
            env: {
                ...process.env, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: server.baseURL,
                AI_AGENT_HOME: work, NO_COLOR: '1', ...env,
            },
            stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        if (input !== null) child.stdin.end(input);
    });
}

test('ai complete --json prints the insertion from stdin', async () => {
    script = (body) => {
        //assert.equal(body.model, 'gpt-6-luna');
        assert.equal(body.model, 'deepseek/deepseek-v4.1-flash');
        assert.equal(body.reasoning.effort, 'none');
        assert.match(body.input, /alpha \|/);
        return { text: 'beta' };
    };
    const { code, stdout } = await runCli(['complete', '--json'], { input: JSON.stringify({ content: 'alpha |' }) });
    assert.equal(code, 0);
    const result = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.type === 'completion');
    assert.equal(result.text, 'beta');
    //assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.model, 'deepseek/deepseek-v4.1-flash');
});

test('ai complete --listen serves health on 127.0.0.1 and then stops', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-complete-home-'));
    const child = spawn(process.execPath, [bin, 'complete', '--listen', '--port', '0', '--token', 'listen-token'], {
        cwd: work,
        env: { ...process.env, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: server.baseURL, AI_AGENT_HOME: home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`сервер не поднялся: ${stderr}`)), 8000);
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/v1\/complete/);
            if (match) { clearTimeout(timer); resolve(match[0]); }
        });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`выход ${code}: ${stderr}`)); });
    });
    try {
        const health = await fetch(url.replace(/\/v1\/complete$/, '/health'));
        assert.equal((await health.json()).ok, true);
        const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(denied.status, 401);
    } finally {
        child.kill();
        await new Promise((resolve) => child.once('exit', resolve));
        await rm(home, { recursive: true, force: true });
    }
});
