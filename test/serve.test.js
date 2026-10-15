import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServe, pidAlive } from '../src/commands/serve.js';
import { splitServeUrl, assertLoopback, attachPublisher } from '../src/server/publish.js';
import { startMockServer } from './helpers/mock-server.js';

function once(target, event) {
    return new Promise((resolve, reject) => {
        target.addEventListener(event, (value) => resolve(value));
        target.addEventListener('error', () => reject(new Error('socket error')));
    });
}
const framesOf = (ws, bucket) => ws.addEventListener('message', (event) => bucket.push(JSON.parse(String(event.data))));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(frames, pred) {
    for (let i = 0; i < 150; i++) {
        const found = frames.find(pred);
        if (found) return found;
        await delay(30);
    }
    throw new Error(`frame not seen: ${JSON.stringify(frames)}`);
}

test('serve writes serve.json, answers hello, and removes the file on close', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-'));
    const handle = await startServe({ home, token: 'a'.repeat(64), onStart() {} });
    try {
        const file = JSON.parse(await readFile(path.join(home, 'serve.json'), 'utf8'));
        assert.equal(file.url, handle.url);
        assert.equal(file.token, 'a'.repeat(64));
        assert.equal(file.pid, process.pid);
        if (process.platform !== 'win32') assert.equal((await stat(path.join(home, 'serve.json'))).mode & 0o777, 0o600);
        assert.equal(pidAlive(file.pid), true);
        const ws = new WebSocket(handle.url);
        const frames = [];
        framesOf(ws, frames);
        await once(ws, 'open');
        ws.send(JSON.stringify({ type: 'hello', role: 'client', token: 'a'.repeat(64) }));
        await delay(50);
        assert.equal(frames[0].type, 'ready');
        ws.close();
    } finally {
        await handle.close();
        await assert.rejects(readFile(path.join(home, 'serve.json'), 'utf8'));
        await rm(home, { recursive: true, force: true });
    }
});

test('splitServeUrl lifts only a ws URL that follows --serve', () => {
    assert.deepEqual(splitServeUrl(['run', 'x', '--serve']), { argv: ['run', 'x', '--serve'], serveUrl: null });
    assert.deepEqual(splitServeUrl(['run', '--serve', 'ws://127.0.0.1:9', '--yes']), { argv: ['run', '--serve', '--yes'], serveUrl: 'ws://127.0.0.1:9' });
    assert.throws(() => assertLoopback('wss://127.0.0.1:9'), /127\.0\.0\.1/);
    assert.throws(() => assertLoopback('ws://example.com:9'), /127\.0\.0\.1/);
    assert.equal(assertLoopback('ws://localhost:9').hostname, 'localhost');
});

test('attachPublisher registers a terminal run and forwards an event', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-pub-'));
    const handle = await startServe({ home, token: 'b'.repeat(64), onStart() {} });
    const watchFrames = [];
    try {
        const watch = new WebSocket(handle.url);
        framesOf(watch, watchFrames);
        await once(watch, 'open');
        watch.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
        const publisher = await attachPublisher({ home, command: 'run', title: 'run demo', cwd: process.cwd() });
        const started = await waitFor(watchFrames, (frame) => frame.type === 'run.started' && frame.run.source === 'terminal');
        watch.send(JSON.stringify({ type: 'subscribe', runId: started.run.id }));
        publisher.event({ type: 'stage.start', stage: 'plan' });
        await waitFor(watchFrames, (frame) => frame.type === 'run.event' && frame.event.stage === 'plan');
        await publisher.end('completed', 0);
        await waitFor(watchFrames, (frame) => frame.type === 'run.ended' && frame.status === 'completed' && frame.exitCode === 0);
        watch.close();
        publisher.close();
    } finally {
        await handle.close();
        await rm(home, { recursive: true, force: true });
    }
});

test('ask over the socket waits for the owner approval and ignores a watcher', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-ask-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-work-'));
    const server = await startMockServer({
        script: (body) => (body.input?.some((item) => item.type === 'function_call_output')
            ? { text: 'готово' }
            : { calls: [{ name: 'write_file', arguments: { path: 'note.txt', content: 'ok\n', overwrite: true } }] }),
    });
    const saved = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
        AI_MODEL: process.env.AI_MODEL, AI_AGENT_HOME: process.env.AI_AGENT_HOME,
    };
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = server.baseURL;
    process.env.AI_MODEL = 'mock-model';
    process.env.AI_AGENT_HOME = home;
    const handle = await startServe({ home, port: 0 });
    try {
        const ownerFrames = [];
        const watchFrames = [];
        const owner = new WebSocket(handle.url);
        const watch = new WebSocket(handle.url);
        framesOf(owner, ownerFrames);
        framesOf(watch, watchFrames);
        await once(owner, 'open');
        await once(watch, 'open');
        owner.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
        watch.send(JSON.stringify({ type: 'hello', role: 'client', token: handle.token }));
        await delay(30);
        watch.send(JSON.stringify({ type: 'subscribe', runId: '*' }));
        owner.send(JSON.stringify({
            type: 'start', command: 'ask', prompt: 'создай note.txt', cwd: work, approve: 'ask', tools: 'fs', web: false,
        }));
        const request = await waitFor(ownerFrames, (frame) => frame.type === 'approval.request');
        watch.send(JSON.stringify({ type: 'approve', requestId: request.requestId, decision: 'yes' }));
        await waitFor(watchFrames, (frame) => frame.code === 'not_owner');
        assert.ok(watchFrames.some((frame) => frame.type === 'run.event' && frame.event.type === 'approval.pending'));
        assert.equal(watchFrames.some((frame) => frame.type === 'approval.request'), false);
        owner.send(JSON.stringify({ type: 'approve', requestId: request.requestId, decision: 'yes' }));
        await waitFor(ownerFrames, (frame) => frame.type === 'run.ended' && frame.status === 'completed');
        assert.equal(await readFile(path.join(work, 'note.txt'), 'utf8'), 'ok\n');
    } finally {
        await handle.close();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await server.close();
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

test('ai serve CLI accepts --port and a publisher event', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-cli-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-cli-work-'));
    const bin = fileURLToPath(new URL('../bin/ai.js', import.meta.url));
    const child = spawn(process.execPath, [bin, 'serve', '--port', '0', '--model', 'mock-model'], {
        cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: home, NO_COLOR: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
        const info = await waitForFile(path.join(home, 'serve.json'));
        assert.match(stderr, /WebSocket: ws:\/\/127\.0\.0\.1:/);
        assert.equal(stderr.includes(info.token), false);
        const publisher = new WebSocket(info.url);
        const frames = [];
        framesOf(publisher, frames);
        await once(publisher, 'open');
        publisher.send(JSON.stringify({ type: 'hello', role: 'publisher', token: info.token, command: 'run', title: 'run demo', cwd: work }));
        await waitFor(frames, (frame) => frame.type === 'run.started' && frame.run.source === 'terminal');
        publisher.close();
    } finally {
        child.kill('SIGINT');
        await onceEvent(child, 'exit');
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

function onceEvent(emitter, name) {
    return new Promise((resolve) => emitter.once(name, resolve));
}

async function waitForFile(file) {
    for (let i = 0; i < 50; i++) {
        try { return JSON.parse(await readFile(file, 'utf8')); }
        catch { await delay(40); }
    }
    throw new Error(`missing ${file}`);
}
