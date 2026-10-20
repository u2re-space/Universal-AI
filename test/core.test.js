import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { createSession, loadSession } from '../src/core/session.js';
import { loadConfig } from '../src/core/config.js';
import { createLedger, priceFor, costOf } from '../src/core/usage.js';
import { loadImageAttachment, loadFileAttachment, buildUserMessage, detectImageMime, stdinFence } from '../src/core/attachments.js';
import { resolveInside } from '../src/agent/paths.js';
import { runCommand } from '../src/agent/shell.js';
import { sanitizeTerminal } from '../src/ui/sanitize.js';
import { normalizeUsage } from '../src/openai/stream.js';
import { TINY_PNG } from './helpers/mock-server.js';

test('session: replayable items for stateless history', () => {
    const session = createSession({ store: false, model: 'm' });
    session.addUserMessage(buildUserMessage({ text: 'hi' }));
    session.recordResponse({ id: 'resp_1', model: 'm', output: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
        { type: 'reasoning', id: 'rs_2', summary: [] },
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q' } },
        { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: 'AAAA' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{}' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [{ type: 'url_citation' }] }] },
    ] }, { imagePaths: new Map([['ig_1', '/tmp/a.png']]) });
    const types = session.items.map((i) => i.type);
    assert.deepEqual(types, ['message', 'reasoning', 'message', 'message', 'function_call', 'message']);
    assert.equal(session.items[1].encrypted_content, 'enc');
    assert.match(session.items[2].content[0].text, /web_search: q/);
    assert.match(session.items[3].content[0].text, /\/tmp\/a\.png/);
    assert.deepEqual(session.items[5].content[0].annotations, []);
    assert.equal(session.lastResponseId, 'resp_1');
    assert.deepEqual(session.requestInput(), { input: session.items });
});

test('session: save and load round trip', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-session-'));
    try {
        const session = createSession({ store: false, model: 'm', name: 'work' });
        session.addUserMessage(buildUserMessage({ text: 'hello' }));
        session.recordUsage({ usage: { input: 10, cached: 0, output: 5, reasoning: 0, total: 15 }, costUsd: 0.01 });
        const file = path.join(dir, 'work.json');
        await session.save(file);
        const loaded = await loadSession(file, { store: false, model: 'm' });
        assert.equal(loaded.name, 'work');
        assert.equal(loaded.size, 1);
        assert.equal(loaded.usage.total, 15);
        assert.match(loaded.transcript(), /Вы: hello/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger: price matching, cost and budgets', () => {
    const prices = { 'gpt-6.1-sol': { input: 1.25, cachedInput: 0.125, output: 10 }, 'gpt-6*': { input: 2, output: 20 } };
    assert.equal(priceFor(prices, 'gpt-6.1-sol').input, 1.25);
    assert.equal(priceFor(prices, 'gpt-6-luna').input, 2);
    assert.equal(priceFor(prices, 'o3'), null);
    const usage = normalizeUsage({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 200_000 }, output_tokens: 100_000, output_tokens_details: { reasoning_tokens: 50_000 }, total_tokens: 1_100_000 });
    assert.equal(costOf(prices['gpt-6.1-sol'], usage), 800_000 * 1.25 / 1e6 + 200_000 * 0.125 / 1e6 + 100_000 * 10 / 1e6);
    const ledger = createLedger({ prices, budgetUsd: 1.5 });
    ledger.record({ model: 'gpt-6.1-sol', usage: { input_tokens: 400_000, output_tokens: 50_000 } }); // $1.00
    assert.ok(ledger.snapshot().costKnown);
    assert.equal(ledger.snapshot().costUsd, 1);
    assert.doesNotThrow(() => ledger.assertBudget({ estimatedTokens: 1000, model: 'gpt-6.1-sol' }));
    ledger.record({ model: 'gpt-6.1-sol', usage: { input_tokens: 400_000, output_tokens: 50_000 } }); // $2.00 > $1.50
    assert.throws(() => ledger.assertBudget({ model: 'gpt-6.1-sol' }), /бюджет/);
    const unknown = createLedger({ prices: {}, budgetUsd: 1 });
    unknown.record({ model: 'o3', usage: { input_tokens: 1, output_tokens: 1 } });
    assert.throws(() => unknown.assertBudget({ model: 'o3' }), /цены/);
    assert.equal(normalizeUsage({ input_tokens: 'x' }), null);
});

