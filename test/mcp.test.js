import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createFrameParser } from '../src/mcp/frame.js';
import { connectMcp } from '../src/mcp/client.js';
import { mcpToolName, normalizeMcpServer, remoteMcpTools } from '../src/mcp/servers.js';
import { builtinTools } from '../src/agent/loop.js';
import { createSession } from '../src/core/session.js';
import { ensureLocalEnv } from './helpers/local-env.js';
import { openMcpSources } from '../src/mcp/session.js';
import { createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config-defaults.js';

const fixture = fileURLToPath(new URL('./helpers/mcp-stdio.js', import.meta.url));
const bin = fileURLToPath(new URL('../bin/ai.js', import.meta.url));

test('frames survive a split chunk and a second message', () => {
    const first = encodeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const second = encodeMessage({ jsonrpc: '2.0', method: 'ping', id: 9 });
    const parser = createFrameParser();
    assert.deepEqual(parser.push(first.subarray(0, 8)), []);
    assert.deepEqual(parser.push(Buffer.concat([first.subarray(8), second])), [
        { jsonrpc: '2.0', id: 1, result: { ok: true } },
        { jsonrpc: '2.0', method: 'ping', id: 9 },
    ]);
    assert.throws(() => encodeMessage({ blob: 'x'.repeat(9 * 1024 * 1024) }), /MCP: сообщение больше/);
});

test('server ids and tool names stay within the function-name rules', () => {
    const server = normalizeMcpServer({ id: 'design', command: 'node', args: ['server.js'] });
    assert.equal(server.transport, 'stdio');
    assert.equal(server.enabled, true);
    assert.deepEqual(server.args, ['server.js']);
    assert.equal(mcpToolName('design', 'echo'), 'mcp_design_echo');
    const long = mcpToolName('design', 't'.repeat(80));
    assert.ok(long.length <= 64);
    assert.match(long, /^mcp_design_/);
    assert.throws(() => normalizeMcpServer({ id: 'Bad', command: 'node' }), /id/);
    assert.throws(() => normalizeMcpServer({ id: 'ok', transport: 'http' }), /server_url/);
    assert.throws(() => normalizeMcpServer({ id: 'ok', server_url: 'http://example.com/mcp' }), /https/);
});

test('a remote MCP server becomes a Responses API mcp tool and is not spawned', () => {
    const server = normalizeMcpServer({
        id: 'openai_docs',
        server_url: 'https://developers.openai.com/mcp',
        server_description: 'OpenAI docs',
        allowed_tools: ['search_openai_docs'],
    });
    assert.equal(server.transport, 'http');
    assert.equal(server.require_approval, 'never');
    const tool = remoteMcpTools([server, normalizeMcpServer({ id: 'local', command: 'node' })])[0];
    assert.deepEqual(tool, {
        type: 'mcp',
        server_label: 'openai_docs',
        server_url: 'https://developers.openai.com/mcp',
        server_description: 'OpenAI docs',
        require_approval: 'never',
        allowed_tools: ['search_openai_docs'],
    });
    const cfg = { ...defaults, mcp: { servers: [server] } };
    assert.equal(builtinTools(cfg).some((item) => item.type === 'mcp' && item.server_label === 'openai_docs'), true);
    assert.equal(builtinTools({ ...cfg, tools: { ...defaults.tools, mcp: false } }).some((item) => item.type === 'mcp'), false);
    const session = createSession({ store: false });
    session.recordResponse({ id: 'resp_1', output: [{ type: 'mcp_call', id: 'mcp_1', name: 'search_openai_docs', server_label: 'openai_docs' }] });
    assert.equal(session.requestInput().input.some((item) => item.type === 'mcp_call'), true);
});

test('MCP children do not inherit secret environment variables', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-mcp-env-'));
    const marker = path.join(dir, 'marker.txt');
    const script = path.join(dir, 'check.js');
    await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], process.env.OPENAI_API_KEY ? 'leaked' : 'clean');\nprocess.exit(0);\n`);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret';
    try {
        await connectMcp({ command: process.execPath, args: [script, marker], timeoutMs: 3000 }).catch(() => {});
        assert.equal(await readFile(marker, 'utf8'), 'clean');
    } finally {
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
        await rm(dir, { recursive: true, force: true });
    }
});

test('stdio client lists echo, calls it, and reads the note', async () => {
    const client = await connectMcp({ id: 'demo', command: process.execPath, args: [fixture], timeoutMs: 5000 });
    try {
        assert.equal(client.protocolVersion, '2025-06-18');
        const tools = await client.listTools();
        assert.equal(tools[0].name, 'echo');
        const called = await client.callTool('echo', { text: 'hi' });
        assert.equal(called.text, 'echo:hi');
        assert.equal(called.isError, false);
        const resources = await client.listResources();
        assert.equal(resources[0].uri, 'mcp://demo/note');
        assert.equal(await client.readResource('mcp://demo/note'), 'hello resource');
    } finally {
        await client.close();
    }
});

test('a dead server is skipped and the live tool runs through the toolset', async () => {
    const session = await openMcpSources({
        tools: { mcp: true },
        limits: { maxCommandOutputBytes: 4096 },
        mcp: {
            servers: [
                normalizeMcpServer({ id: 'dead', command: process.execPath, args: ['-e', 'process.exit(3)'] }),
                normalizeMcpServer({ id: 'demo', command: process.execPath, args: [fixture] }),
            ],
        },
    }, {});
    try {
        assert.equal(session.errors.length, 1);
        assert.equal(session.errors[0].id, 'dead');
        const echo = session.extras.find((extra) => extra.name === 'mcp_demo_echo');
        assert.ok(echo);
        assert.equal(echo.category, 'network');
        assert.deepEqual(echo.parameters.required, ['arguments_json']);
        const reads = session.extras.filter((extra) => extra.category === 'read').map((extra) => extra.name);
        assert.deepEqual(reads, ['mcp_list_resources', 'mcp_read_resource']);
        const toolset = createToolset({
            root: os.tmpdir(),
            config: { limits: defaults.limits, tools: defaults.tools, shell: null },
            names: [],
            approvalLevel: 'all',
            extras: session.extras,
        });
        assert.ok(toolset.names().includes('mcp_demo_echo'));
        const called = await toolset.execute({ name: 'mcp_demo_echo', arguments: JSON.stringify({ arguments_json: '{"text":"hi"}' }) });
        assert.equal(called.ok, true);
        assert.match(called.output, /echo:hi/);
        const listed = await toolset.execute({ name: 'mcp_list_resources', arguments: JSON.stringify({ server_id: 'demo' }) });
        assert.match(listed.output, /mcp:\/\/demo\/note/);
        const read = await toolset.execute({ name: 'mcp_read_resource', arguments: JSON.stringify({ server_id: 'demo', uri: 'mcp://demo/note' }) });
        assert.match(read.output, /hello resource/);
        assert.match(session.describe(), /mcp_demo_echo/);
    } finally {
        await session.close();
    }
});

test('tools.mcp false connects nothing', async () => {
    const session = await openMcpSources({ tools: { mcp: false }, mcp: { servers: [{ id: 'demo', command: 'nope' }] } }, {});
    assert.deepEqual(session.extras, []);
    assert.equal(session.describe(), '');
});

test('ai mcp add, list, and probe do not need an API key', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-mcp-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-mcp-work-'));
    await ensureLocalEnv(work);
    const run = (args) => new Promise((resolve) => {
        const child = spawn(process.execPath, [bin, ...args], {
            cwd: work,
            env: { ...process.env, OPENAI_API_KEY: '', AI_AGENT_HOME: home, AI_MODEL: 'mock-model', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    try {
        const empty = await run(['mcp', 'list']);
        assert.equal(empty.code, 0, empty.stderr);
        assert.match(empty.stdout, /не заданы/);
        const added = await run(['mcp', 'add', 'demo', '--mcp-command', process.execPath, '--mcp-arg', fixture]);
        assert.equal(added.code, 0, added.stderr);
        assert.match(added.stdout, /Добавлен MCP-сервер demo/);
        const listed = await run(['mcp', 'list']);
        assert.equal(listed.code, 0, listed.stderr);
        assert.match(listed.stdout, /^demo\tвключён/m);
        const probed = await run(['mcp', 'probe', 'demo']);
        assert.equal(probed.code, 0, probed.stderr);
        assert.match(probed.stdout, /mcp_demo_echo/);
        assert.match(probed.stdout, /mcp:\/\/demo\/note/);
        const file = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
        assert.equal(file.mcp.servers[0].id, 'demo');
        assert.equal(file.mcp.servers[0].env, undefined);
        const removed = await run(['mcp', 'remove', 'demo']);
        assert.equal(removed.code, 0, removed.stderr);
        const gone = await run(['mcp', 'list']);
        assert.match(gone.stdout, /не заданы/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});
