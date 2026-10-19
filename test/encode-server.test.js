import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { defaults } from '../src/core/config.js';
import { startEncodeHost } from '../src/encode/host.js';

function stderrSink() {
    let text = '';
    const stream = new Writable({
        write(chunk, _enc, callback) { text += chunk.toString(); callback(); },
    });
    return { stream, read: () => text };
}

function parseSse(body) {
    const data = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    return JSON.parse(data);
}

async function mcp(url, message, headers) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(message),
    });
    const text = await response.text();
    if (!message.id) {
        assert.ok(response.status === 200 || response.status === 202, text);
        return null;
    }
    assert.equal(response.status, 200, text);
    return parseSse(text);
}

test('the encode server lists tools, reads through Node, and sends writes to a holder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-encode-host-'));
    const logs = stderrSink();
    await writeFile(path.join(root, 'note.txt'), 'hello file\n');
    const host = await startEncodeHost({
        root, config: defaults, stderr: logs.stream, approvalLevel: 'all',
    });
    try {
        assert.match(logs.read(), new RegExp(`MCP: ${host.mcpURL}`));
        assert.match(logs.read(), new RegExp(`Processing: ${host.processingURL}`));
        const init = await mcp(host.mcpURL, {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        });
        assert.equal(init.id, 1);
        const headers = { 'mcp-protocol-version': init.result.protocolVersion };
        await mcp(host.mcpURL, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
        const list = await mcp(host.mcpURL, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers);
        const names = list.result.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, ['delete_file', 'encode', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file']);
        const read = await mcp(host.mcpURL, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'read_file', arguments: { path: 'note.txt' } },
        }, headers);
        assert.match(read.result.content[0].text, /hello file/);

        const frames = [];
        const ws = new WebSocket(host.processingURL);
        ws.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve);
            ws.addEventListener('error', () => reject(new Error('socket error')));
        });
        ws.send(JSON.stringify({ type: 'hello' }));
        await waitFor(frames, (frame) => frame.type === 'ready');
        ws.send(JSON.stringify({ type: 'processing.claim', tools: ['write_file'] }));
        await waitFor(frames, (frame) => frame.type === 'processing.claimed');
        const pending = mcp(host.mcpURL, {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: {
                name: 'encode',
                arguments: {
                    text: 'answer', workspace: '', directoryTree: '.',
                    artifacts: [{ id: 'a001', body: 'remote', hintLanguage: 'txt', hintPath: 'out.txt' }],
                },
            },
        }, headers);
        const request = await waitFor(frames, (frame) => frame.type === 'tool.request');
        assert.equal(request.name, 'write_file');
        assert.equal(request.args.path, 'out.txt');
        ws.send(JSON.stringify({ type: 'tool.result', requestId: request.requestId, output: 'записан', summary: '+ out.txt' }));
        const encoded = await pending;
        assert.deepEqual(JSON.parse(encoded.result.content[0].text), { written: ['out.txt'] });
        assert.equal(await stat(path.join(root, 'out.txt')).catch(() => null), null);
        ws.close();
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

async function waitFor(frames, pred) {
    for (let i = 0; i < 50; i++) {
        const found = frames.find(pred);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`frame not seen: ${JSON.stringify(frames)}`);
}