test('attachments: images become data URLs, PDFs input_file, text input_text', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-att-'));
    try {
        await writeFile(path.join(dir, 'pic.png'), Buffer.from(TINY_PNG, 'base64'));
        await writeFile(path.join(dir, 'doc.pdf'), '%PDF-1.4 fake');
        await writeFile(path.join(dir, 'notes.md'), '# hello');
        await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
        const image = await loadImageAttachment('pic.png', { cwd: dir, detail: 'low' });
        assert.equal(image.part.type, 'input_image');
        assert.match(image.part.image_url, /^data:image\/png;base64,/);
        assert.equal(image.part.detail, 'low');
        const url = await loadImageAttachment('https://example.com/a.jpg', { cwd: dir });
        assert.equal(url.part.image_url, 'https://example.com/a.jpg');
        const pdf = await loadFileAttachment('doc.pdf', { cwd: dir });
        assert.equal(pdf.part.type, 'input_file');
        assert.equal(pdf.part.filename, 'doc.pdf');
        assert.match(pdf.part.file_data, /^data:application\/pdf;base64,/);
        const text = await loadFileAttachment('notes.md', { cwd: dir });
        assert.equal(text.part.type, 'input_text');
        assert.match(text.part.text, /# hello/);
        assert.match(text.part.text, /--- File: notes\.md /);
        assert.match(text.part.text, /--- End of file: notes\.md ---/);
        await assert.rejects(loadFileAttachment('blob.bin', { cwd: dir }), /Бинарный/);
        await assert.rejects(loadImageAttachment('missing.png', { cwd: dir }), /не найдено/);
        assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
        const message = buildUserMessage({ text: 'look', parts: [image.part] });
        assert.equal(message.role, 'user');
        assert.deepEqual(message.content.map((c) => c.type), ['input_text', 'input_image']);
        assert.throws(() => buildUserMessage({ text: '   ' }), /пустое/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stdin fence is English', () => {
    assert.equal(stdinFence('hello'), '--- stdin ---\nhello\n--- end stdin ---');
});

test('paths: confinement, protected names, symlink escape', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-paths-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-outside-'));
    try {
        const ok = await resolveInside(dir, 'src/a.js');
        assert.equal(ok.rel, 'src/a.js');
        assert.equal((await resolveInside(dir, '.')).rel, '.');
        await assert.rejects(resolveInside(dir, '../x'), /вне рабочего/);
        await assert.rejects(resolveInside(dir, path.join(outside, 'x')), /вне рабочего/);
        await assert.rejects(resolveInside(dir, '.env.local'), /секрет/);
        await assert.rejects(resolveInside(dir, 'certs/server.pem'), /секрет/);
        await assert.rejects(resolveInside(dir, '.ssh/id_rsa'), /запрещён/);
        await assert.rejects(resolveInside(dir, '.git/config', { forWrite: true }), /запрещена/);
        await resolveInside(dir, 'node_modules/pkg/index.js'); // reading is fine
        await mkdir(path.join(dir, 'sub'));
        let linked = true;
        try { await symlink(outside, path.join(dir, 'sub', 'link'), 'junction'); } catch { linked = false; }
        if (linked) await assert.rejects(resolveInside(dir, 'sub/link/file.txt'), /символическую/);
    } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('shell: captures output, exit codes and timeouts', async () => {
    const echo = await runCommand({ command: process.platform === 'win32' ? 'echo hello & exit /b 3' : 'echo hello; exit 3', cwd: process.cwd(), timeoutMs: 10_000 });
    assert.match(echo.stdout, /hello/);
    assert.equal(echo.exitCode, 3);
    const slow = await runCommand({ command: `"${process.execPath}" -e "setTimeout(()=>{}, 20000)"`, cwd: process.cwd(), timeoutMs: 300 });
    assert.equal(slow.timedOut, true);
    assert.ok(slow.durationMs < 10_000);
});

test('sanitizeTerminal strips control sequences but keeps newlines', () => {
    assert.equal(sanitizeTerminal('a\x1b[31mred\x1b[0m\nb\u202etext\x07'), 'ared\nbtext');
});

test('a retired scanner role in config is dropped', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-scanner-cfg-'));
    try {
        await writeFile(path.join(home, 'config.json'), JSON.stringify({ roles: { scanner: { effort: 'low' }, solver: { effort: 'high' } } }));
        const config = await loadConfig({ env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model' }, ensureHome: false });
        assert.equal(Object.hasOwn(config.roles, 'scanner'), false);
        assert.equal(config.roles.solver.effort, 'high');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('agent.encode accepts encoder or mcp and rejects anything else', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-encode-cfg-'));
    const env = { AI_AGENT_HOME: home };
    try {
        const config = await loadConfig({ env, ensureHome: false });
        assert.equal(config.agent.encode, 'encoder');
        await writeFile(path.join(home, 'config.json'), JSON.stringify({ agent: { encode: 'mcp' } }));
        const mcp = await loadConfig({ env, ensureHome: false });
        assert.equal(mcp.agent.encode, 'mcp');
        await writeFile(path.join(home, 'config.json'), JSON.stringify({ agent: { encode: 'nope' } }));
        await assert.rejects(
            loadConfig({ env, ensureHome: false }),
            /agent\.encode: encoder \| mcp/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
